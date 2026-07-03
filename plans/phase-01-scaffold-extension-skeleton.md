---
phase: 1
title: "Scaffold & Extension Skeleton"
status: done
effort: ""
priority: P1
dependencies: []
---

# Phase 1: Scaffold & Extension Skeleton

## Overview
Create a minimal, loadable GNOME 49 (ESM) shell extension that enables/disables cleanly and
shows a panel indicator. Establishes the file layout, GSettings schema, and a dev/reload
workflow so later phases have a working shell to build on.

## Requirements
- Functional: extension appears in `gnome-extensions list`, enables without errors, adds a
  top-bar icon, disables and removes everything cleanly.
- Non-functional: zero errors in `journalctl`/Looking Glass on enable/disable; no leaked
  signals/timeouts on disable.

## Architecture
- UUID: `clipboard@haibachvan.local` (installed to
  `~/.local/share/gnome-shell/extensions/<uuid>/` during dev; `/usr/share/...` in the .deb).
- ESM era (GNOME 45+, confirmed for 49): `extension.js` exports `default class extends
  Extension`; `prefs.js` exports `default class extends ExtensionPreferences`.
- `metadata.json` `shell-version: ["49"]` (add 46-48 later if desired), `settings-schema:
  "org.gnome.shell.extensions.clipboard"`.
- GSettings schema `schemas/org.gnome.shell.extensions.clipboard.gschema.xml` with keys:
  `toggle-picker` (type `as`, default `["<Super>v"]`), `history-size` (`i`, default 25).

## Related Code Files
- Create: `src/metadata.json`
- Create: `src/extension.js` (skeleton: `enable()` adds `PanelMenu.Button` icon; `disable()`
  destroys it and nulls references)
- Create: `src/prefs.js` (empty `fillPreferencesWindow` for now)
- Create: `src/schemas/org.gnome.shell.extensions.clipboard.gschema.xml`
- Create: `stylesheet.css` (empty placeholder)
- Create: `Makefile` or `scripts/dev-install.sh` (copy to `~/.local/share/...`,
  `glib-compile-schemas schemas/`)
- Create: `README.md` (dev + enable instructions)

## Implementation Steps
1. Write `metadata.json` with uuid/name/description/`shell-version: ["49"]`/`settings-schema`.
2. Write GSettings schema XML with `toggle-picker` (`as`) and `history-size` (`i`).
3. Write `extension.js` skeleton importing `Extension` from
   `resource:///org/gnome/shell/extensions/extension.js`, plus `PanelMenu`/`PanelMenu.Button`
   and `St` for a top-bar icon.
4. Write `prefs.js` skeleton importing `ExtensionPreferences` from
   `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`.
5. Write `scripts/dev-install.sh`: rsync `src/` → `~/.local/share/gnome-shell/extensions/<uuid>/`,
   run `glib-compile-schemas schemas/`.
6. Document the Wayland reload reality: after code changes, **logout/login** (no `Alt+F2 r`);
   use nested shell `dbus-run-session -- gnome-shell --nested --wayland` for faster iteration.

## Success Criteria
- [ ] `dev-install.sh` installs the extension and compiles schemas without error.
- [ ] After logout/login (or nested shell), `gnome-extensions enable <uuid>` succeeds.
- [ ] Top-bar icon appears; disabling removes it with no errors in `journalctl -f -o cat
      /usr/bin/gnome-shell`.

## Risk Assessment
- Wrong `settings-schema` id or uncompiled schema → enable fails. Mitigation: compile in
  dev-install and verify with `gsettings --schemadir <dir> list-keys <schema>`.
- GNOME 49 API drift: keep skeleton minimal; validate against gjs.guide ESM anatomy.
