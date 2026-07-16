# Clipboard — GNOME Shell Extension

A lightweight **GNOME Shell extension** (GJS, ESM era) that provides a smart
clipboard manager for GNOME 49/50 on Wayland. Keeps the last **25** clipboard
items (text + images), lets you **pin** items (persisted across reboot),
**delete** single items or clear all, and recall them from a **Super+Shift+V
overlay picker** that **auto-pastes** the selected item into the focused app.

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
  **content-based dedup** (re-copy promotes existing item).
- Pinned items: exempt from the cap; **text + images** persisted under
  `~/.local/share/clipboard-extension/` (`pins.json` + `pins/<id>.png`).
- Image support: `image/png`, `image/jpeg`, `image/webp`, `image/bmp` (normalized
  to PNG), shared history cap, skip > ~5 MB, thumbnail in list.
- Privacy: password-manager MIME hints, optional **app denylist** and **text
  regex denylist**, **pause capture** from panel/prefs.
- Overlay picker: search, keyboard nav, pin/delete, two-step clear-all,
  multi-monitor placement, digit shortcuts, Ctrl+Enter copy-only.
- Panel menu: open picker, recent items (copy only), pause, clear, prefs.
- Auto-paste: Ctrl+V (Ctrl+Shift+V in terminals); delays configurable.
- Quiet by default: verbose journal traces only when **Debug logging** is on.
- Ships as a `.deb` installing to `/usr/share/gnome-shell/extensions/<uuid>/`.

## Shortcuts (picker)

| Key | Action |
|-----|--------|
| Super+Shift+V (default) | Toggle picker (rebindable) |
| ↑ / ↓ | Move highlight |
| Enter | Paste into focused app |
| Ctrl+Enter | Copy to clipboard only (no auto-paste) |
| 1–9 | Quick-paste Nth item (when search is empty) |
| Delete | Remove highlighted item |
| Esc | Close |

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

Enable **Debug logging** in Preferences when diagnosing capture issues (may
include short clipboard text previews).

## Install from .deb

```bash
sudo apt install ./dist/clipboard-extension_1.1-1_all.deb
# log out and back in
gnome-extensions enable clipboard@haibachvan.local
```

## Preferences (GSettings)

Schema: `org.gnome.shell.extensions.clipboard`

| Key | Default | Meaning |
|-----|---------|---------|
| `toggle-picker` | `<Super><Shift>v` | Global shortcut |
| `history-size` | 25 | Max non-pinned history items |
| `max-image-bytes` | 5242880 | Skip larger images |
| `max-pinned-images` | 20 | Soft cap on pinned images on disk |
| `auto-paste` | true | Paste after picker select |
| `paste-delay-text-ms` | 200 | Paste delay for text |
| `paste-delay-image-ms` | 350 | Paste delay for images |
| `capture-paused` | false | Pause capture |
| `privacy-app-denylist` | [] | wm_class substrings |
| `privacy-text-denylist` | [] | Regex patterns |
| `debug` | false | Verbose journal logging |
| `clear-requested` | 0 | Prefs→shell clear signal |

## Hotkey conflict note

Default is **Super+Shift+V** (Super+V often conflicts with GNOME). Rebind via
**Preferences**.

## Status

- v1: [`plans/plan.md`](plans/plan.md) (done)
- v1.1: [`plans/260713-clipboard-v11-improvements/plan.md`](plans/260713-clipboard-v11-improvements/plan.md)
