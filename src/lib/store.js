/*
 * store.js — in-memory clipboard history store.
 *
 * Split into `_history` (RAM ring, capped at `history-size`, non-pinned) and
 * `_pinned` (ordered, persisted via storage). Cap applies only to `_history`.
 *
 * Content-based dedup: re-copying an existing text/image promotes that item
 * to the head of its list instead of creating a duplicate row.
 *
 * History is RAM-only and NEVER written to disk; pins are persisted.
 */

import GLib from 'gi://GLib';
import { debug, error, warn } from './log.js';

let _idCounter = 0;

function makeId() {
    _idCounter += 1;
    return `${Date.now()}-${_idCounter}`;
}

/**
 * Compare two `GLib.Bytes` by content (size first, then bytes).
 */
function _bytesEqual(a, b) {
    if (!a || !b) return false;
    const sa = a.get_size?.() ?? 0;
    const sb = b.get_size?.() ?? 0;
    if (sa === 0 || sb === 0 || sa !== sb) return false;
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
        this._pinned = []; // ordered, unbounded (image pin soft-cap separate)
        this._listeners = new Set();
        this._pinListeners = new Set();
    }

    /** Current effective cap (non-pinned history items). */
    _cap() {
        return this._settings?.get_int('history-size') ?? 25;
    }

    _maxPinnedImages() {
        return this._settings?.get_int('max-pinned-images') ?? 20;
    }

    _sameContent(a, b) {
        if (!a || !b || a.type !== b.type) return false;
        if (a.type === 'text') return a.text === b.text;
        if (a.type === 'image') return _bytesEqual(a.bytes, b.bytes);
        return false;
    }

    _findIndexByContent(list, item) {
        return list.findIndex((it) => this._sameContent(it, item));
    }

    /**
     * Add a captured item to history. Dedups by content across history and
     * pinned lists (promote-to-top). Returns the stored item, or null if skipped.
     */
    add(item) {
        debug(`store.add called: type=${item.type}, text="${item.text?.substring(0, 40) ?? ''}"`);
        const normalized = {
            id: makeId(),
            type: item.type ?? 'text',
            text: item.text ?? null,
            bytes: item.bytes ?? null,
            thumbBytes: item.thumbBytes ?? null,
            width: item.width ?? 0,
            height: item.height ?? 0,
            timestamp: item.timestamp ?? Date.now(),
            pinned: false,
        };

        // 1) Match in pinned → promote within pinned, do not add to history.
        const pinIdx = this._findIndexByContent(this._pinned, normalized);
        if (pinIdx !== -1) {
            const [existing] = this._pinned.splice(pinIdx, 1);
            existing.timestamp = Date.now();
            this._pinned.unshift(existing);
            this._emitChanged();
            this._emitPinsChanged();
            return existing;
        }

        // 2) Match in history → promote to head.
        const histIdx = this._findIndexByContent(this._history, normalized);
        if (histIdx !== -1) {
            const [existing] = this._history.splice(histIdx, 1);
            existing.timestamp = Date.now();
            this._history.unshift(existing);
            this._emitChanged();
            return existing;
        }

        // 3) New item.
        this._history.unshift(normalized);
        this._trimHistory();
        this._emitChanged();
        return normalized;
    }

    _trimHistory() {
        const cap = this._cap();
        while (this._history.length > cap) {
            this._history.pop();
        }
    }

    /** Count pinned items of type image. */
    _pinnedImageCount() {
        return this._pinned.filter((it) => it.type === 'image').length;
    }

    /**
     * Evict oldest image pin (end of list among images, by reverse scan)
     * until under cap. Called before adding a new image pin.
     */
    _evictOldestImagePinsIfNeeded() {
        const max = this._maxPinnedImages();
        while (this._pinnedImageCount() >= max) {
            // Find last image pin (oldest among images by list order: unshift = newest).
            let idx = -1;
            for (let i = this._pinned.length - 1; i >= 0; i--) {
                if (this._pinned[i].type === 'image') {
                    idx = i;
                    break;
                }
            }
            if (idx === -1) break;
            const [evicted] = this._pinned.splice(idx, 1);
            warn(`evicted oldest image pin ${evicted?.id ?? '?'} (cap=${max})`);
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
     * Clear history only. Pinned items survive.
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

    /**
     * Toggle pin state of an item by id.
     * - Pin: move from history to _pinned (image soft-cap enforced).
     * - Unpin: move from _pinned back to history head (subject to cap).
     * Returns the new pinned state, or null if the item was not found.
     */
    togglePin(id) {
        const histIdx = this._history.findIndex((it) => it.id === id);
        if (histIdx !== -1) {
            const [item] = this._history.splice(histIdx, 1);
            if (item.type === 'image')
                this._evictOldestImagePinsIfNeeded();
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
     * Load persisted pins on init. Accepts text and image items (images
     * must already have bytes hydrated by storage).
     */
    loadPinned(pins) {
        if (!Array.isArray(pins)) return;
        this._pinned = pins
            .filter((it) => it && (it.type === 'text' || it.type === 'image'))
            .map((it) => ({
                id: it.id ?? makeId(),
                type: it.type,
                text: it.text ?? null,
                bytes: it.bytes ?? null,
                thumbBytes: it.thumbBytes ?? null,
                width: it.width ?? 0,
                height: it.height ?? 0,
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
                error(`store listener error: ${e}`);
            }
        }
    }

    _emitPinsChanged() {
        for (const cb of this._pinListeners) {
            try {
                cb(this._pinned.slice());
            } catch (e) {
                error(`pin listener error: ${e}`);
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
