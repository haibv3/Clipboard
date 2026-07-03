/*
 * monitor.js — event-driven clipboard monitor.
 *
 * Connects to `Meta.Selection` `owner-changed` and, on clipboard-type changes,
 * reads the current content (text now, images in Phase 5) and forwards it to
 * the `onCapture` callback as a HistoryItem. No polling → ~0% idle CPU.
 *
 * Self-trigger guard: when the extension itself sets the clipboard (paste),
 * `setIgnoreNext()` is called so the re-copy of a selected item does not
 * create a duplicate history entry.
 */

import Meta from 'gi://Meta';
import St from 'gi://St';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;

export class ClipboardMonitor {
    constructor({ settings, privacy, onCapture } = {}) {
        this._settings = settings;
        this._privacy = privacy ?? null;
        this._onCapture = onCapture ?? null;

        this._selection = global.display.get_selection();
        this._handlerId = 0;

        this._ignoreNext = 0;
        this._readSerial = 0; // serialize async reads, drop stale callbacks
    }

    /**
     * Tell the monitor to ignore the next owner-changed event (caused by the
     * extension itself putting an item back on the clipboard). Can be called
     * multiple times to ignore several events (e.g. set_content for images
     * may fire owner-changed more than once).
     */
    setIgnoreNext() {
        this._ignoreNext = (this._ignoreNext || 0) + 1;
    }

    start() {
        if (this._handlerId !== 0) return;
        this._handlerId = this._selection.connect(
            'owner-changed',
            (_sel, selectionType, _source) => this._onOwnerChanged(selectionType),
        );
    }

    _onOwnerChanged(selectionType) {
        log(`[Clipboard] owner-changed fired, type=${selectionType}`);
        if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD) {
            return;
        }
        if (this._ignoreNext > 0) {
            log(`[Clipboard] ignoring (self-triggered, remaining=${this._ignoreNext - 1})`);
            this._ignoreNext -= 1;
            return;
        }

        // Privacy filter (Phase 4): consult mimetypes before reading.
        if (this._privacy && this._privacy.shouldSkip(this._selection)) {
            log('[Clipboard] skipping sensitive clipboard content');
            return;
        }

