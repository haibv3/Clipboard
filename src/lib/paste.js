/*
 * paste.js — auto-paste the selected clipboard item into the focused app.
 *
 * After the overlay closes (releasing its modal grab), we wait a short tick for
 * focus to return to the previously focused app, then synthesize Ctrl+V via a
 * Clutter virtual keyboard device. Terminals receive Ctrl+Shift+V instead
 * (detected via the focused window's wm_class).
 *
 * This runs in-process inside gnome-shell, so it can drive a Clutter virtual
 * input device — something a standalone Wayland client cannot do.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

// Wayland needs real focus restoration time after popModal before we can
// synthesize keystrokes. 200ms for text, 350ms for images (large clipboard
// content takes longer to transfer to the focused app).
const PASTE_DELAY_MS_TEXT = 200;
const PASTE_DELAY_MS_IMAGE = 350;

// wm_class values that identify terminals (use Ctrl+Shift+V there).
const TERMINAL_WM_CLASSES = new Set([
    'gnome-terminal',
    'gnome-terminal-server',
    'kgx', // GNOME Console
    'xterm',
    'alacritty',
    'kitty',
    'org.wezfurlong.wezterm',
    'wezterm',
    'tmux',
    'urxvt',
    'terminator',
    'konsole',
    'foot',
    'footclient',
]);

export class AutoPaster {
    constructor({ settings } = {}) {
        this._settings = settings;
        this._timeoutId = 0;
        this._vk = null;
    }

    /**
     * Schedule a paste of the just-selected item after the overlay closes.
     * Honors the `auto-paste` GSettings key.
     */
    pasteAfterClose(item) {
        if (!this._settings?.get_boolean('auto-paste')) {
            log('[Clipboard] paste: auto-paste disabled');
            return;
        }
        const isImage = item?.type === 'image';
        const delay = isImage ? PASTE_DELAY_MS_IMAGE : PASTE_DELAY_MS_TEXT;
        log(`[Clipboard] paste: scheduling paste after close (delay=${delay}ms, isImage=${isImage})`);

        if (this._timeoutId !== 0) {
            GLib.source_remove(this._timeoutId);
        }
        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this._timeoutId = 0;
                this._doPaste();
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _isTerminalFocused() {
        try {
            const win = global.display?.get_focus_window?.();
            if (!win) return false;
            const wmClass = (win.get_wm_class?.() ?? '').toLowerCase();
            return TERMINAL_WM_CLASSES.has(wmClass);
        } catch (e) {
            log(`[Clipboard] terminal detect error: ${e}`);
            return false;
        }
    }

    _getVirtualKeyboard() {
        if (this._vk) return this._vk;
        try {
            const backend = Clutter.get_default_backend();
            const seat = backend.get_default_seat();
            this._vk = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE,
            );
            return this._vk;
        } catch (e) {
            log(`[Clipboard] virtual keyboard create error: ${e}`);
            return null;
        }
    }

    _doPaste() {
        const vk = this._getVirtualKeyboard();
        if (!vk) {
            log('[Clipboard] paste: no virtual keyboard');
            return;
        }

        const terminal = this._isTerminalFocused();
        log(`[Clipboard] paste: executing, terminal=${terminal}`);
        // Use the real compositor time, not Clutter.CURRENT_TIME (0).
        // Wayland rejects synthetic events with timestamp 0, so the paste
        // silently never reaches the focused surface.
        const time = global.get_current_time();
        const PRESSED = Clutter.KeyState.PRESSED;
        const RELEASED = Clutter.KeyState.RELEASED;

        try {
            vk.notify_keyval(time, Clutter.KEY_Control_L, PRESSED);
            if (terminal) {
                vk.notify_keyval(time, Clutter.KEY_Shift_L, PRESSED);
            }
            vk.notify_keyval(time, terminal ? Clutter.KEY_V : Clutter.KEY_v, PRESSED);
            vk.notify_keyval(time, terminal ? Clutter.KEY_V : Clutter.KEY_v, RELEASED);
            if (terminal) {
                vk.notify_keyval(time, Clutter.KEY_Shift_L, RELEASED);
            }
            vk.notify_keyval(time, Clutter.KEY_Control_L, RELEASED);
        } catch (e) {
            log(`[Clipboard] paste key synthesis error: ${e}`);
        }
    }

    destroy() {
        if (this._timeoutId !== 0) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._vk = null;
        this._settings = null;
    }
}
