/*
 * monitor.js — event-driven clipboard monitor.
 *
 * Connects to Meta.Selection owner-changed and reads clipboard content
 * (text + images). No polling → ~0% idle CPU.
 *
 * Self-trigger guard: setIgnoreNext() skips captures caused by our own
 * set_text/set_content when pasting from the picker.
 */

import Meta from 'gi://Meta';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { debug, error } from './log.js';
import { buildImageItemFromBytes } from './image-util.js';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;

const IMAGE_MIME_PRIORITY = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/bmp',
];

export class ClipboardMonitor {
    constructor({ settings, privacy, onCapture } = {}) {
        this._settings = settings;
        this._privacy = privacy ?? null;
        this._onCapture = onCapture ?? null;

        this._selection = global.display.get_selection();
        this._handlerId = 0;

        this._ignoreNext = 0;
        this._readSerial = 0;
    }

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
        debug(`owner-changed fired, type=${selectionType}`);
        if (selectionType !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;

        if (this._ignoreNext > 0) {
            debug(`ignoring (self-triggered, remaining=${this._ignoreNext - 1})`);
            this._ignoreNext -= 1;
            return;
        }

        if (this._settings?.get_boolean('capture-paused')) {
            debug('capture paused, skipping');
            return;
        }

        if (this._privacy && this._privacy.shouldSkip(this._selection)) {
            debug('skipping sensitive clipboard content');
            return;
        }

        if (this._privacy?.shouldSkipApp?.(this._focusWmClass())) {
            debug('skipping capture: app denylist');
            return;
        }

        debug('reading clipboard...');
        this._readClipboard();
    }

    _focusWmClass() {
        try {
            const win = global.display?.get_focus_window?.();
            return win?.get_wm_class?.() ?? '';
        } catch (_e) {
            return '';
        }
    }

