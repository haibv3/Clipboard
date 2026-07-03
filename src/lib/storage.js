/*
 * storage.js — persistence for pinned clipboard items.
 *
 * Pins are saved to `~/.local/share/clipboard-extension/pins.json` using an
 * atomic replace (`Gio.File.replace_contents`). Writes are debounced so rapid
 * pin toggles coalesce. History is RAM-only and is NEVER written here.
 *
 * Only text pins are persisted in v1 (image pin bytes are large and deferred).
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const SAVE_DEBOUNCE_MS = 400;

export class PinStorage {
    constructor() {
        this._dir = null;
        this._file = null;
        this._saveTimeoutId = 0;
        this._pendingPinned = null;
        this._initPaths();
    }

    _initPaths() {
        const dataDir = GLib.get_user_data_dir(); // ~/.local/share
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([dataDir, 'clipboard-extension']),
        );
        this._file = this._dir.get_child('pins.json');
    }

    _ensureDir() {
        try {
            if (!this._dir.query_exists(null)) {
                this._dir.make_directory_with_parents(null);
            }
            return true;
        } catch (e) {
            log(`[Clipboard] failed to create pin dir: ${e}`);
            return false;
        }
    }

    /**
     * Load persisted pins. Returns an array of pin item objects (text only),
     * or [] if the file is missing/corrupt.
     */
    load() {
        try {
            if (!this._file.query_exists(null)) return [];
            const [ok, contents] = this._file.load_contents(null);
            if (!ok || !contents) return [];
            const text = new TextDecoder().decode(contents);
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) return [];
            // Keep only text pins (image pins not persisted in v1).
            return parsed.filter((it) => it && it.type === 'text');
        } catch (e) {
            log(`[Clipboard] pins.json parse failed, starting empty: ${e}`);
            // Back up the corrupt file before resetting.
            this._backupCorrupt();
            return [];
        }
    }

    _backupCorrupt() {
        try {
            if (this._file.query_exists(null)) {
                const backup = this._dir.get_child('pins.json.bak');
                this._file.copy(backup, Gio.FileCopyFlags.OVERWRITE, null, null);
            }
        } catch (e) {
            log(`[Clipboard] corrupt backup failed: ${e}`);
        }
    }

    /**
     * Save pinned items (debounced + atomic). `pinned` is an array of item
     * objects from the store. Only serializable fields are written.
     */
    save(pinned) {
        this._pendingPinned = this._serialize(pinned);
        if (this._saveTimeoutId !== 0) {
            GLib.source_remove(this._saveTimeoutId);
        }
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

    _serialize(pinned) {
        // Strip non-serializable fields (bytes, listeners, etc.).
        return (pinned ?? []).map((it) => ({
            id: it.id,
            type: it.type,
            text: it.text ?? null,
            timestamp: it.timestamp ?? Date.now(),
            pinned: true,
        }));
    }

    _flushSave() {
        if (this._pendingPinned === null) return;
        if (!this._ensureDir()) {
            this._pendingPinned = null;
            return;
        }
        const data = JSON.stringify(this._pendingPinned, null, 2);
        // GJS 1.88 / GNOME 49: Gio.File.replace_contents expects a Uint8Array
        // (or string) for `contents`; passing a GLib.Bytes throws
        // "Expected type guint8 ... got type GObject_Struct" and silently
        // breaks pin persistence. Use the Uint8Array form directly.
        const bytes = new TextEncoder().encode(data);
        try {
            // Atomic replace; REPLACE_DESTINATION keeps the old file as
            // .~pins.json~ during the write.
            this._file.replace_contents(
                bytes,
                null,
                true,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
            );
            // Restrict to owner-only: pins may contain sensitive text the
            // user explicitly chose to persist across reboots. `~/.local/share`
            // is typically 0700, but defense-in-depth on the file itself.
            this._chmod0600();
        } catch (e) {
            log(`[Clipboard] atomic pin save failed: ${e}`);
        }
        this._pendingPinned = null;
    }

    _chmod0600() {
        try {
            // GJS 1.88: the generic set_attribute() is not introspectable;
            // use the typed setter set_attribute_uint32 instead.
            this._file.set_attribute_uint32(
                Gio.FILE_ATTRIBUTE_UNIX_MODE,
                0o600,
                Gio.FileQueryInfoFlags.NONE,
                null,
            );
        } catch (e) {
            // Non-fatal: the file is under a 0700 user dir in the common case.
            log(`[Clipboard] pins.json chmod 0600 failed: ${e}`);
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
