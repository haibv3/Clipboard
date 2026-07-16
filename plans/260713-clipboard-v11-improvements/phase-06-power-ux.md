---
phase: 6
title: "Power UX"
status: done
effort: M-L
priority: P2
dependencies: [5]
---

# Phase 6: Power UX

## Overview

Keyboard power features, safer clear, multi-monitor placement, and quicker access from the
panel menu without opening the full overlay for every paste.

## Requirements

### 6.1 Digit quick-paste (1–9)

- When picker open and **search entry is empty**, keys `1`–`9` activate the Nth visible
  filtered item (1-based index into `_filteredItems()`).
- When search non-empty, digits type into search (default St.Entry behavior) — do not steal.
- Optional later: Alt+1–9 always; **not in this phase** unless empty-search rule feels bad.

### 6.2 Copy without auto-paste

- In picker: **Ctrl+Return** or **Ctrl+C** (when not selecting text in entry) activates
  item with `paste=false`.
- API: `_activate(id, { paste = true } = {})`; `paster.pasteAfterClose` only if paste.
- Footer or subtitle hint: `↵ paste · Ctrl+↵ copy`.

### 6.3 Panel menu recent items

- Indicator menu lists up to **5** most recent `store.getItems()` (pinned first as store
  order): truncated preview; activate → set clipboard + optional auto-paste (same as
  picker policy) **or** set clipboard only to avoid surprise pastes into random focus.
  **Decision: set clipboard + auto-paste** to match picker (user opened menu intentionally).
- Rebuild menu on `store.connectChanged` while enabled (or rebuild on `menu.open`).
  Prefer **rebuild on `open-state-changed` open** to avoid churn.

### 6.4 Multi-monitor picker placement

- Today: size from `Main.layoutManager.primaryMonitor` only.
- Target: use `Main.layoutManager.currentMonitor` or monitor containing
  `global.display.focus_window` frame center; fallback primary.
- Position centered on that monitor (existing CENTER align on uiGroup may need
  explicit `set_position` or constraints relative to monitor geometry).

### 6.5 Clear-all confirm

- Picker footer Clear all → small in-overlay confirm ("Clear history?" Confirm / Cancel)
  or first click arms, second confirms within 3s.
  **Decision: two-step button** — label becomes "Click again to confirm" for 3s (no extra
  modal). Same for panel "Clear history".

### 6.6 Live hotkey label

- Indicator "Open picker (…)" currently built once in `_buildIndicatorMenu`.
- Connect `settings.changed::toggle-picker` and update menu item label (or rebuild open item).

## Architecture

### `_activate` signature

```js
_activate(id, { paste = true } = {}) {
  // set clipboard ...
  this._monitor?.setIgnoreNext();
  this.close();
  if (paste && this._paster)
    this._paster.pasteAfterClose(item);
}
```

### Key handler additions (`_onKeyPress`)

```js
// After Escape/Return/arrows...
const queryEmpty = !(this._searchEntry.get_text() ?? '').trim();
if (queryEmpty && key >= Clutter.KEY_1 && key <= Clutter.KEY_9) {
  const idx = key - Clutter.KEY_1;
  if (idx < items.length) this._activate(items[idx].id);
  return Clutter.EVENT_STOP;
}
// Ctrl+Return
if ((key === Clutter.KEY_Return) && (event.get_state() & Clutter.ModifierType.CONTROL_MASK))
  this._activate(items[this._highlighted].id, { paste: false });
```

Note: plain Return currently always pastes — Ctrl+Return must be checked **before** plain
Return branch.

### Panel recent

```js
menu.connect('open-state-changed', (_m, open) => {
  if (open) this._rebuildDynamicItems();
});
```

Keep static items (Open, separator, Clear, Prefs, Quit); insert dynamic section after Open.

## Related Code Files

- Modify: `src/lib/picker.js` (keys, confirm clear, multi-monitor geometry, activate opts)
- Modify: `src/extension.js` (panel recent, clear confirm, hotkey label live)
- Modify: `src/stylesheet.css` (optional confirm button state)
- Docs: README shortcuts section

## Implementation Steps

1. Refactor `_activate` with `{ paste }` option; update all callers.
2. Keybindings: Ctrl+Return copy-only; 1–9 when search empty.
3. Multi-monitor geometry helper; use in `_build`.
4. Clear-all two-step in picker + panel.
5. Panel recent items rebuild on menu open; wire activate.
6. Live update hotkey label.
7. Subtitle/footer shortcut hints (short, not a wall of text).
8. Manual pass on multi-monitor if available; single-monitor must not regress centering.

## Success Criteria

- [x] Search empty: `3` pastes 3rd item; search "a": typing `3` filters, does not paste.
- [x] Ctrl+Return sets clipboard, focused app does **not** receive paste.
- [x] Panel shows up to 5 previews; click copies to clipboard only (no auto-paste).
- [x] Picker opens centered on focused monitor (dual setup) / primary if single.
- [x] Clear all requires second confirmation; cancels after timeout.
- [x] Changing shortcut in prefs updates panel label without re-enable.

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Digit keys fight IME | only when search empty; St.Entry not focused steal — keys hit modal actor; ensure entry still gets digits when non-empty by not handling them |
| Ctrl+C conflict with entry copy | only handle Ctrl+C when search empty or use Ctrl+Return only; **prefer Ctrl+Return as primary** to avoid entry conflicts |
| Menu rebuild flicker | rebuild only on open |
| Auto-paste from panel wrong focus | same paster path as picker; user clicked panel so focus may be shell — **risk**: paste goes to wrong place. **Mitigation: panel recent = set clipboard only (no auto-paste)** — REVISE decision: panel items **copy only**; overlay keeps auto-paste. Document in README. |

### Resolved UX decision (panel)

**Panel recent items: set clipboard only (no auto-paste).** Overlay keeps auto-paste.
Rationale: panel click often leaves focus on shell/top bar; synthesizing Ctrl+V is unreliable
and surprising.