        log('[Clipboard] reading clipboard...');
        this._readClipboard();
    }

    _readClipboard() {
        const serial = ++this._readSerial;
        const clip = St.Clipboard.get_default();

        let mimetypes = [];
        try {
            mimetypes = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
        } catch (e) {
            log(`[Clipboard] get_mimetypes in _readClipboard failed: ${e}`);
        }
        log(`[Clipboard] mimetypes: [${mimetypes.join(', ')}]`);

        const hasPng = mimetypes.some(
            (mt) => (mt ?? '').toLowerCase() === 'image/png',
        );
        const hasUriList = mimetypes.some(
            (mt) => (mt ?? '').toLowerCase() === 'text/uri-list',
        );
        const hasText = mimetypes.some((mt) => {
            const l = (mt ?? '').toLowerCase();
            return l === 'text/plain' || l === 'text/plain;charset=utf-8';
        });

        // --- Image path detection (text/uri-list or text/plain with path) ---
        if (hasUriList) {
            log('[Clipboard] text/uri-list offered → trying image file load');
            this._maybeReadImageFile(serial, clip);
            return;
        }

        // --- Both image/png AND text offered → capture BOTH as separate items ---
        if (hasPng && hasText) {
            log('[Clipboard] both image/png and text/plain offered → capturing both');
            // Read text first (async), then image. Both forwarded separately.
            clip.get_text(CLIPBOARD, (_c, text) => {
                if (serial !== this._readSerial) return;
                if (text && text.length > 0 && !this._isImagePath(text)) {
                    log(`[Clipboard] capturing text alongside image: "${text.substring(0, 40)}"`);
                    this._forward({ type: 'text', text });
                }
                // Now read the image.
                this._maybeReadImage(serial, clip);
            });
            return;
        }

        // --- Only image/png offered → image capture ---
        if (hasPng) {
            log('[Clipboard] image/png only → direct image capture');
            this._maybeReadImage(serial, clip);
            return;
        }

        // --- Default: try text first, fall back to image ---
        clip.get_text(CLIPBOARD, (_c, text) => {
            if (serial !== this._readSerial) return;

            log(`[Clipboard] get_text returned: "${text?.substring(0, 40) ?? 'null'}" (len=${text?.length ?? 0})`);
            if (text && text.length > 0) {
                // GNOME Screenshot on some configs copies ONLY text/plain
                // containing the file path (no image/png, no text/uri-list).
                if (this._isImagePath(text)) {
                    log(`[Clipboard] text is an image file path → loading image`);
                    this._loadImageFromPath(serial, text);
                    return;
                }
                this._forward({ type: 'text', text });
                return;
            }

            // No text — try image/png as a last resort.
            this._maybeReadImage(serial, clip);
        });
    }

    /**
     * Check if a text string looks like a path to an image file.
     * Handles both plain paths ("/home/user/Pictures/Screenshot.png")
     * and file:// URIs.
     */
    _isImagePath(text) {
        const trimmed = text.trim();
        if (!trimmed) return false;
        // Single line only (real text with newlines is not a path).
        if (trimmed.includes('\n')) return false;
        // Extract path from file:// URI if present.
        let path = trimmed;
        if (path.startsWith('file://')) {
            path = path.replace('file://', '');
        }
        // Must be an absolute path.
        if (!path.startsWith('/')) return false;
        const lower = path.toLowerCase();
        return lower.endsWith('.png') || lower.endsWith('.jpg') ||
            lower.endsWith('.jpeg') || lower.endsWith('.bmp') ||
            lower.endsWith('.webp');
    }

    /**
     * Load an image from a file path and forward it as an image item.
     * File I/O is deferred to an idle callback to avoid blocking.
     */
    _loadImageFromPath(serial, text) {
        let path = text.trim();
        if (path.startsWith('file://')) {
            path = path.replace('file://', '');
        }
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (serial !== this._readSerial) return GLib.SOURCE_REMOVE;
            try {
                const file = Gio.File.new_for_path(path);
                const [success, bytes] = file.load_contents(null);
                if (!success || !bytes) {
                    log('[Clipboard] image path: failed to load file');
                    this._forward({ type: 'text', text });
                    return GLib.SOURCE_REMOVE;
                }

                const size = bytes.length ?? bytes.get_size?.() ?? 0;
                const maxBytes = this._settings?.get_int('max-image-bytes') ?? 5242880;
                if (size > maxBytes) {
                    log(`[Clipboard] image path: over cap (${size} > ${maxBytes})`);
                    this._forward({ type: 'text', text });
                    return GLib.SOURCE_REMOVE;
                }

                const glibBytes = bytes instanceof GLib.Bytes
                    ? bytes
                    : new GLib.Bytes(bytes);
                log(`[Clipboard] image path: loaded (${size} bytes)`);
                this._buildImageItem(glibBytes);
            } catch (e) {
                log(`[Clipboard] image path: load error: ${e}`);
                this._forward({ type: 'text', text });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _maybeReadImage(serial, clip) {
        // Only attempt image capture if image/png is offered.
        let mimetypes = [];
        try {
            mimetypes = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
        } catch (e) {
            log(`[Clipboard] _maybeReadImage get_mimetypes failed: ${e}`);
            return;
        }
        const hasPng = mimetypes.some((mt) => (mt ?? '').toLowerCase() === 'image/png');
        if (!hasPng) {
            log('[Clipboard] no image/png offered, skipping image capture');
            return;
        }

        const maxBytes = this._settings?.get_int('max-image-bytes') ?? 5242880;
        log(`[Clipboard] requesting image/png content (cap=${maxBytes} bytes)`);

        clip.get_content(CLIPBOARD, 'image/png', (_c, bytes) => {
            if (serial !== this._readSerial) return; // stale
            if (!bytes) {
                log('[Clipboard] get_content returned null bytes');
                return;
            }

            const size = bytes.get_size();
            log(`[Clipboard] image bytes received: ${size} bytes`);
            if (size <= 0) return;
            if (size > maxBytes) {
                log(`[Clipboard] skipping image over cap (${size} > ${maxBytes} bytes)`);
                return;
            }

            // Defensive copy: the GLib.Bytes returned by get_content is backed
            // by memory owned by mutter's MetaSelectionSourceMemory, which is
            // freed as soon as the clipboard changes again. If we stored that
            // wrapper directly, re-activating the item later (set_content)
            // would touch freed memory → "double free or corruption" and a
            // gnome-shell crash (which takes down the whole Wayland session).
            // Copy the data into a fresh GLib.Bytes we own, with its own
            // refcount and owned buffer, so the item stays valid indefinitely.
            const ownedBytes = new GLib.Bytes(bytes.get_data());
            this._buildImageItem(ownedBytes);
        });
    }

    _buildImageItem(bytes) {
        // Defer heavy pixbuf decoding to an idle callback so we don't block
        // the current main-loop iteration (which could be processing the
        // owner-changed event chain). This prevents the shell from freezing
        // on large screenshots.
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            try {
                const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
                const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
                const width = pixbuf.get_width();
                const height = pixbuf.get_height();
                log(`[Clipboard] image decoded: ${width}×${height}`);

                // Safety cap: skip extremely large images that could OOM.
                const MAX_DIM = 8000;
                if (width > MAX_DIM || height > MAX_DIM) {
                    log(`[Clipboard] skipping oversized image (${width}×${height} > ${MAX_DIM})`);
                    return GLib.SOURCE_REMOVE;
                }

                // Downscaled thumbnail (max 48px on the longest edge).
                // Use NEAREST for speed — this is just a tiny preview icon.
                const maxThumb = 48;
                let tw = width;
                let th = height;
                if (width > height) {
                    tw = maxThumb;
                    th = Math.max(1, Math.round((height / width) * maxThumb));
                } else {
                    th = maxThumb;
                    tw = Math.max(1, Math.round((width / height) * maxThumb));
                }
                const thumb = pixbuf.scale_simple(tw, th, GdkPixbuf.InterpType.NEAREST);

                const [, thumbBytes] = thumb.save_to_bufferv('png', [], []);
                const thumbGlibBytes = new GLib.Bytes(thumbBytes);

                this._forward({
                    type: 'image',
                    bytes,
                    thumbBytes: thumbGlibBytes,
                    width,
                    height,
                });
            } catch (e) {
                log(`[Clipboard] image capture/thumbnail error: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Handle text/uri-list clipboard content (e.g. GNOME Screenshot saving
     * to a file and copying the file URI). Reads the URI, loads the file
     * if it's an image, and forwards it as an image item.
     */
    _maybeReadImageFile(serial, clip) {
        clip.get_text(CLIPBOARD, (_c, text) => {
            if (serial !== this._readSerial) return;
            if (!text) {
                log('[Clipboard] uri-list: no text returned');
                return;
            }

            // text/uri-list format: "file:///path/to/file.png\n"
            const uri = text.trim().split('\n')[0].trim();
            log(`[Clipboard] uri-list: uri="${uri}"`);

            // Only handle file:// URIs pointing to image files.
            if (!uri.startsWith('file://')) {
                log('[Clipboard] uri-list: not a file URI, storing as text');
                this._forward({ type: 'text', text });
                return;
            }

            const path = uri.replace('file://', '');
            const lower = path.toLowerCase();
            const isImage = lower.endsWith('.png') || lower.endsWith('.jpg') ||
                lower.endsWith('.jpeg') || lower.endsWith('.bmp') ||
                lower.endsWith('.webp');

            if (!isImage) {
                log(`[Clipboard] uri-list: not an image file (${path}), storing as text`);
                this._forward({ type: 'text', text });
                return;
            }

            try {
                const file = Gio.File.new_for_path(path);
                const [success, bytes] = file.load_contents(null);
                if (!success || !bytes) {
                    log('[Clipboard] uri-list: failed to load file contents');
                    return;
                }

                const size = bytes.length ?? bytes.get_size?.() ?? 0;
                const maxBytes = this._settings?.get_int('max-image-bytes') ?? 5242880;
                if (size > maxBytes) {
                    log(`[Clipboard] uri-list: image over cap (${size} > ${maxBytes})`);
                    return;
                }

                // Convert to GLib.Bytes for consistent handling.
                const glibBytes = bytes instanceof GLib.Bytes
                    ? bytes
                    : new GLib.Bytes(bytes);
                log(`[Clipboard] uri-list: loaded image file (${size} bytes)`);
                this._buildImageItem(glibBytes);
            } catch (e) {
                log(`[Clipboard] uri-list: error loading image file: ${e}`);
            }
        });
    }

    _forward(item) {
        log(`[Clipboard] forwarding item: type=${item.type}, text="${item.text?.substring(0, 40) ?? ''}"`);
        try {
            this._onCapture?.(item);
        } catch (e) {
            log(`[Clipboard] onCapture error: ${e}`);
        }
    }

    destroy() {
        if (this._handlerId !== 0) {
            this._selection.disconnect(this._handlerId);
            this._handlerId = 0;
        }
        this._onCapture = null;
        this._privacy = null;
    }
}
