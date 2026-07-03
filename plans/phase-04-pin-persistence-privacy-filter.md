---
phase: 4
title: "Pin Persistence & Privacy Filter"
status: done
effort: ""
priority: P1
dependencies: [3]
---

# Phase 4: Pin Persistence & Privacy Filter

## Overview
Make pinned items real: pins are exempt from the 25-item cap, never evicted, and persisted to
disk so they survive logout/reboot (history stays RAM-only). Add a privacy filter that skips
password-manager / concealed clipboard content.

## Requirements
- Functional: pinning an item keeps it even after 25+ new copies; pins survive shell restart /
  logout; unpinning returns it to normal history behavior; sensitive copies are never stored.
- Non-functional: pin file writes are atomic and cheap; history remains RAM-only (never
  written to disk).

## Architecture
- Store split: `_history` (RAM ring, capped 25, non-pinned) and `_pinned` (unbounded, ordered).
  Cap trimming applies only to `_history`. `getItems()` returns pinned first, then history.
- `togglePin(id)`: move item between lists; on pin, remove from history so it doesn't
  double-count; on unpin, insert back at history head (subject to cap).
- Persistence (`src/lib/storage.js`): pins saved to
  `GLib.get_user_data_dir()/clipboard-extension/pins.json` (i.e. `~/.local/share/...`).
  - Save: serialize pinned items (text only for now; image pins deferred/optional) via
    `Gio.File.replace_contents` (atomic replace). Debounce writes.
  - Load: on `enable()`, read + parse JSON; tolerate missing/corrupt file (start empty).
- Privacy filter (`src/lib/privacy.js`): before storing, inspect available mimetypes via
  `Meta.Selection.get_mimetypes(selection, SELECTION_CLIPBOARD)`. Skip if any of:
  `x-kde-passwordManagerHint` present, `application/x-nautilus-clipboard` (file cut/copy),
  or a `concealed`/password hint mimetype. Also allow a configurable regex denylist later.

## Related Code Files
- Create: `src/lib/storage.js` (load/save pins JSON, atomic write, debounce)
- Create: `src/lib/privacy.js` (mimetype-based sensitivity check)
- Modify: `src/lib/store.js` (split pinned/history lists, `togglePin`, cap only history,
  load pins on init, trigger save on pin changes)
- Modify: `src/lib/monitor.js` (consult privacy filter before forwarding a capture; expose
  mimetypes to the check)
- Modify: `src/lib/picker.js` (render pinned section distinctly; pin toggle reflects state)

## Implementation Steps
1. Refactor `store.js` into pinned + history lists; ensure cap applies only to history.
2. Implement `togglePin` moving items between lists and firing `changed` + save.
3. Implement `storage.js`: JSON load on init, atomic debounced save on pin mutations, path
   under `GLib.get_user_data_dir()`.
4. Implement `privacy.js`: fetch mimetypes from `Meta.Selection` and return skip/allow.
5. Wire privacy check into the monitor capture path (skip storing sensitive content).
6. Update picker to show a pinned section and correct pin-toggle icon state.

## Success Criteria
- [ ] Pinned item survives 25+ new copies (not evicted).
- [ ] Pins reload correctly after logout/login (read from `pins.json`).
- [ ] Unpinning returns item to normal history flow.
- [ ] Copying from a password manager (concealed mimetype) does not create a history entry.
- [ ] History data is never written to disk (only pins).

## Risk Assessment
- Corrupt/partial `pins.json` → wrap parse in try/catch, back up + reset on failure.
- Mimetype hints vary by app; not all password managers set a hint → document limitation;
  optionally add a manual "clear last" and configurable denylist.
- Atomic write correctness → use `Gio.File.replace_contents` with backup flag.
