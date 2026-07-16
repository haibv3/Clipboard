---
phase: 2
title: "Global Dedup & Promote-on-Recopy"
status: done
effort: S-M
priority: P1
dependencies: [1]
---

# Phase 2: Global Dedup & Promote-on-Recopy

## Overview

Replace consecutive-only head dedup with **content-based dedup across history and pinned
lists**. Re-copying the same text/image promotes the existing item to the top of its list
(history head or pinned head) and updates `timestamp` — no second row.

## Requirements

- Functional:
  - Text: exact string equality (`item.text === other.text`).
  - Image: same as today — size first, then `GLib.Bytes.equal` / byte walk (`_bytesEqual`).
  - Match in `_history` → remove old, unshift same logical item (keep `id`, set new
    `timestamp`), return that item (not null).
  - Match in `_pinned` → move to pinned head, update `timestamp`, do **not** create history
    entry; return pinned item.
  - Different content always inserts new history head as today.
  - Cap trim still only on `_history`.
- Non-functional:
  - O(n) with n ≤ history-size + pins (~50–100 max typical); fine on main loop.
  - Image compare short-circuits on size mismatch.

## Architecture

### Current (v1)

```js
// store.js
_isDuplicate(item) {
  const head = this._history[0];
  // only compares to head
}
add(item) {
  if (this._isDuplicate(normalized)) return null;
  this._history.unshift(normalized);
  this._trimHistory();
}
```

### Target

```js
add(item) {
  const normalized = { id: makeId(), ...fields, pinned: false };

  // 1) Search pinned (text or image content match)
  const pinIdx = this._findIndexByContent(this._pinned, normalized);
  if (pinIdx !== -1) {
    const [existing] = this._pinned.splice(pinIdx, 1);
    existing.timestamp = Date.now();
    // refresh bytes/thumb if image re-copy brought new buffers (same content)
    this._pinned.unshift(existing);
    this._emitChanged();
    this._emitPinsChanged(); // order changed — optional save; order matters for UX
    return existing;
  }

  // 2) Search history
  const histIdx = this._findIndexByContent(this._history, normalized);
  if (histIdx !== -1) {
    const [existing] = this._history.splice(histIdx, 1);
    existing.timestamp = Date.now();
    this._history.unshift(existing);
    this._emitChanged();
    return existing;
  }

  // 3) New
  this._history.unshift(normalized);
  this._trimHistory();
  this._emitChanged();
  return normalized;
}
```

### Content equality helper

```js
_sameContent(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'text') return a.text === b.text;
  if (a.type === 'image') return _bytesEqual(a.bytes, b.bytes);
  return false;
}
```

Keep `_bytesEqual` as-is (already defensive).

### Picker / UI

No structural change required: store still emits `changed`; open picker re-renders.
If picker open during re-copy, item jumps to top — acceptable.

### Monitor self-trigger

`setIgnoreNext` path unchanged. Promote path must not re-enter from our own
`set_text`/`set_content` (still ignored).

## Related Code Files

- Modify: `src/lib/store.js` (core)
- Optional test-style self-check: document manual cases (no unit runner in project yet)
- Touch: none of monitor/picker unless logging mentions "deduped"

## Implementation Steps

1. Extract `_sameContent(a, b)` and `_findIndexByContent(list, item)`.
2. Rewrite `add()` promote logic for pinned then history.
3. Remove obsolete consecutive-only `_isDuplicate` or reimplement as thin wrapper unused.
4. Ensure pin promote still calls `_emitPinsChanged` so storage rewrite preserves order
   (text pins); image pins come in phase 3.
5. Manual matrix:
   - Copy "hello" twice → one row, timestamp updates.
   - Copy A, B, A → order A, B (A promoted), length 2.
   - Pin "hello", copy "hello" again → stays pinned only, one entry, top of pinned.
   - Two different images same dimensions but different pixels → two rows.
   - Same image re-copied → one row, promoted.

## Success Criteria

- [x] Consecutive and non-consecutive text re-copies never create a second row.
- [x] Image re-copy (identical PNG bytes) promotes, no duplicate.
- [x] Pinned text re-copy does not also appear under Recent.
- [x] History cap still enforced after promotes + new inserts.
- [x] No regression on pin/unpin/delete/clear.

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Image byte compare CPU on large PNGs | size check first; n small |
| Identity vs content: user wants two same strings as separate | YAGNI; content dedup is industry standard |
| Losing updated image thumb on re-copy | if bytes equal, keep existing buffers; if equal content, no need to replace |
| `_emitPinsChanged` thrash on every pinned re-copy | debounce already in storage (400ms); OK |
