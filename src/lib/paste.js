/*
 * paste.js — auto-paste the selected clipboard item into the focused app.
 *
 * After the overlay closes, wait a short tick then synthesize Ctrl+V
 * (Ctrl+Shift+V in terminals) via a Clutter virtual keyboard device.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import { debug, error } from './log.js';

const TERMINAL_WM_CLASSES = new Set([
    'gnome-terminal',
    'gnome-terminal-server',
    'kgx',
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
     * Schedule a paste after the overlay closes. Honors auto-paste GSettings.
     */
    pasteAfterClose(item) {
        if (!this._settings?.get_boolean('auto-paste')) {
            debug('paste: auto-paste disabled');
            return;
        }
        const isImage = item?.type === 'image';
        const delay = isImage
            ? (this._settings?.get_int('paste-delay-image-ms') ?? 350)
            : (this._settings?.get_int('paste-delay-text-ms') ?? 200);
        debug(`paste: scheduling paste after close (delay=${delay}ms, isImage=${isImage})`);

        if (this._timeoutId !== 0)
            GLib.source_remove(this._timeoutId);
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
            error(`terminal detect error: ${e}`);
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
            error(`virtual keyboard create error: ${e}`);
            return null;
        }
    }

    _doPaste() {
        const vk = this._getVirtualKeyboard();
        if (!vk) {
            debug('paste: no virtual keyboard');
            return;
        }

        const terminal = this._isTerminalFocused();
        debug(`paste: executing, terminal=${terminal}`);
        const time = global.get_current_time();
        const PRESSED = Clutter.KeyState.PRESSED;
        const RELEASED = Clutter.KeyState.RELEASED;

        try {
            vk.notify_keyval(time, Clutter.KEY_Control_L, PRESSED);
            if (terminal)
                vk.notify_keyval(time, Clutter.KEY_Shift_L, PRESSED);
            vk.notify_keyval(time, terminal ? Clutter.KEY_V : Clutter.KEY_v, PRESSED);
            vk.notify_keyval(time, terminal ? Clutter.KEY_V : Clutter.KEY_v, RELEASED);
            if (terminal)
                vk.notify_keyval(time, Clutter.KEY_Shift_L, RELEASED);
            vk.notify_keyval(time, Clutter.KEY_Control_L, RELEASED);
        } catch (e) {
            error(`paste key synthesis error: ${e}`);
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
