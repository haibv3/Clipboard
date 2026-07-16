---
phase: 4
title: "Privacy Upgrades & Pause Capture"
status: done
effort: M
priority: P1
dependencies: [3]
---

# Phase 4: Privacy Upgrades & Pause Capture

## Overview

v1 privacy is MIME-only (`privacy.js`). Extend with: (1) configurable regex denylist for
text, (2) focused-app / wm_class denylist, (3) user **pause capture** toggle with clear
indicator state. Keep existing password-manager MIME skips.

## Requirements

- Functional:
  - **Pause**: when active, monitor does not call `onCapture` (still receives owner-changed
    but returns early). Toggle from panel menu + prefs. State in GSettings `capture-paused`
    so it survives shell... actually pause should survive prefs; prefer GSettings so
    indicator and prefs stay in sync across processes.
  - **Regex denylist**: GSettings `strv` `privacy-text-denylist`; if any regex matches
    full text (case-sensitive by default), skip store. Invalid regex → skip that pattern +
    `warn`, do not break capture.
  - **App denylist**: GSettings `strv` `privacy-app-denylist` of lowercase `wm_class`
    substrings or exact matches; if focus window class matches, skip capture.
  - MIME filter unchanged and runs first (cheapest; no text read needed for secrets).
- Non-functional:
  - Pause toggle <1 interaction; visual state on panel icon (e.g. `edit-paste-symbolic`
    vs `action-unavailable-symbolic` or CSS opacity).
  - Do not log matched secret text when skipping.

## Architecture

### Capture gate order (monitor)

```
owner-changed
  → if ignoreNext: return
  → if settings.capture-paused: return          // NEW
  → if privacy.shouldSkip(selection): return   // MIME + file-op (existing)
  → if privacy.shouldSkipApp(focusWmClass): return  // NEW
  → read clipboard
  → if text and privacy.shouldSkipText(text): return  // NEW
  → forward
```

### PrivacyFilter API expansion

```js
class PrivacyFilter {
  constructor({ settings } = {}) { this._settings = settings; }

  shouldSkip(selection) { /* existing MIME logic */ }

  shouldSkipApp(wmClass) {
    const list = this._settings?.get_strv('privacy-app-denylist') ?? [];
    const c = (wmClass ?? '').toLowerCase();
    return list.some(entry => entry && c.includes(entry.toLowerCase()));
  }

  shouldSkipText(text) {
    if (!text) return false;
    for (const pat of this._settings?.get_strv('privacy-text-denylist') ?? []) {
      try {
        if (new RegExp(pat).test(text)) return true;
      } catch (e) {
        warn(`invalid privacy regex: ${pat}`);
      }
    }
    return false;
  }
}
```

### Pause

- Key: `capture-paused` type `b` default `false`.
- `extension.js` panel menu: checkable `Pause capture` item; sync label/icon on change.
- Prefs: SwitchRow in Privacy group.
- Monitor reads setting each event (or caches + connects `changed::`).

### Prefs UI

New **Privacy** group:

| Control | Binding |
|---|---|
| Pause capture | `capture-paused` |
| Blocked apps (one per line) | `privacy-app-denylist` — use Gtk.TextView or Adw with entries; simplest: `Adw.EntryRow` "Add class" + list, **or** single multiline via custom — keep simple: `Gtk.StringList` + add/remove, or comma-separated Entry for v1.1 minimal. **Decision: `strv` edited via multi-line Gtk.TextBuffer in ActionRow expanded ("one wm_class per line")** on apply. |
| Text denylist patterns | same multiline pattern for regexes |

Minimal viable prefs: two multi-line text views "Apply" buttons writing `strv` split by newline. Avoid overbuilding a list editor.

### Default denylist content

- Ship **empty** defaults (honest; no false positives).
- Prefs subtitle examples: `bitwarden`, `keepassxc`; regex example `sk_live_[0-9a-zA-Z]+` as placeholder text only.

## Related Code Files

- Modify: `src/lib/privacy.js`
- Modify: `src/lib/monitor.js` (gate order; app class + text after read)
- Modify: `src/extension.js` (pause menu item; icon state; construct PrivacyFilter with settings)
- Modify: `src/prefs.js` (Privacy group)
- Modify: `src/schemas/...gschema.xml` (3 keys)
- Modify: `src/stylesheet.css` optional paused indicator class

## Implementation Steps

1. Add GSettings keys: `capture-paused`, `privacy-app-denylist`, `privacy-text-denylist`.
2. Pass `settings` into `PrivacyFilter`; implement `shouldSkipApp` / `shouldSkipText`.
3. Wire monitor gates; for text path call `shouldSkipText` before `_forward`.
4. For image-only path, skip text denylist (no text); app denylist still applies.
5. Panel: pause toggle + icon refresh on `changed::capture-paused`.
6. Prefs Privacy group with switch + two multiline editors.
7. Manual tests:
   - Pause on → copy → no history growth; pause off → works.
   - Add wm_class of Terminal to denylist → copy from terminal skipped; from gedit kept.
   - Regex `secret-test-string` → that copy skipped.
   - Invalid regex `(` → capture still works; warn once.

## Success Criteria

- [x] MIME privacy still skips password-manager hints.
- [x] Pause stops all new history entries; existing items remain.
- [x] App denylist and text regex denylist work independently.
- [x] Invalid regex does not break the extension.
- [x] Panel shows paused state without opening prefs.
- [x] No matched secret text written to journal (debug off).

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Regex ReDoS on huge paste | limit text length checked (e.g. first 64KiB) or skip denylist above N chars |
| wm_class unstable across apps | document "use looking glass / lg"; substring match |
| Pause left on | icon + menu check state obvious |
| PrivacyFilter constructed without settings in tests | null-safe `?.` |
