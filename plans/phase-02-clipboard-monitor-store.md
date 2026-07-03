---
phase: 2
title: "Clipboard Monitor & Store"
status: done
effort: ""
priority: P1
dependencies: [1]
---

# Phase 2: Clipboard Monitor & Store

## Overview
Capture clipboard changes event-driven (no polling) via `Meta.Selection` `owner-changed`, read
the current text content, and store it in an in-memory ring buffer capped at 25 with
consecutive-duplicate dedup. Text-only in this phase (images in Phase 5).

## Requirements
- Functional: copying text in any app appends a new entry at the top of the store; copying the
  same text twice in a row does not create a duplicate; store never exceeds 25 items.
- Non-functional: ~0% idle CPU (event-driven, no polling loop); no signal leaks on disable.

## Architecture
- Monitor (`src/lib/monitor.js`): `const selection = global.display.get_selection();`
  connect `owner-changed` → `(selection, selectionType, source)`. Only act when
  `selectionType === Meta.SelectionType.SELECTION_CLIPBOARD`.
- Read content: use `St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (clip,
  text) => ...)` for text (simpler than `Meta.Selection.transfer_async`; matches Clipboard
  Indicator). Ignore empty/null text.
- Guard against self-triggered changes: when the extension itself sets the clipboard (Phase 3
  paste), set an `_ignoreNextOwnerChange` flag so re-copying a selected item does not duplicate.
- Store (`src/lib/store.js`): array-backed model.
  - `HistoryItem { id, type: 'text', text, timestamp }` (image fields added Phase 5).
  - `add(item)`: dedup if identical to current head; unshift; trim non-pinned to `history-size`
    (25) read from GSettings.
  - Emits a `changed` signal (GObject signal or simple callback list) so the UI can refresh.
- Wire monitor → store in `extension.js enable()`; disconnect signal + destroy store in
  `disable()`.

## Related Code Files
- Create: `src/lib/monitor.js`
- Create: `src/lib/store.js`
- Modify: `src/extension.js` (instantiate store + monitor in `enable`, tear down in `disable`)

## Implementation Steps
1. Implement `store.js`: ring buffer with `add`, `remove(id)`, `clear()`, `getItems()`, dedup,
   cap from `history-size` setting, and a change-notification mechanism.
2. Implement `monitor.js`: connect to `Meta.Selection` `owner-changed`; on clipboard-type
   change, call `St.Clipboard.get_text` and forward non-empty text to a callback; expose
   `destroy()` that disconnects the signal.
3. Add `_ignoreNextOwnerChange` handshake between monitor and the (future) paste path.
4. Wire together in `extension.js`; log captured items to `journalctl` for verification.
5. Verify no duplicates on repeat copy and cap enforcement at 25.

## Success Criteria
- [ ] Copying distinct texts adds entries (newest first), visible in logs.
- [ ] Copying identical text consecutively does not duplicate.
- [ ] Store length stays <= 25 for non-pinned items.
- [ ] `disable()` disconnects `owner-changed` (verified: re-enabling doesn't double-fire).

## Risk Assessment
- `owner-changed` may fire for primary selection / DnD too → filter strictly by
  `SELECTION_CLIPBOARD`.
- `get_text` is async; rapid copies could race → serialize/queue reads or drop stale callbacks.
- Self-set clipboard feedback loop → mitigated by `_ignoreNextOwnerChange`.
