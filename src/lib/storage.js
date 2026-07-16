/*
 * storage.js — persistence for pinned clipboard items.
 *
 * Pins saved under ~/.local/share/clipboard-extension/:
 *   pins.json          — metadata
 *   pins/<id>.png      — image pin full bytes
 *
 * Writes are debounced + atomic. History is RAM-only and never written here.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { error, warn, debug } from './log.js';
import { buildImageItemFromBytes } from './image-util.js';

const SAVE_DEBOUNCE_MS = 400;

export class PinStorage {
    constructor({ settings } = {}) {
        this._settings = settings ?? null;
        this._dir = null;
        this._file = null;
        this._pinsDir = null;
        this._saveTimeoutId = 0;
        this._pendingPinned = null;
        this._initPaths();
    }

    _initPaths() {
        const dataDir = GLib.get_user_data_dir();
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([dataDir, 'clipboard-extension']),
        );
        this._file = this._dir.get_child('pins.json');
        this._pinsDir = this._dir.get_child('pins');
    }

    _ensureDir() {
        try {
            if (!this._dir.query_exists(null))
                this._dir.make_directory_with_parents(null);
            if (!this._pinsDir.query_exists(null))
                this._pinsDir.make_directory_with_parents(null);
            return true;
        } catch (e) {
            error(`failed to create pin dir: ${e}`);
            return false;
        }
    }

    /**
     * Load persisted pins. Returns hydrated items (image bytes loaded).
     */
    load() {
        try {
            if (!this._file.query_exists(null)) return [];
            const [ok, contents] = this._file.load_contents(null);
            if (!ok || !contents) return [];
            const text = new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) return [];

            const result = [];
            let dropped = false;
            for (const it of parsed) {
                if (!it || !it.type) {
                    dropped = true;
                    continue;
                }
                if (it.type === 'text') {
                    result.push({
                        id: it.id,
                        type: 'text',
                        text: it.text ?? null,
                        timestamp: it.timestamp ?? Date.now(),
                        pinned: true,
                        bytes: null,
                        thumbBytes: null,
                        width: 0,
                        height: 0,
                    });
                    continue;
                }
                if (it.type === 'image') {
                    const hydrated = this._loadImagePin(it);
                    if (hydrated)
                        result.push(hydrated);
                    else
                        dropped = true;
                    continue;
                }
                dropped = true;
            }

            // Dropped/corrupt entries: rewrite JSON + prune orphan pin files.
            if (dropped) {
                warn('pruning dropped pin entries after load');
                this.save(result);
            } else {
                this._pruneLoadedImageOrphans(result);
            }
            return result;
        } catch (e) {
            error(`pins.json parse failed, starting empty: ${e}`);
            this._backupCorrupt();
            return [];
        }
    }

    _pruneLoadedImageOrphans(pins) {
        try {
            this._ensureDir();
            const keep = new Set();
            for (const it of pins ?? []) {
                if (it?.type === 'image' && it.id)
                    keep.add(this._safeBasename(null, it.id).replace(/\.png$/, ''));
            }
            this._pruneOrphansByBasename(keep);
        } catch (e) {
            warn(`load-time orphan prune failed: ${e}`);
        }
    }

    _safeBasename(fileField, id) {
        // Only allow pins/<id>.png style under our pins dir — reject traversal.
        if (fileField && typeof fileField === 'string') {
            const base = fileField.replace(/^.*\//, '');
            if (base && !base.includes('..') && base.endsWith('.png'))
                return base;
        }
        const safeId = String(id ?? 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
        return `${safeId}.png`;
    }

    _loadImagePin(it) {
        try {
            const base = this._safeBasename(it.file, it.id);
            const file = this._pinsDir.get_child(base);
            if (!file.query_exists(null)) {
                warn(`image pin file missing, dropping: ${base}`);
                return null;
            }
            const [success, raw] = file.load_contents(null);
            if (!success || !raw) {
                warn(`image pin load failed: ${base}`);
                return null;
            }
            const glibBytes = raw instanceof GLib.Bytes
                ? raw
                : new GLib.Bytes(raw);
            // Own a copy so lifetime is independent of file buffer.
            const owned = new GLib.Bytes(glibBytes.get_data());
            const built = buildImageItemFromBytes(owned);
            if (!built) {
                warn(`image pin decode failed: ${base}`);
                return null;
            }
            return {
                id: it.id,
                type: 'image',
                text: null,
                timestamp: it.timestamp ?? Date.now(),
                pinned: true,
                bytes: built.bytes,
                thumbBytes: built.thumbBytes,
                width: it.width || built.width,
                height: it.height || built.height,
            };
        } catch (e) {
            error(`image pin load error: ${e}`);
            return null;
        }
    }

    _backupCorrupt() {
        try {
            if (this._file.query_exists(null)) {
                const backup = this._dir.get_child('pins.json.bak');
                this._file.copy(backup, Gio.FileCopyFlags.OVERWRITE, null, null);
            }
        } catch (e) {
            error(`corrupt backup failed: ${e}`);
        }
    }

    /**
     * Save pinned items (debounced + atomic).
     */
    save(pinned) {
        this._pendingPinned = pinned ?? [];
        if (this._saveTimeoutId !== 0)
            GLib.source_remove(this._saveTimeoutId);
        this._saveTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            SAVE_DEBOUNCE_MS,
            () => {
                this._saveTimeoutId = 0;
                this._flushSave();
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _writeImageFile(id, bytes) {
        const base = this._safeBasename(null, id);
        const file = this._pinsDir.get_child(base);
        const data = bytes.get_data();
        // get_data may return Uint8Array
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        file.replace_contents(
            u8,
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
        );
        try {
            file.set_attribute_uint32(
                Gio.FILE_ATTRIBUTE_UNIX_MODE,
                0o600,
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
        } catch (_e) {
            // non-fatal
        }
        return `pins/${base}`;
    }

    _flushSave() {
        if (this._pendingPinned === null) return;
        if (!this._ensureDir()) {
            this._pendingPinned = null;
            return;
        }

        const pinned = this._pendingPinned;
        const meta = [];

        for (const it of pinned) {
            if (!it) continue;
            if (it.type === 'text') {
                meta.push({
                    id: it.id,
                    type: 'text',
                    text: it.text ?? null,
                    timestamp: it.timestamp ?? Date.now(),
                    pinned: true,
                });
                continue;
            }
            if (it.type === 'image' && it.bytes) {
                try {
                    const fileRel = this._writeImageFile(it.id, it.bytes);
                    meta.push({
                        id: it.id,
                        type: 'image',
                        text: null,
                        timestamp: it.timestamp ?? Date.now(),
                        pinned: true,
                        width: it.width ?? 0,
                        height: it.height ?? 0,
                        file: fileRel,
                    });
                } catch (e) {
                    error(`write image pin failed for ${it.id}: ${e}`);
                }
            }
        }

        // Prune orphan image files not referenced by current pins.
        const pruneKeep = new Set();
        for (const m of meta) {
            if (m.type === 'image')
                pruneKeep.add(this._safeBasename(m.file, m.id).replace(/\.png$/, ''));
        }
        this._pruneOrphansByBasename(pruneKeep);

        const data = JSON.stringify(meta, null, 2);
        const bytes = new TextEncoder().encode(data);
        try {
            this._file.replace_contents(
                bytes,
                null,
                true,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
            );
            this._chmod0600(this._file);
        } catch (e) {
            error(`atomic pin save failed: ${e}`);
        }
        this._pendingPinned = null;
    }

    _pruneOrphansByBasename(keepBasenames) {
        try {
            if (!this._pinsDir.query_exists(null)) return;
            const enumerator = this._pinsDir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (!name.endsWith('.png')) continue;
                const base = name.slice(0, -4);
                if (!keepBasenames.has(base)) {
                    try {
                        this._pinsDir.get_child(name).delete(null);
                        debug(`pruned orphan pin file: ${name}`);
                    } catch (e) {
                        warn(`prune orphan failed ${name}: ${e}`);
                    }
                }
            }
            enumerator.close(null);
        } catch (e) {
            warn(`prune orphans error: ${e}`);
        }
    }

    _chmod0600(file) {
        try {
            file.set_attribute_uint32(
                Gio.FILE_ATTRIBUTE_UNIX_MODE,
                0o600,
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
        } catch (e) {
            error(`pins.json chmod 0600 failed: ${e}`);
        }
    }

    destroy() {
        if (this._saveTimeoutId !== 0) {
            GLib.source_remove(this._saveTimeoutId);
            this._saveTimeoutId = 0;
            this._flushSave();
        }
    }
}
