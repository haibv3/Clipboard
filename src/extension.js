/*
 * Clipboard — GNOME Shell extension
 * Smart clipboard manager for GNOME 49/50 (Wayland).
 *
 * Phase 1: panel indicator + clean enable/disable.
 * Later phases wire in the monitor, store, picker, pins, images, auto-paste.
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import St from 'gi://St';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { ClipboardStore } from './lib/store.js';
import { ClipboardMonitor } from './lib/monitor.js';
import { ClipboardPicker } from './lib/picker.js';
import { PinStorage } from './lib/storage.js';
import { PrivacyFilter } from './lib/privacy.js';
import { AutoPaster } from './lib/paste.js';

const IndicatorName = 'ClipboardIndicator';

const ClipboardExtension = GObject.registerClass(
class ClipboardExtension extends PanelMenu.Button {
    _init() {
        super._init(0.0, IndicatorName, false);

        this._icon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);
    }
});

export default class ClipboardShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // Core collaborators (created in enable, destroyed in disable).
        this._store = new ClipboardStore({ settings: this._settings });
        this._storage = new PinStorage();
        this._store.loadPinned(this._storage.load());

        // Persist pins automatically whenever the pinned set changes.
        this._store.connectPinsChanged((pins) => this._storage.save(pins));

        this._privacy = new PrivacyFilter();

        this._monitor = new ClipboardMonitor({
            settings: this._settings,
            privacy: this._privacy,
            onCapture: (item) => this._store.add(item),
        });
        this._monitor.start();

        this._paster = new AutoPaster({ settings: this._settings });

        this._picker = new ClipboardPicker({
            settings: this._settings,
            store: this._store,
            storage: this._storage,
            paster: this._paster,
            monitor: this._monitor,
        });

        // Panel indicator with a simple menu.
        this._indicator = new ClipboardExtension();
        this._buildIndicatorMenu();
        Main.panel.addToStatusArea(IndicatorName, this._indicator);

        // Global keybinding -> toggle picker.
        this._bindKeybinding();

        // Preferences "Clear history now" signal (prefs runs out-of-process).
        this._clearHandlerId = this._settings.connect('changed::clear-requested', () => {
            this._store.clear();
        });
    }

    disable() {
        // Release keybinding first.
        if (this._keybindingBound) {
            Main.wm.removeKeybinding('toggle-picker');
            this._keybindingBound = false;
        }

        if (this._clearHandlerId) {
            this._settings?.disconnect(this._clearHandlerId);
            this._clearHandlerId = 0;
        }

        // Persist pins before tearing down (flush the debounced save).
        if (this._storage && this._store) {
            this._storage.save(this._store.getPinned());
            this._storage.destroy();
        }

        this._picker?.destroy();
        this._picker = null;

        this._monitor?.destroy();
        this._monitor = null;

        this._paster?.destroy();
        this._paster = null;

        this._privacy = null;

        this._store?.destroy();
        this._store = null;

        this._storage = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
    }

    _bindKeybinding() {
        Main.wm.addKeybinding(
            'toggle-picker',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._togglePicker(),
        );
        this._keybindingBound = true;
    }

    _togglePicker() {
        if (this._picker.isOpen()) {
            this._picker.close();
        } else {
            this._picker.open();
        }
    }

    _buildIndicatorMenu() {
        // Read the current binding from GSettings so the label stays in sync
        // with whatever the user configured in Preferences. Convert the
        // GTK accelerator syntax (e.g. "<Super><Shift>v") into a
        // human-readable form (e.g. "Super+Shift+V").
        const bindings = this._settings.get_strv('toggle-picker');
        const accel = bindings.length > 0 ? bindings[0] : '<Super><Shift>v';
        // Split on '>' to get modifier tokens like "<Super", "<Shift", and
        // the trailing key. Strip leading '<', map Control→Ctrl, then join
        // with '+'. Capitalize the final key letter for readability.
        const tokens = accel.split('>').map((t) => t.trim()).filter(Boolean);
        const mods = tokens.slice(0, -1).map((t) =>
            t.replace(/^</, '').replace(/^Control$/, 'Ctrl'),
        );
        const rawKey = (tokens[tokens.length - 1] ?? '').replace(/^</, '');
        // Capitalize single letters; leave multi-char keys (F1, space, Tab)
        // with only the first letter uppercased for readability.
        const key = rawKey.length === 1
            ? rawKey.toUpperCase()
            : rawKey.charAt(0).toUpperCase() + rawKey.slice(1);
        const label = [...mods, key].filter(Boolean).join('+');
        const openItem = new PopupMenu.PopupMenuItem(`Open picker (${label})`);
        openItem.connect('activate', () => this._togglePicker());
        this._indicator.menu.addMenuItem(openItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const clearItem = new PopupMenu.PopupMenuItem('Clear history');
        clearItem.connect('activate', () => this._store.clear());
        this._indicator.menu.addMenuItem(clearItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.connect('activate', () => this.openPreferences());
        this._indicator.menu.addMenuItem(prefsItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Quit: fully disable the extension (removes indicator, keybinding,
        // monitor). The user re-enables it from gnome-extensions or the
        // Extensions app when needed. This is the GNOME-idiomatic "exit"
        // for an in-shell extension — there is no standalone process to kill.
        const quitItem = new PopupMenu.PopupMenuItem('Quit');
        quitItem.connect('activate', () => {
            try {
                Main.extensionManager.disableExtension(
                    this.uuid ?? 'clipboard@haibachvan.local',
                );
            } catch (e) {
                log(`[Clipboard] quit (disableExtension) failed: ${e}`);
            }
        });
        this._indicator.menu.addMenuItem(quitItem);
    }
}
