---
phase: 3
title: "Pin Image Persistence"
status: done
effort: M
priority: P1
dependencies: [2]
---

# Phase 3: Pin Image Persistence

## Overview

Today pin UI works for images in-session, but `PinStorage` / `loadPinned` **drop all
non-text pins** (`filter type === 'text'`). Persist image pins as files under the user
data dir and reference them from `pins.json` so they survive reboot.

## Requirements

- Functional:
  - Pin image → write PNG (or original bytes) to disk; entry survives logout/login.
  - Unpin / delete / clear-of-pin path removes file.
  - Activate pinned image after restart: `set_content` works (owned `GLib.Bytes` reloaded).
  - Text pins behavior unchanged (JSON fields only).
  - Soft cap on pinned images (GSettings `max-pinned-images`, default **20**): pinning
    beyond cap refuses or unpins oldest image pin (prefer **evict oldest image pin** +
    toast/log; do not silently fail).
- Non-functional:
  - Atomic JSON update; image file write then JSON (or JSON with pending path).
  - Files mode `0600`; dir already under `~/.local/share`.
  - Debounced save preserved.
  - Corrupt/missing image file: drop that pin entry, do not crash enable().

## Architecture

### On-disk layout

```
~/.local/share/clipboard-extension/
  pins.json
  pins/
    <id>.png          # full image bytes for type=image
    <id>.thumb.png    # optional: re-generate thumb on load if missing
```

### pins.json schema (v2)

```json
[
  {
    "id": "1719-1",
    "type": "text",
    "text": "hello",
    "timestamp": 1719000000000,
    "pinned": true
  },
  {
    "id": "1719-2",
    "type": "image",
    "text": null,
    "timestamp": 1719000000001,
    "pinned": true,
    "width": 1920,
    "height": 1080,
    "file": "pins/1719-2.png"
  }
]
```

No base64 in JSON.

### Load path (`PinStorage.load` + `ClipboardStore.loadPinned`)

1. Parse JSON array.
2. Text: same as v1.
3. Image: resolve `file` relative to data dir; `Gio.File.load_contents` → owned
   `GLib.Bytes`; rebuild thumb via existing monitor/store path (extract small
   `buildThumbFromBytes(bytes)` helper shared with monitor **or** duplicate thin
   decode in storage/store on load idle).
4. Missing file → skip entry + `warn`.

### Save path

On `_emitPinsChanged` / `save(pinned)`:

1. Serialize metadata list.
2. For each image pin: ensure `pins/<id>.png` exists; if in-memory `bytes` present and
   file missing/outdated, `replace_contents` bytes.
3. After write, delete orphan files in `pins/` whose id not in current set
   (best-effort on save).
4. Write `pins.json` atomic as today.

### Store changes

- `loadPinned(pins)`: accept `type === 'image'` with preloaded `bytes`/`thumbBytes`/
  dimensions from storage layer (storage does file I/O; store stays pure).
- `togglePin` image: no special case beyond cap check before pin.
- Cap: when pinning would exceed `max-pinned-images`, remove oldest **image** pin
  (by timestamp or list order) including its file via save cycle.

### Prefer storage owns files

```
extension.enable:
  storage = new PinStorage()
  store.loadPinned(storage.load())  // load returns hydrated items with bytes

store.connectPinsChanged(pins => storage.save(pins))
// save reads item.bytes for images
```

## Related Code Files

- Modify: `src/lib/storage.js` (load/save image files, orphan cleanup, schema v2)
- Modify: `src/lib/store.js` (`loadPinned` accept images; optional pin cap)
- Modify: `src/schemas/...gschema.xml` (`max-pinned-images`)
- Modify: `src/prefs.js` (spin for max pinned images)
- Optional extract: `src/lib/image-util.js` (thumb from bytes) shared with `monitor.js`
- Modify: `README.md` (note image pins path / privacy)

## Implementation Steps

1. Add GSettings `max-pinned-images` (range 1–50, default 20).
2. Optionally extract thumbnail helper from `monitor._buildImageItem` for reuse on load.
3. Extend `_serialize` / `load` for image metadata + file paths.
4. Implement `_writeImagePin(id, bytes)` and `_deleteImagePin(id)`.
5. On save: write new image files; prune orphans; write JSON.
6. On load: hydrate bytes; rebuild thumbs on idle if heavy.
7. Update `store.loadPinned` to keep image fields.
8. Cap enforcement in `togglePin` when moving history→pinned.
9. Manual: pin screenshot → reboot/logout → open picker → paste image into app.
10. Manual: unpin → confirm file gone; pin 21st image → oldest image pin evicted.

## Success Criteria

- [x] Pinned image survives extension disable/enable and session restart.
- [x] Re-activate pastes image correctly (no double-free / empty clipboard).
- [x] Unpin/delete removes disk file.
- [x] Corrupt/missing file does not break enable().
- [x] Text pins still work; mixed list order preserved.
- [x] Pins dir files are owner-readable only where chmod applies.

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Disk full mid-write | try/catch; keep previous JSON; warn |
| Large pin set slows enable | load thumbs lazy; full bytes needed for paste — OK for ≤20 |
| ID collision | existing id scheme timestamp-counter; file named by id |
| Path traversal in `file` field | only allow basename under `pins/`; reject `..` |
| Saving raw pointers to freed bytes | always copy via `new GLib.Bytes(bytes.get_data())` before store (already on capture) |