    _getMimetypes() {
        try {
            return this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD) ?? [];
        } catch (e) {
            error(`get_mimetypes failed: ${e}`);
            return [];
        }
    }

    _pickImageMime(mimetypes) {
        const lower = mimetypes.map((m) => (m ?? '').toLowerCase());
        return IMAGE_MIME_PRIORITY.find((m) => lower.includes(m)) ?? null;
    }

    _readClipboard() {
        const serial = ++this._readSerial;
        const clip = St.Clipboard.get_default();
        const mimetypes = this._getMimetypes();
        debug(`mimetypes: [${mimetypes.join(', ')}]`);

        const imageMime = this._pickImageMime(mimetypes);
        const hasUriList = mimetypes.some(
            (mt) => (mt ?? '').toLowerCase() === 'text/uri-list',
        );
        const hasText = mimetypes.some((mt) => {
            const l = (mt ?? '').toLowerCase();
            return l === 'text/plain' || l === 'text/plain;charset=utf-8';
        });

        if (hasUriList) {
            debug('text/uri-list offered → trying image file load');
            this._maybeReadImageFile(serial, clip);
            return;
        }

        if (imageMime && hasText) {
            debug(`both ${imageMime} and text/plain offered → capturing both`);
            clip.get_text(CLIPBOARD, (_c, text) => {
                if (serial !== this._readSerial) return;
                if (text && text.length > 0 && !this._isImagePath(text)) {
                    if (!this._privacy?.shouldSkipText?.(text)) {
                        debug(`capturing text alongside image: "${text.substring(0, 40)}"`);
                        this._forward({ type: 'text', text });
                    } else {
                        debug('text denylist matched (alongside image)');
                    }
                }
                this._maybeReadImage(serial, clip, imageMime);
            });
            return;
        }

        if (imageMime) {
            debug(`${imageMime} only → image capture`);
            this._maybeReadImage(serial, clip, imageMime);
            return;
        }

        clip.get_text(CLIPBOARD, (_c, text) => {
            if (serial !== this._readSerial) return;

            debug(`get_text returned: "${text?.substring(0, 40) ?? 'null'}" (len=${text?.length ?? 0})`);
            if (text && text.length > 0) {
                if (this._isImagePath(text)) {
                    debug('text is an image file path → loading image');
                    this._loadImageFromPath(serial, text);
                    return;
                }
                if (this._privacy?.shouldSkipText?.(text)) {
                    debug('text denylist matched, skipping');
                    return;
                }
                this._forward({ type: 'text', text });
                return;
            }

            // Last resort: any image mime.
            const mime = this._pickImageMime(this._getMimetypes());
            if (mime)
                this._maybeReadImage(serial, clip, mime);
        });
    }

    _isImagePath(text) {
        const trimmed = text.trim();
        if (!trimmed) return false;
        if (trimmed.includes('\n')) return false;
        let path = trimmed;
        if (path.startsWith('file://'))
            path = path.replace('file://', '');
        if (!path.startsWith('/')) return false;
        const lower = path.toLowerCase();
        return lower.endsWith('.png') || lower.endsWith('.jpg') ||
            lower.endsWith('.jpeg') || lower.endsWith('.bmp') ||
            lower.endsWith('.webp');
    }

    _loadImageFromPath(serial, text) {
        let path = text.trim();
        if (path.startsWith('file://'))
            path = path.replace('file://', '');
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (serial !== this._readSerial) return GLib.SOURCE_REMOVE;
            try {
                const file = Gio.File.new_for_path(path);
                const [success, bytes] = file.load_contents(null);
                if (!success || !bytes) {
                    error('image path: failed to load file');
                    if (!this._privacy?.shouldSkipText?.(text))
                        this._forward({ type: 'text', text });
                    return GLib.SOURCE_REMOVE;
                }

                const size = bytes.length ?? bytes.get_size?.() ?? 0;
                const maxBytes = this._settings?.get_int('max-image-bytes') ?? 5242880;
                if (size > maxBytes) {
                    debug(`image path: over cap (${size} > ${maxBytes})`);
                    if (!this._privacy?.shouldSkipText?.(text))
                        this._forward({ type: 'text', text });
                    return GLib.SOURCE_REMOVE;
                }

                const glibBytes = bytes instanceof GLib.Bytes
                    ? new GLib.Bytes(bytes.get_data())
                    : new GLib.Bytes(bytes);
                debug(`image path: loaded (${size} bytes)`);
                this._buildImageItem(glibBytes);
            } catch (e) {
                error(`image path: load error: ${e}`);
                if (!this._privacy?.shouldSkipText?.(text))
                    this._forward({ type: 'text', text });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _maybeReadImage(serial, clip, mimeHint = null) {
        const mimetypes = this._getMimetypes();
        const mime = mimeHint ?? this._pickImageMime(mimetypes);
        if (!mime) {
            debug('no image mime offered, skipping image capture');
            return;
        }

        const maxBytes = this._settings?.get_int('max-image-bytes') ?? 5242880;
        debug(`requesting ${mime} content (cap=${maxBytes} bytes)`);

        clip.get_content(CLIPBOARD, mime, (_c, bytes) => {
            if (serial !== this._readSerial) return;
            if (!bytes) {
                debug('get_content returned null bytes');
                return;
            }

            const size = bytes.get_size();
            debug(`image bytes received: ${size} bytes`);
            if (size <= 0) return;
            if (size > maxBytes) {
                debug(`skipping image over cap (${size} > ${maxBytes} bytes)`);
                return;
            }

            // Own the buffer so mutter can free the selection source.
            const ownedBytes = new GLib.Bytes(bytes.get_data());
            this._buildImageItem(ownedBytes);
        });
    }

    _buildImageItem(bytes) {
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            try {
                const item = buildImageItemFromBytes(bytes);
                if (!item) return GLib.SOURCE_REMOVE;
                debug(`image decoded: ${item.width}×${item.height}`);
                this._forward({
                    type: 'image',
                    bytes: item.bytes,
                    thumbBytes: item.thumbBytes,
                    width: item.width,
                    height: item.height,
                });
            } catch (e) {
                error(`image capture/thumbnail error: ${e}`);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _maybeReadImageFile(serial, clip) {
        clip.get_text(CLIPBOARD, (_c, text) => {
            if (serial !== this._readSerial) return;
            if (!text) {
                debug('uri-list: no text returned');
                return;
            }

            const uri = text.trim().split('\n')[0].trim();
            debug(`uri-list: uri="${uri}"`);

            if (!uri.startsWith('file://')) {
                debug('uri-list: not a file URI, storing as text');
                if (!this._privacy?.shouldSkipText?.(text))
                    this._forward({ type: 'text', text });
                return;
            }

            const path = uri.replace('file://', '');
            const lower = path.toLowerCase();
            const isImage = lower.endsWith('.png') || lower.endsWith('.jpg') ||
                lower.endsWith('.jpeg') || lower.endsWith('.bmp') ||
                lower.endsWith('.webp');

            if (!isImage) {
                debug(`uri-list: not an image file (${path}), storing as text`);
                if (!this._privacy?.shouldSkipText?.(text))
                    this._forward({ type: 'text', text });
                return;
            }

            try {
                const file = Gio.File.new_for_path(path);
                const [success, bytes] = file.load_contents(null);
                if (!success || !bytes) {
                    error('uri-list: failed to load file contents');
                    return;
                }

                const size = bytes.length ?? bytes.get_size?.() ?? 0;
                const maxBytes = this._settings?.get_int('max-image-bytes') ?? 5242880;
                if (size > maxBytes) {
                    debug(`uri-list: image over cap (${size} > ${maxBytes})`);
                    return;
                }

                const glibBytes = bytes instanceof GLib.Bytes
                    ? new GLib.Bytes(bytes.get_data())
                    : new GLib.Bytes(bytes);
                debug(`uri-list: loaded image file (${size} bytes)`);
                this._buildImageItem(glibBytes);
            } catch (e) {
                error(`uri-list: error loading image file: ${e}`);
            }
        });
    }

    _forward(item) {
        debug(`forwarding item: type=${item.type}, text="${item.text?.substring(0, 40) ?? ''}"`);
        try {
            this._onCapture?.(item);
        } catch (e) {
            error(`onCapture error: ${e}`);
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
