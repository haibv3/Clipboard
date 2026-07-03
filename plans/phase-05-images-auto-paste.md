---
phase: 5
title: "Images & Auto-Paste"
status: done
effort: ""
priority: P2
dependencies: [4]
---

# Phase 5: Images & Auto-Paste

## Overview
Add image clipboard support (capture `image/png`, size cap, thumbnail in the picker) and real
auto-paste: after selecting an item, synthesize Ctrl+V into the previously focused app via a
Clutter virtual keyboard.

## Requirements
- Functional: copying an image stores it (shared 25 cap) unless larger than the size cap
  (~5 MB), in which case it is skipped; the picker shows a thumbnail; selecting any item
  auto-pastes it into the focused window.
- Non-functional: thumbnails are downscaled (not full-res in the list) to keep memory/RAM
  reasonable; auto-paste fires reliably after the overlay releases its grab.

## Architecture
- Image capture (`monitor.js`): when clipboard changes, check mimetypes; if no usable text but
  `image/png` is offered, call `St.Clipboard.get_default().get_content(CLIPBOARD, 'image/png',
  (clip, bytes) => ...)`. `bytes` is `GLib.Bytes`. Enforce `bytes.get_size() <= maxImageBytes`
  (setting, default ~5 MB) else skip. (Note GNOME Shell issue #4034 caveat — validate on 49.)
- Image model: `HistoryItem { type: 'image', bytes, thumbBytes, width, height, timestamp }`.
  Generate a downscaled thumbnail with `GdkPixbuf.Pixbuf.new_from_stream*` →
  `scale_simple(...)` → `save_to_bufferv('png')`; keep full bytes for paste, thumb for display.
- Thumbnail display: build a `St.Icon`/`St.Bin` using `Gio.BytesIcon.new(thumbBytes)` (or an
  `St.ImageContent`/Clutter image from the pixbuf) as the row content for image items.
- Restore image to clipboard on select: `St.Clipboard.get_default().set_content(CLIPBOARD,
  'image/png', item.bytes)`.
- Auto-paste (`src/lib/paste.js`): after `popModal` and a short idle tick (let focus return to
  the app), run the Clipman-verified sequence:
  ```
  const seat = Clutter.get_default_backend().get_default_seat();
  const vk = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
  vk.notify_keyval(Clutter.CURRENT_TIME, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
  vk.notify_keyval(Clutter.CURRENT_TIME, Clutter.KEY_v,         Clutter.KeyState.PRESSED);
  vk.notify_keyval(Clutter.CURRENT_TIME, Clutter.KEY_v,         Clutter.KeyState.RELEASED);
  vk.notify_keyval(Clutter.CURRENT_TIME, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
  ```
  Detect terminal focus (window wm_class) and send Ctrl+Shift+V there instead. Use a
  `GLib.timeout_add`/`idle_add` after `popModal` so paste lands in the app, not the shell.

## Related Code Files
- Create: `src/lib/paste.js` (virtual keyboard Ctrl+V, terminal detection)
- Modify: `src/lib/monitor.js` (image capture path + size cap)
- Modify: `src/lib/store.js` (image item type; thumbnail generation)
- Modify: `src/lib/picker.js` (render image rows via thumbnail; set image content on select;
  call paste after close)
- Modify: `src/schemas/...gschema.xml` (`max-image-bytes` key, default 5242880)

## Implementation Steps
1. Add `max-image-bytes` setting; read it in the store/monitor.
2. Implement image capture with size cap in `monitor.js`.
3. Implement thumbnail generation + image row rendering in store/picker.
4. Implement restore-image-to-clipboard on select (`set_content`).
5. Implement `paste.js` virtual-keyboard Ctrl+V with a post-close idle delay; add terminal
   detection for Ctrl+Shift+V.
6. Wire auto-paste into the picker's activate handler for both text and image items.

## Success Criteria
- [ ] Copying an image under the cap stores it and shows a thumbnail in the picker.
- [ ] Images over the cap are skipped (verified via logs).
- [ ] Selecting a text item auto-pastes it into a focused editor.
- [ ] Selecting an image item auto-pastes it into an app that accepts image paste.
- [ ] Terminal focus receives Ctrl+Shift+V correctly.

## Risk Assessment
- `st_clipboard_get_content` image bug (#4034) may affect 49 → validate early; fallback:
  read `image/png` via `Meta.Selection.transfer_async` if St path misbehaves.
- Paste timing: firing before focus returns pastes into the shell → tune the idle delay;
  consider listening for focus change.
- Large images inflate RAM → downscale thumbnails and keep only one full-res copy per item.
