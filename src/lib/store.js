/*
 * store.js — in-memory clipboard history store.
 *
 * Phase 4: split into `_history` (RAM ring, capped at `history-size`,
 * non-pinned) and `_pinned` (unbounded, ordered, persisted via storage).
 * `getItems()` returns pinned first, then history. The cap applies only to
 * `_history`; pinned items are never evicted and exempt from the cap.
 *
 * History is RAM-only and NEVER written to disk; only pins are persisted.
 */

import GLib from 'gi://GLib';

let _idCounter = 0;

function makeId() {
    _idCounter += 1;
    return `${Date.now()}-${_idCounter}`;
}

/**
 * Compare two `GLib.Bytes` by content (size first, then bytes).
 * Returns false if either is null/empty. Used for image dedup so two
 * different images that happen to share a byte size are not treated as
 * duplicates.
 */
function _bytesEqual(a, b) {
    if (!a || !b) return false;
    const sa = a.get_size?.() ?? 0;
    const sb = b.get_size?.() ?? 0;
    if (sa === 0 || sb === 0 || sa !== sb) return false;
    // GLib.Bytes.equal is the cheap native path; fall back to a Uint8Array
    // comparison if the binding is unavailable in this GJS version.
    if (typeof a.equal === 'function') return a.equal(b);
    const da = a.get_data();
    const db = b.get_data();
    for (let i = 0; i < sa; i++) {
        if (da[i] !== db[i]) return false;
    }
    return true;
}

export class ClipboardStore {
    constructor({ settings } = {}) {
        this._settings = settings;
        this._history = []; // newest first, non-pinned, capped
        this._pinned = []; // ordered, unbounded, persisted
        this._listeners = new Set();
        this._pinListeners = new Set();
    }

    /** Current effective cap (non-pinned history items). */
    _cap() {
        return this._settings?.get_int('history-size') ?? 25;
    }

    /**
     * Add a captured item to history. Dedups if identical to the current
     * history head. Pinned items are never re-added by capture.
     * Returns the stored item, or null if deduped/skipped.
     */
    add(item) {
        log(`[Clipboard] store.add called: type=${item.type}, text="${item.text?.substring(0, 40) ?? ''}"`);
        const normalized = {
            id: makeId(),
            type: item.type ?? 'text',
            text: item.text ?? null,
            bytes: item.bytes ?? null, // GLib.Bytes for images (Phase 5)
            thumbBytes: item.thumbBytes ?? null,
            width: item.width ?? 0,
            height: item.height ?? 0,
            timestamp: item.timestamp ?? Date.now(),
            pinned: false,
        };

        if (this._isDuplicate(normalized)) {
            return null;
        }

        this._history.unshift(normalized);
        this._trimHistory();
        this._emitChanged();
        return normalized;
    }

    _isDuplicate(item) {
        const head = this._history[0];
        if (!head) return false;
        if (item.type !== head.type) return false;
        if (item.type === 'text') {
            return item.text === head.text;
        }
        if (item.type === 'image' && head.type === 'image') {
            return _bytesEqual(item.bytes, head.bytes);
        }
        return false;
    }

    _trimHistory() {
        const cap = this._cap();
        while (this._history.length > cap) {
            this._history.pop();
        }
    }

    /** Remove an item from either list by id. */
    remove(id) {
        if (this._removeFrom(this._history, id)) {
            this._emitChanged();
            return true;
        }
        if (this._removeFrom(this._pinned, id)) {
            this._emitChanged();
            this._emitPinsChanged();
            return true;
        }
        return false;
    }

    _removeFrom(list, id) {
        const idx = list.findIndex((it) => it.id === id);
        if (idx === -1) return false;
        list.splice(idx, 1);
        return true;
    }

    /**
     * Clear history only. Pinned items survive (they are persisted and
     * exempt from the cap). Matches "Clear-all empties history".
     */
    clear() {
        if (this._history.length === 0) return;
        this._history = [];
        this._emitChanged();
    }

    /** Pinned first, then history (newest first). */
    getItems() {
        return this._pinned.slice().concat(this._history.slice());
    }

    getItem(id) {
        return (
            this._history.find((it) => it.id === id) ??
            this._pinned.find((it) => it.id === id) ??
            null
        );
    }

    size() {
        return this._pinned.length + this._history.length;
    }

    // --- Pin support (Phase 4) ---

    /**
     * Toggle pin state of an item by id.
     * - Pin: move from history to _pinned (so it doesn't double-count).
     * - Unpin: move from _pinned back to history head (subject to cap).
     * Returns the new pinned state, or null if the item was not found.
     */
    togglePin(id) {
        const histIdx = this._history.findIndex((it) => it.id === id);
        if (histIdx !== -1) {
            const [item] = this._history.splice(histIdx, 1);
            item.pinned = true;
            this._pinned.unshift(item);
            this._trimHistory();
            this._emitChanged();
            this._emitPinsChanged();
            return true;
        }

        const pinIdx = this._pinned.findIndex((it) => it.id === id);
        if (pinIdx !== -1) {
            const [item] = this._pinned.splice(pinIdx, 1);
            item.pinned = false;
            this._history.unshift(item);
            this._trimHistory();
            this._emitChanged();
            this._emitPinsChanged();
            return false;
        }
        return null;
    }

    getPinned() {
        return this._pinned.slice();
    }

    /**
     * Load persisted pins on init. Items keep their stored ids so toggling
     * works across restarts. Tolerates missing/empty input.
     */
    loadPinned(pins) {
        if (!Array.isArray(pins)) return;
        this._pinned = pins
            .filter((it) => it && it.type === 'text')
            .map((it) => ({
                id: it.id ?? makeId(),
                type: 'text',
                text: it.text ?? null,
                bytes: null,
                thumbBytes: null,
                width: 0,
                height: 0,
                timestamp: it.timestamp ?? Date.now(),
                pinned: true,
            }));
    }

    // --- Change notification ---

    connectChanged(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    /** Fired when the set of pinned items changes (so storage can persist). */
    connectPinsChanged(cb) {
        this._pinListeners.add(cb);
        return () => this._pinListeners.delete(cb);
    }

    _emitChanged() {
        for (const cb of this._listeners) {
            try {
                cb();
            } catch (e) {
                log(`[Clipboard] store listener error: ${e}`);
            }
        }
    }

    _emitPinsChanged() {
        for (const cb of this._pinListeners) {
            try {
                cb(this._pinned.slice());
            } catch (e) {
                log(`[Clipboard] pin listener error: ${e}`);
            }
        }
    }

    destroy() {
        this._listeners.clear();
        this._pinListeners.clear();
        this._history = [];
        this._pinned = [];
    }
}
