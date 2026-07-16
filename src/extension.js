/*
 * Clipboard — GNOME Shell extension
 * Smart clipboard manager for GNOME 49/50 (Wayland).
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import St from 'gi://St';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GLib from 'gi://GLib';

import { ClipboardStore } from './lib/store.js';
import { ClipboardMonitor } from './lib/monitor.js';
import { ClipboardPicker } from './lib/picker.js';
import { PinStorage } from './lib/storage.js';
import { PrivacyFilter } from './lib/privacy.js';
import { AutoPaster } from './lib/paste.js';
import { init as initLog, teardown as teardownLog, error, debug } from './lib/log.js';

const IndicatorName = 'ClipboardIndicator';
const RECENT_MENU_COUNT = 5;
const MAX_MENU_PREVIEW = 42;

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

    setPausedIcon(paused) {
        this._icon.icon_name = paused
            ? 'media-playback-pause-symbolic'
            : 'edit-paste-symbolic';
    }
});

export default class ClipboardShellExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        initLog(this._settings);

        this._store = new ClipboardStore({ settings: this._settings });
        this._storage = new PinStorage({ settings: this._settings });
        this._store.loadPinned(this._storage.load());
        this._store.connectPinsChanged((pins) => this._storage.save(pins));

        this._privacy = new PrivacyFilter({ settings: this._settings });

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

        this._indicator = new ClipboardExtension();
        this._buildIndicatorMenu();
        Main.panel.addToStatusArea(IndicatorName, this._indicator);

        this._bindKeybinding();

        this._clearHandlerId = this._settings.connect('changed::clear-requested', () => {
            this._store.clear();
        });
        this._pausedHandlerId = this._settings.connect('changed::capture-paused', () => {
            this._syncPausedUi();
        });
        this._hotkeyHandlerId = this._settings.connect('changed::toggle-picker', () => {
            this._updateOpenLabel();
        });
        this._syncPausedUi();
    }

    disable() {
        if (this._keybindingBound) {
            Main.wm.removeKeybinding('toggle-picker');
            this._keybindingBound = false;
        }

        if (this._clearHandlerId) {
            this._settings?.disconnect(this._clearHandlerId);
            this._clearHandlerId = 0;
        }
        if (this._pausedHandlerId) {
            this._settings?.disconnect(this._pausedHandlerId);
            this._pausedHandlerId = 0;
        }
        if (this._hotkeyHandlerId) {
            this._settings?.disconnect(this._hotkeyHandlerId);
            this._hotkeyHandlerId = 0;
        }
        if (this._clearConfirmTimeout) {
            GLib.source_remove(this._clearConfirmTimeout);
            this._clearConfirmTimeout = 0;
        }

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

        teardownLog();
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
        if (this._picker.isOpen())
            this._picker.close();
        else
            this._picker.open();
    }

    _formatAccelLabel() {
        const bindings = this._settings.get_strv('toggle-picker');
        const accel = bindings.length > 0 ? bindings[0] : '<Super><Shift>v';
        const tokens = accel.split('>').map((t) => t.trim()).filter(Boolean);
        const mods = tokens.slice(0, -1).map((t) =>
            t.replace(/^</, '').replace(/^Control$/, 'Ctrl'),
        );
        const rawKey = (tokens[tokens.length - 1] ?? '').replace(/^</, '');
        const key = rawKey.length === 1
            ? rawKey.toUpperCase()
            : rawKey.charAt(0).toUpperCase() + rawKey.slice(1);
        return [...mods, key].filter(Boolean).join('+');
    }

    _updateOpenLabel() {
        if (this._openItem)
            this._openItem.label.set_text(`Open picker (${this._formatAccelLabel()})`);
    }

    _syncPausedUi() {
        const paused = this._settings?.get_boolean('capture-paused') ?? false;
        this._indicator?.setPausedIcon(paused);
        if (this._pauseItem) {
            this._pauseItem.setToggleState(paused);
            this._pauseItem.label.set_text(paused ? 'Resume capture' : 'Pause capture');
        }
    }

    _previewText(item) {
        if (item.type === 'image')
            return `🖼 ${item.width}×${item.height}`;
        let t = (item.text ?? '').replace(/\s+/g, ' ').trim();
        if (!t) t = '(empty)';
        if (t.length > MAX_MENU_PREVIEW)
            t = `${t.slice(0, MAX_MENU_PREVIEW)}…`;
        return t;
    }

    /**
     * Set clipboard from a history item without auto-paste (panel menu path).
     */
    _copyItemToClipboard(item) {
        const clip = St.Clipboard.get_default();
        if (item.type === 'text') {
            clip.set_text(St.ClipboardType.CLIPBOARD, item.text ?? '');
        } else if (item.type === 'image' && item.bytes) {
            try {
                clip.set_content(St.ClipboardType.CLIPBOARD, 'image/png', item.bytes);
            } catch (e) {
                error(`panel set_content error: ${e}`);
            }
        }
        this._monitor?.setIgnoreNext();
        if (item.type === 'image') {
            this._monitor?.setIgnoreNext();
            this._monitor?.setIgnoreNext();
        }
        debug('panel: copied item to clipboard (no auto-paste)');
    }

    _onClearHistoryMenu() {
        if (this._clearConfirmTimeout) {
            GLib.source_remove(this._clearConfirmTimeout);
            this._clearConfirmTimeout = 0;
            this._store.clear();
            this._clearItem.label.set_text('Clear history');
            return;
        }
        this._clearItem.label.set_text('Click again to confirm');
        this._clearConfirmTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._clearConfirmTimeout = 0;
            if (this._clearItem)
                this._clearItem.label.set_text('Clear history');
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuildRecentSection() {
        // Remove previous dynamic items.
        for (const item of this._recentItems ?? [])
            item.destroy();
        this._recentItems = [];

        if (!this._recentSection || !this._store) return;

        const items = this._store.getItems().slice(0, RECENT_MENU_COUNT);
        if (items.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No recent items', { reactive: false });
            empty.setSensitive(false);
            this._recentSection.addMenuItem(empty);
            this._recentItems.push(empty);
            return;
        }

        for (const it of items) {
            const label = this._previewText(it);
            const menuItem = new PopupMenu.PopupMenuItem(label);
            menuItem.connect('activate', () => this._copyItemToClipboard(it));
            this._recentSection.addMenuItem(menuItem);
            this._recentItems.push(menuItem);
        }
    }

    _buildIndicatorMenu() {
        this._openItem = new PopupMenu.PopupMenuItem(
            `Open picker (${this._formatAccelLabel()})`,
        );
        this._openItem.connect('activate', () => this._togglePicker());
        this._indicator.menu.addMenuItem(this._openItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Recent items section (rebuilt each time the menu opens).
        this._recentSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._recentSection);
        this._recentItems = [];
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._rebuildRecentSection();
        });

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._pauseItem = new PopupMenu.PopupSwitchMenuItem('Pause capture', false);
        this._pauseItem.connect('toggled', (_item, state) => {
            this._settings.set_boolean('capture-paused', state);
        });
        this._indicator.menu.addMenuItem(this._pauseItem);

        this._clearItem = new PopupMenu.PopupMenuItem('Clear history');
        this._clearItem.connect('activate', () => this._onClearHistoryMenu());
        this._indicator.menu.addMenuItem(this._clearItem);

        const prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        prefsItem.connect('activate', () => this.openPreferences());
        this._indicator.menu.addMenuItem(prefsItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const quitItem = new PopupMenu.PopupMenuItem('Quit');
        quitItem.connect('activate', () => {
            try {
                Main.extensionManager.disableExtension(
                    this.uuid ?? 'clipboard@haibachvan.local',
                );
            } catch (e) {
                error(`quit (disableExtension) failed: ${e}`);
            }
        });
        this._indicator.menu.addMenuItem(quitItem);

        this._syncPausedUi();
    }
}
