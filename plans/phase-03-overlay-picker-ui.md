---
phase: 3
title: "Overlay Picker UI"
status: done
effort: ""
priority: P1
dependencies: [2]
---

# Phase 3: Overlay Picker UI

## Overview
Build the Super+V overlay picker: a keyboard-grabbing modal showing the history list with
search, per-item delete (×), and a Clear-all button. Selecting an item puts it back on the
clipboard (auto-paste added in Phase 5). Pin toggle UI is wired here; pin persistence is
Phase 4.

## Requirements
- Functional: Super+V opens a centered overlay; typing filters items (case-insensitive text
  match); Up/Down + Enter select; Esc closes; clicking × removes one item; Clear-all empties
  history; clicking an item copies it to the clipboard and closes the overlay.
- Non-functional: overlay opens quickly; closing fully releases the modal grab and destroys
  transient actors (no leaks).

## Architecture
- Keybinding: in `enable()`, `Main.wm.addKeybinding('toggle-picker', this.getSettings(),
  Meta.KeyBindingFlags.NONE, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () =>
  this._togglePicker())`; `Main.wm.removeKeybinding('toggle-picker')` in `disable()`.
- Overlay (`src/lib/picker.js`): an `St.BoxLayout` container added to
  `Main.layoutManager.uiGroup`, centered via constraints. Grab input with
  `const grab = Main.pushModal(actor, { timestamp: global.get_current_time() })`; release with
  `Main.popModal(grab)`. (Grab-object API, stable since GNOME 42.)
- Contents: `St.Entry` search box (auto-focused), a scrollable `St.ScrollView` +
  `St.BoxLayout` list of row actors. Each row: preview label (text truncated), pin toggle
  button, delete (×) button. Footer: "Clear all" button + item count.
- Data binding: subscribe to store `changed`; rebuild rows. Filtering re-renders from
  `store.getItems()` with a substring match on the search text.
- Selection: on activate → `St.Clipboard.get_default().set_text(CLIPBOARD, item.text)`, set
  monitor `_ignoreNextOwnerChange`, close overlay. (Auto-paste keypress deferred to Phase 5.)
- Keyboard nav: track highlighted index; Up/Down move; Enter activates; Esc closes; Delete key
  removes highlighted.

## Related Code Files
- Create: `src/lib/picker.js`
- Modify: `src/extension.js` (register keybinding, own the picker instance, teardown)
- Modify: `stylesheet.css` (overlay box, rows, selected/hover states, search entry)
- Modify: `src/lib/store.js` (ensure `remove(id)` and `clear()` fire `changed`)

## Implementation Steps
1. Register `toggle-picker` keybinding wired to `_togglePicker()`.
2. Build overlay actor tree (container, search entry, scroll list, footer) in `picker.js`.
3. Implement open (pushModal + focus entry) and close (popModal + destroy/hide) lifecycle.
4. Render rows from store; implement search filtering and keyboard navigation.
5. Wire × (remove one), Clear-all (store.clear), and item click (set clipboard + close).
6. Add pin toggle button that calls a `store.togglePin(id)` stub (full behavior in Phase 4).
7. Style overlay in `stylesheet.css`.

## Success Criteria
- [ ] Super+V opens the overlay and focuses the search box; Esc closes it.
- [ ] Typing filters the list; Up/Down/Enter select; selecting copies text and closes.
- [ ] × removes a single item; Clear-all empties history; UI updates live.
- [ ] Opening/closing repeatedly leaves no leftover actors or stuck input grab.

## Risk Assessment
- Modal grab not released on error path → wrap close in try/finally; always `popModal(grab)`.
- Rebuilding the whole list on every keystroke could feel slow with images → keep rows light;
  debounce search if needed.
- Keybinding conflict with GNOME's own Super+V → make it rebindable (Phase 6 prefs) and
  document the conflict.
