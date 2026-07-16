---
phase: 1
title: "Production Logging & Debug Flag"
status: done
effort: S
priority: P1
dependencies: []
---

# Phase 1: Production Logging & Debug Flag

## Overview

Stop dumping clipboard content and high-frequency trace logs to journald in normal use.
Introduce a single `debug` GSettings flag (default `false`) and a tiny logger helper used
by all modules.

## Requirements

- Functional:
  - Default: only real errors (and optionally one-line enable/disable) may log.
  - With `debug=true`: current verbose traces remain available for development.
  - Prefs: SwitchRow "Debug logging".
- Non-functional:
  - Zero measurable CPU cost when debug off (boolean check only).
  - No clipboard text body, full mimetype dumps, or byte sizes at info level when debug off
    *except* errors that must not include secret text.

## Architecture

```
src/lib/log.js
  init(settings) | setDebug(bool)
  debug(msg)     → log() only if debug
  warn(msg)      → always log (prefix [Clipboard])
  error(msg)     → always log

All modules: import { debug, warn, error } from './log.js'
extension.enable: Log.init(this._settings); connect changed::debug
```

### Replacement policy

| Current pattern | When debug off | When debug on |
|---|---|---|
| `log('[Clipboard] owner-changed…')` | silent | log |
| `log(... text.substring ...)` | silent | log (truncate still) |
| `log(... error: ${e})` | keep as `error()` | same |
| Unexpected catch with no recovery | `error()` | same |

### GSettings

```xml
<key name="debug" type="b">
  <default>false</default>
  <summary>Debug logging</summary>
  <description>If true, verbose clipboard capture traces go to the system journal.</description>
</key>
```

## Related Code Files

- Create: `src/lib/log.js`
- Modify: `src/schemas/org.gnome.shell.extensions.clipboard.gschema.xml`
- Modify: `src/extension.js` (init logger on enable)
- Modify: `src/prefs.js` (Debug switch under Maintenance or Advanced group)
- Modify: all current `log(...)` call sites in:
  - `src/lib/monitor.js` (~30+ calls)
  - `src/lib/store.js`
  - `src/lib/picker.js`
  - `src/lib/paste.js`
  - `src/lib/privacy.js`
  - `src/lib/storage.js`
  - `src/lib/theme.js`
- Mirror schema into `build/` only via existing package scripts (do not hand-edit dist)

## Implementation Steps

1. Add `src/lib/log.js` with `init` / `debug` / `warn` / `error` and internal `_enabled`.
2. Add GSettings key `debug` (default false).
3. In `ClipboardShellExtension.enable()`, call `Log.init(this._settings)` and reconnect on
   `changed::debug`.
4. Replace `log(\`[Clipboard] ...\`)` across modules:
   - Trace paths → `debug(...)`
   - Failures that leave degraded state → `error(...)` without embedding clipboard body
5. Prefs: Adw.SwitchRow bound to `debug`.
6. Manual: with debug off, copy text 10×, confirm `journalctl -f /usr/bin/gnome-shell`
   shows no pasted content; enable debug, confirm traces return.

## Success Criteria

- [x] `debug=false` (default): no clipboard text content appears in journal during normal copy/paste.
- [x] `debug=true`: capture path traces visible again.
- [x] Schema compiles (`glib-compile-schemas` via `dev-install.sh`).
- [x] Extension enable/disable still clean (no leftover handlers from logger).

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Miss a `log()` site | `rg "log\\(\\`\\[Clipboard\\]"` before finish; zero matches |
| Logger init order | init before monitor.start() |
| Prefs process has no logger need | prefs only writes GSettings; no import required unless it logs |
