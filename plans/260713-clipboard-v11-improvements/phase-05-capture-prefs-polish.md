---
phase: 5
title: "Capture & Prefs Polish"
status: done
effort: M
priority: P2
dependencies: [4]
---

# Phase 5: Capture & Prefs Polish

## Overview

Improve capture breadth and prefs usability: more image MIME types, human-friendly image
size units, configurable auto-paste delay (text/image), keep defaults behavior-compatible
with v1.

## Requirements

- Functional:
  - Capture `image/png`, `image/jpeg`, `image/webp`, `image/bmp` when offered via
    `get_content` (priority order: png → jpeg → webp → bmp).
  - Path/URI load path already accepts jpg/jpeg/bmp/webp extensions — keep; ensure
    decoded bytes stored consistently (re-encode to PNG for pin/store simplicity **or**
    store original MIME + bytes). **Decision: normalize to PNG in memory via GdkPixbuf
    on capture** so activate always `set_content(..., 'image/png', bytes)` (matches
    picker today).
  - Prefs: max image size shown as **MB** (spin 0.1–50, step 0.5); store still int bytes
    in GSettings **or** new double key — **prefer keep int bytes, convert in prefs UI**.
  - Prefs: `paste-delay-text-ms` (default 200), `paste-delay-image-ms` (default 350);
    `paste.js` reads settings instead of constants only.
- Non-functional:
  - JPEG decode path must not freeze shell: keep `GLib.idle_add` for pixbuf work.
  - Max image bytes still enforced before decode when size known; after decode for path loads.

## Architecture

### monitor.js image MIME selection

```js
const IMAGE_MIME_PRIORITY = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/bmp',
];

function pickImageMime(mimetypes) {
  const lower = mimetypes.map(m => (m ?? '').toLowerCase());
  return IMAGE_MIME_PRIORITY.find(m => lower.includes(m)) ?? null;
}
```

`get_content(CLIPBOARD, mime, cb)` → owned bytes → pixbuf decode → if source not png,
`pixbuf.save_to_bufferv('png')` for storage/activate consistency → thumb → forward.

### paste.js

```js
const delay = isImage
  ? (this._settings.get_int('paste-delay-image-ms') || 350)
  : (this._settings.get_int('paste-delay-text-ms') || 200);
```

Clamp in schema ranges (e.g. 50–2000 ms).

### prefs.js

- Image group: SpinRow "Max image size (MB)" ↔ `max-image-bytes` via `mb * 1024 * 1024`.
- New group or General: paste delays as two SpinRows (ms).

## Related Code Files

- Modify: `src/lib/monitor.js` (multi-MIME, PNG normalize)
- Modify: `src/lib/paste.js` (settings delays)
- Modify: `src/prefs.js` (MB UI, delay rows)
- Modify: `src/schemas/...gschema.xml` (delay keys)
- Optional: `src/lib/image-util.js` if extracted in phase 3

## Implementation Steps

1. Add schema keys for paste delays with v1-compatible defaults.
2. Refactor monitor image branch to use `pickImageMime` + PNG normalize.
3. Wire paste delays from settings.
4. Prefs MB conversion (careful integer rounding: `Math.round(mb * 1048576)`).
5. Manual: copy JPEG from browser/file manager; appears as image; paste works.
6. Manual: set delay 500ms; feel the lag; set 50ms; verify no focus race on fast machine
   (document if flaky).

## Success Criteria

- [x] PNG path unchanged and still stable.
- [x] At least JPEG capture works in real session.
- [x] WebP/BMP work when compositor/app offers those MIME types (document if app only
      offers png).
- [x] Prefs MB round-trips without 1-byte drift large enough to matter.
- [x] Auto-paste defaults match v1 timing when user never opens prefs.

## Risk Assessment

| Risk | Mitigation |
|---|---|
| Some apps only offer image/png | keep png first; no regression |
| WebP support in GdkPixbuf missing | try/catch; skip with debug log |
| PNG re-encode quality/size | acceptable for clipboard manager; original already size-capped |
| Too-low paste delay fails paste | schema min 50; default 200/350 |
