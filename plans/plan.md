---
title: "Clipboard GNOME Shell Extension"
description: ""
status: done
priority: P2
branch: ""
tags: []
blockedBy: []
blocks: []
created: "2026-07-01T16:01:59.890Z"
createdBy: "ck:plan"
source: skill
---

# Clipboard GNOME Shell Extension

## Overview

A lightweight **GNOME Shell extension** (GJS, ESM era) that provides a smart clipboard
manager for GNOME 49 / Wayland (Ubuntu 26.04). It keeps the last **25** clipboard items
(text + images), lets the user **pin** items (persisted across reboot), **delete** single
items or clear all, and recall them from a **Super+V overlay picker** that **auto-pastes**
the selected item into the focused app.

Chosen because Mutter does NOT support `wlr-data-control` / `ext-data-control-v1`, so a
standalone daemon cannot watch the clipboard on GNOME Wayland — an in-shell extension is the
only reliable, low-resource path. See
[`../docs/brainstorm-report-clipboard-gnome-extension.md`](../docs/brainstorm-report-clipboard-gnome-extension.md).

### Key decisions
- Scope: GNOME 49 / Wayland only (the user's machine). No multi-desktop, no X11 focus.
- Monitoring: event-driven via `Meta.Selection` `owner-changed` (no polling → ~0% idle CPU).
- History: RAM-only (cleared on logout). Pins: persisted JSON in `~/.local/share`.
- Images: share the 25 cap; skip > ~5 MB; thumbnail in list.
- Privacy: skip sensitive/concealed clipboard content (password managers).
- Paste: auto-paste via Clutter virtual keyboard (Ctrl+V) after overlay closes.
- Ship: `.deb` installing to `/usr/share/gnome-shell/extensions/<uuid>/`.

### Non-goals (v1)
Multi-desktop/KDE/X11 backends, persistent full history, cloud sync, primary-selection
(middle-click) capture, rich HTML/file-list types, special link handling (links = plain text).

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Scaffold & Extension Skeleton](./phase-01-scaffold-extension-skeleton.md) | Done |
| 2 | [Clipboard Monitor & Store](./phase-02-clipboard-monitor-store.md) | Done |
| 3 | [Overlay Picker UI](./phase-03-overlay-picker-ui.md) | Done |
| 4 | [Pin Persistence & Privacy Filter](./phase-04-pin-persistence-privacy-filter.md) | Done |
| 5 | [Images & Auto-Paste](./phase-05-images-auto-paste.md) | Done |
| 6 | [Deb Packaging & Verification](./phase-06-deb-packaging-verification.md) | Done |

## Dependencies

<!-- Cross-plan dependencies -->
