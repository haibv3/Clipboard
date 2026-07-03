# Clipboard — GNOME Shell Extension

A lightweight **GNOME Shell extension** (GJS, ESM era) that provides a smart
clipboard manager for GNOME 49/50 on Wayland. Keeps the last **25** clipboard
items (text + images), lets you **pin** items (persisted across reboot),
**delete** single items or clear all, and recall them from a **Super+V overlay
picker** that **auto-pastes** the selected item into the focused app.

## Why an extension?

Mutter does **not** expose `wlr-data-control` / `ext-data-control-v1`, so
standalone daemons (`cliphist`, `clipman`, `wl-paste --watch`, CopyQ Wayland
mode) cannot reliably watch background clipboard changes on GNOME Wayland. An
in-shell extension is the only reliable, low-resource path. See
[`docs/brainstorm-report-clipboard-gnome-extension.md`](docs/brainstorm-report-clipboard-gnome-extension.md).

## Features

- Event-driven clipboard monitoring via `Meta.Selection` `owner-changed`
  (no polling → ~0% idle CPU).
- In-memory history (RAM-only, cleared on logout) capped at 25 items with
  consecutive-duplicate dedup.
- Pinned items: exempt from the cap, persisted to `~/.local/share/...`
  (`pins.json`), survive reboot.
- Image support: `image/png`, shared 25 cap, skip > ~5 MB, thumbnail in list.
- Privacy filter: skips password-manager / concealed clipboard content.
- Super+V overlay picker: search, keyboard nav, per-item delete, clear-all.
- Auto-paste: synthesizes Ctrl+V (Ctrl+Shift+V in terminals) into the focused
  app after the overlay closes.
- Ships as a `.deb` installing to `/usr/share/gnome-shell/extensions/<uuid>/`.

## Development install

```bash
./scripts/dev-install.sh
```

This copies `src/` into `~/.local/share/gnome-shell/extensions/clipboard@haibachvan.local/`
and compiles the GSettings schema.

### Enable

Wayland cannot reload gnome-shell with `Alt+F2 r`, so after code changes you
must **log out and back in**, then:

```bash
gnome-extensions enable clipboard@haibachvan.local
```

For faster iteration without logout, use a nested shell:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

### Tail logs

```bash
journalctl -f -o cat /usr/bin/gnome-shell
```

## Install from .deb (Phase 6)

```bash
sudo apt install ./clipboard-extension_1.0-1_all.deb
# log out and back in
gnome-extensions enable clipboard@haibachvan.local
```

## Hotkey conflict note

Super+V may conflict with GNOME's own binding. It is rebindable via
**Preferences** (the `toggle-picker` GSettings key).

## Status

See [`plans/plan.md`](plans/plan.md) for the phase-by-phase implementation plan.
