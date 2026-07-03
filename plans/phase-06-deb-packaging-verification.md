---
phase: 6
title: "Deb Packaging & Verification"
status: done
effort: ""
priority: P2
dependencies: [5]
---

# Phase 6: Deb Packaging & Verification

## Overview
Add a preferences UI (rebindable hotkey, history size, image cap, clear-all), then package the
extension as a `.deb` that installs system-wide and compiles the GSettings schema, and run a
full end-to-end verification on GNOME 49 / Wayland.

## Requirements
- Functional: `sudo apt install ./clipboard-extension.deb` installs to
  `/usr/share/gnome-shell/extensions/<uuid>/`, compiles schemas, and the extension is
  enableable after logout/login; `apt remove` cleans up.
- Non-functional: package is small, lints clean (`lintian` warnings triaged), reproducible
  build via a single script.

## Architecture
- Preferences (`prefs.js`): Adwaita (`Adw.PreferencesWindow`) via `fillPreferencesWindow` with
  rows for: shortcut (rebind `toggle-picker`), history size (spin, 5-50), max image size,
  "clear history now" button.
- Packaging layout (`debian/`):
  - Install path: `/usr/share/gnome-shell/extensions/clipboard@haibachvan.local/`
    (metadata.json, extension.js, prefs.js, stylesheet.css, lib/, schemas/).
  - GSettings schema installed to
    `/usr/share/glib-2.0/schemas/` OR kept in the extension's `schemas/` dir; compile in
    `postinst` with `glib-compile-schemas`.
  - `debian/control` (Section: gnome, Depends: `gnome-shell (>= 49)`), `debian/rules`
    (dh-based), `debian/postinst`/`postrm` (compile/recompile schemas), `debian/changelog`,
    `debian/compat`/`debhelper-compat`.
- Build script `scripts/build-deb.sh` wrapping `dpkg-buildpackage -b -us -uc` (or a simpler
  `dpkg-deb --build` staging tree if full debhelper is overkill).

## Related Code Files
- Modify: `src/prefs.js` (full Adwaita preferences)
- Create: `debian/control`, `debian/rules`, `debian/changelog`, `debian/postinst`,
  `debian/postrm`, `debian/install`, `debian/compat` (or `debian/debhelper-compat`)
- Create: `scripts/build-deb.sh`
- Modify: `README.md` (install-from-deb + enable instructions, hotkey conflict note)

## Implementation Steps
1. Build the Adwaita preferences UI in `prefs.js` (shortcut, history size, image cap, clear).
2. Create `debian/` metadata; set install path and dependency on `gnome-shell (>= 49)`.
3. Write `postinst`/`postrm` to (re)compile GSettings schemas.
4. Write `scripts/build-deb.sh`; produce `clipboard-extension_<ver>_all.deb`.
5. Install the .deb in a clean session, logout/login, enable, and run the full feature pass.
6. Run `lintian` on the .deb and triage warnings.

## Success Criteria
- [ ] `.deb` builds reproducibly from `scripts/build-deb.sh`.
- [ ] Install → logout/login → `gnome-extensions enable <uuid>` works; schema compiled.
- [ ] End-to-end pass: capture text+image, Super+V picker, search, pin (survives reboot),
      delete one, clear all, privacy skip, auto-paste — all functioning.
- [ ] `apt remove` removes files and recompiles schemas cleanly.
- [ ] `lintian` shows no errors (warnings triaged/justified).

## Risk Assessment
- Arch: JS extension is architecture-independent → package as `all`; verify control fields.
- System schema vs extension-local schema conflicts → pick one location; recompile in maintainer
  scripts.
- GNOME 49 version dependency too strict for other machines → acceptable (scope is user's
  machine); note in README how to widen `shell-version`.
- Wayland requires logout to load new shell code → document; cannot be auto-verified in CI.
