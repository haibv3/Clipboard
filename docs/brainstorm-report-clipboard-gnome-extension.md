# Brainstorm Report — "Clipboard" Smart Clipboard Manager (GNOME Shell Extension)

- Date: 2026-07-01
- Mode: brainstorm (design only, no implementation)
- Target machine: Ubuntu 26.04, GNOME 49, Wayland
- Status: design approved by user, ready for `/ck-plan`

## Problem statement
User wants a smart clipboard manager for Linux: keep last 25 copies (text + images + links),
pin frequently-reused items, and delete history (single item or all). Must ship as a `.deb`,
be simple, efficient, fast/smooth, low resource usage.

## Critical constraint discovered (feasibility)
GNOME's Mutter compositor does NOT expose `wlr-data-control` or `ext-data-control-v1`
(verified via protocol/compositor support docs + xwayland-satellite PR #431). Therefore the
entire standalone-daemon ecosystem (`cliphist`, `clipman`, `wl-paste --watch`, CopyQ Wayland
mode) CANNOT reliably watch background clipboard changes on GNOME Wayland — Mutter only hands
the selection to the focused client. The only reliable approaches on GNOME Wayland are:
- a GNOME Shell extension (GJS, runs inside gnome-shell), or
- a GPaste-style native daemon + GNOME Shell extension bridge.

## Approaches evaluated
- A. GNOME Shell Extension (GJS) — lightest, most reliable on target; UI = in-shell overlay.
- B. Native daemon + extension bridge + own GUI window — most app-like, much more complex.
- C. Standalone app polling XWayland (`xsel`/XFIXES) — advised against; misses Wayland-native
  copies and images are flaky.

## Decisions (from user)
- Scope: only the user's machine (GNOME Wayland). No multi-desktop, no X11 focus.
- Architecture: A — single GNOME Shell extension.
- UI: floating overlay picker triggered by global hotkey (Super+V), Pano-style.
- Paste behavior: auto-paste on select (synthesize Ctrl+V via Clutter virtual input device —
  feasible because the extension runs in-process with Mutter).
- History persistence: RAM-only (cleared on logout).
- Pins: persisted to `~/.local/share/...` (survive reboot); kept separate from the 25 cap.
- Images: share the 25-item cap; skip images larger than ~5 MB; store thumbnail for list.
- Privacy: skip content flagged sensitive/concealed (password-manager copies).

## Recommended solution (final)
Single GJS GNOME Shell extension:
1. Monitor: event-driven via `global.display.get_selection()` `owner-changed` signal (no polling
   → ~0% idle CPU). Dedup consecutive duplicates.
2. Store: in-memory ring buffer (max 25) + separate persisted pinned list (JSON in
   `~/.local/share`). Pins do not count toward 25 and are never evicted.
3. Images: read `image/png`, skip > ~5 MB, keep bytes + small thumbnail.
4. Privacy filter: inspect offered MIME types, skip sensitive/concealed markers.
5. UI: St-based overlay picker, opened by Super+V (rebindable via GSettings/prefs). Search box,
   list with text previews + image thumbnails, per-item pin toggle + delete (×), Clear-all button.
6. Paste: set clipboard → close overlay → synthesize Ctrl+V into previously focused app.
7. Packaging: `.deb` installing to `/usr/share/gnome-shell/extensions/<uuid>/`, compiling the
   GSettings schema; README with `gnome-extensions enable`.

## Acceptance criteria
- Copying text/image makes it appear at top of the list (dedup applied; sensitive skipped).
- Super+V opens the overlay; typing filters; Esc closes.
- Selecting an item auto-pastes it into the focused app.
- Pinning keeps an item out of the 25-eviction and persists across reboot.
- Delete removes one item; Clear-all empties history.
- Images over the size cap are ignored; thumbnails render in the list.
- History is gone after logout; pins remain.
- Ships and installs as a `.deb` on Ubuntu 26.04 / GNOME 49 Wayland.

## Out of scope (this round)
Multi-desktop/compositor support, KDE/X11 backends, persistent full history, cloud sync,
primary-selection (middle-click) capture, rich HTML/file-list clipboard types.

## Risks
- GNOME 49 is brand-new; `metadata.json` must target shell version 49 and each API must be
  verified against 49 (APIs shift between shell versions).
- Auto-paste timing: virtual device must fire after overlay releases keyboard focus.
- Reading `image/png` from St.Clipboard + thumbnail rendering needs care (GdkPixbuf/Gio).
- Wayland dev loop: reloading shell code requires logout/login (no `Alt+F2 r`).

## Next steps
- Proceed to `/ck-plan` (standard mode) to produce phase-by-phase implementation plan.

## Open questions
- Exact default hotkey confirmed as Super+V (rebindable) — acceptable? (assumed yes)
- Should "links" get any special treatment (e.g. clickable), or are they just text? (assumed
  plain text for v1)
