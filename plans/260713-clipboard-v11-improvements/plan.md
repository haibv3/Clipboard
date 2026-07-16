---
title: "Clipboard Extension v1.1 — Polish, Privacy & Power UX"
description: "Production hygiene, smarter store (dedup/promote), pin-image persistence, privacy upgrades, capture polish, and power-user UX. Builds on completed v1 (plans/plan.md phases 1–6)."
status: done
priority: P1
branch: ""
tags: [clipboard, gnome-shell, v1.1, privacy, ux]
blockedBy: []
blocks: []
created: "2026-07-13T00:00:00.000Z"
createdBy: "ck:plan"
source: skill
---

# Clipboard Extension v1.1 — Polish, Privacy & Power UX

## Overview

v1 (GNOME Shell extension, GJS ESM, GNOME 49/50 Wayland) is **done**: event-driven
`Meta.Selection` monitor, RAM history (cap 25), text pin persistence, MIME privacy
filter, image/png + path/URI capture, Super+Shift+V overlay, auto-paste, `.deb`.

This plan upgrades **reliability, privacy, and daily UX** without changing architecture
(still a single in-shell extension — no daemon, no multi-DE, no cloud).

### Goals

1. **Production-safe**: quiet logs by default; no clipboard content in journald.
2. **Smarter history**: global content dedup + promote-to-top on re-copy.
3. **Pins that match UI**: pinned images survive reboot (today only text pins persist).
4. **Stronger privacy**: regex denylist, app/wm_class denylist, pause capture.
5. **Capture & prefs polish**: jpeg/webp, image size in MB, configurable paste delay.
6. **Power UX**: digit shortcuts, copy-without-paste, panel recent items, multi-monitor
   picker, clear-all confirm, live hotkey label.

### Non-goals (this plan)

| Out of scope | Why |
|---|---|
| Cloud clipboard sync | Privacy / threat model |
| Full persistent history (all items on disk) | Deferred; opt-in only if demanded later |
| Primary selection (middle-click) | Optional later; not blocking v1.1 |
| i18n catalogs / EGO publish | Packaging polish after feature freeze |
| Rich HTML/RTF / file-list recall | Complex, low ROI vs plain + image |
| Multi-desktop / X11 backends | v1 scope remains GNOME Wayland |
| Rewriting picker as virtual list | Cap ≤50; only if jank measured later |

### Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Keep single extension | Only reliable path on GNOME Wayland |
| History default | Still RAM-only | Privacy; pins remain the only durable data |
| Image pins | Files under `~/.local/share/clipboard-extension/pins/` + JSON metadata | Bytes too large for JSON alone |
| Dedup | Content equality across history+pinned; re-copy promotes existing item | Cleaner list than consecutive-only |
| Logging | `debug` GSettings boolean, default `false` | Production hygiene |
| Pause | In-memory + optional GSettings so prefs/indicator share state | Fast toggle, survives prefs open |
| Phases | Sequential; each phase shippable alone | Can stop after any phase |

### Baseline code map (v1)

| Module | Path | Role |
|---|---|---|
| Entry | `src/extension.js` | enable/disable, indicator menu, keybinding |
| Store | `src/lib/store.js` | `_history` + `_pinned`, cap, consecutive dedup |
| Monitor | `src/lib/monitor.js` | owner-changed → text/image capture |
| Privacy | `src/lib/privacy.js` | MIME sensitive / file-op skip |
| Storage | `src/lib/storage.js` | text-only `pins.json`, debounce, 0600 |
| Picker | `src/lib/picker.js` | overlay UI, search, activate → paste |
| Paste | `src/lib/paste.js` | Ctrl+V / Ctrl+Shift+V after delay |
| Theme | `src/lib/theme.js` | system accent / dark |
| Prefs | `src/prefs.js` | Adwaita prefs |
| Schema | `src/schemas/org.gnome.shell.extensions.clipboard.gschema.xml` | GSettings |

### Phases

| Phase | Name | Status | Effort (est.) |
|-------|------|--------|---------------|
| 1 | [Production Logging & Debug Flag](./phase-01-production-logging-debug-flag.md) | done | S |
| 2 | [Global Dedup & Promote-on-Recopy](./phase-02-global-dedup-promote.md) | done | S–M |
| 3 | [Pin Image Persistence](./phase-03-pin-image-persistence.md) | done | M |
| 4 | [Privacy Upgrades & Pause Capture](./phase-04-privacy-pause-capture.md) | done | M |
| 5 | [Capture & Prefs Polish](./phase-05-capture-prefs-polish.md) | done | M |
| 6 | [Power UX](./phase-06-power-ux.md) | done | M–L |
| 7 | [Verification, Deb Bump & Docs](./phase-07-verification-deb-docs.md) | done | S |

### Dependency graph

```
1 (logging) ──► 2 (dedup) ──► 3 (pin images)
                     │              │
                     └──────┬───────┘
                            ▼
                     4 (privacy/pause)
                            │
                            ▼
                     5 (capture/prefs)
                            │
                            ▼
                     6 (power UX)
                            │
                            ▼
                     7 (verify + ship)
```

Phases 1–3 are largely independent of 4–6 UI features but order above minimizes merge
conflicts and lets logging land first (helps debug later phases).

### Acceptance criteria (whole plan)

- [x] Default install: journald has no full clipboard text/image dumps on normal use.
- [x] Re-copying existing text/image promotes that entry; no duplicate row.
- [x] Pinned image survives logout/login and can be re-activated (set_content works).
- [x] Password-manager MIME still skipped; optional regex/app denylist work; pause stops capture.
- [x] jpeg/webp (where offered) capture; prefs show image size in MB; paste delay adjustable.
- [x] Digit 1–9 paste; Ctrl+Enter sets clipboard without paste; panel shows recent (copy-only); picker on focused monitor; clear-all confirms.
- [x] `./scripts/build-deb.sh` succeeds; version bumped; README reflects new prefs/behavior.

### Risks (plan-level)

| Risk | Mitigation |
|---|---|
| Image pin disk growth | Cap pinned images (e.g. 20); delete files on unpin/remove; document path |
| Dedup image cost (byte compare) | Size first, then `GLib.Bytes.equal`; never full scan of unrelated types |
| Pause forgotten on | Indicator icon / panel menu state shows paused |
| Auto-paste regression | Phase 5 delay is opt-in config with same defaults as today |
| GNOME 49/50 API drift | Manual verify nested shell + real session; no untested Meta APIs |

### Related docs

- v1 plan (done): [`../plan.md`](../plan.md)
- Brainstorm: [`../../docs/brainstorm-report-clipboard-gnome-extension.md`](../../docs/brainstorm-report-clipboard-gnome-extension.md)
- README: [`../../README.md`](../../README.md)

### Open questions (resolved)

1. **Digit keys vs search typing**: digits only activate when search is empty; otherwise type into search. Handled on `clutter_text` so focus on the entry still works.
2. **Pinned image cap**: default **20** (`max-pinned-images`); text pins unlimited.
3. **Regex denylist defaults**: empty defaults; examples in prefs subtitle only.
4. **Version**: extension `metadata.json` version `2`, deb `1.1-1`.

### Implementation order for cook

Prefer `/ck-cook` phase-by-phase; ship after phase 7. Can stop after phase 3 for a
"smart store + image pins" mini-release if needed.
