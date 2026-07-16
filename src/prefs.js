/*
 * Preferences — GNOME Shell extension (ESM, Adwaita).
 */

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';

// --- Keybinding capture row ---
const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init({ settings, key }) {
        super._init({
            title: 'Toggle picker shortcut',
            subtitle: 'Press a key combination to rebind',
            activatable: true,
        });
        this._settings = settings;
        this._key = key;
        this._capturing = false;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: 'None',
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);
        this._syncLabel();

        this.connect('activated', () => this._startCapture());
    }

    _currentBinding() {
        const arr = this._settings.get_strv(this._key);
        return arr.length > 0 ? arr[0] : null;
    }

    _syncLabel() {
        this._label.set_accelerator(this._currentBinding() ?? '');
    }

    _startCapture() {
        if (this._capturing) return;
        this._capturing = true;
        this.set_subtitle('Press the new shortcut (Esc to cancel)');

        const controller = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        this.add_controller(controller);
        this._controller = controller;

        controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gtk.KEY_Escape) {
                this._stopCapture();
                return;
            }
            if (keyval === Gtk.KEY_BackSpace || keyval === Gtk.KEY_Delete) {
                this._settings.set_strv(this._key, []);
                this._syncLabel();
                this._stopCapture();
                return;
            }
            if (mods === 0) return;

            const accel = Gtk.accelerator_name_with_keyval(null, keyval, mods);
            this._settings.set_strv(this._key, [accel]);
            this._syncLabel();
            this._stopCapture();
        });

        this.grab_focus();
    }

    _stopCapture() {
        this._capturing = false;
        this.set_subtitle('Press a key combination to rebind');
        if (this._controller) {
            this.remove_controller(this._controller);
            this._controller = null;
        }
    }
});

/**
 * Multi-line strv editor: one entry per line, Apply writes to GSettings.
 */
function addStrvEditor(group, { settings, key, title, subtitle, placeholder }) {
    const row = new Adw.ActionRow({
        title,
        subtitle,
    });
    // Use an expander-like vertical box as suffix is awkward; put a frame below.
    group.add(row);

    const frame = new Gtk.Frame({
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 12,
    });
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 8,
        margin_end: 8,
    });

    const view = new Gtk.TextView({
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        accepts_tab: false,
        monospace: true,
        vexpand: false,
        height_request: 80,
    });
    const buffer = view.get_buffer();
    const existing = settings.get_strv(key);
    buffer.set_text(existing.join('\n'), -1);

    const scrolled = new Gtk.ScrolledWindow({
        child: view,
        min_content_height: 80,
        max_content_height: 160,
        vexpand: true,
        hexpand: true,
    });
    box.append(scrolled);

    if (placeholder) {
        box.append(new Gtk.Label({
            label: placeholder,
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            wrap: true,
        }));
    }

    const applyBtn = new Gtk.Button({
        label: 'Apply',
        halign: Gtk.Align.END,
        css_classes: ['suggested-action'],
    });
    applyBtn.connect('clicked', () => {
        const [start, end] = [buffer.get_start_iter(), buffer.get_end_iter()];
        const text = buffer.get_text(start, end, false);
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        settings.set_strv(key, lines);
    });
    box.append(applyBtn);
    frame.set_child(box);

    // Adw.PreferencesGroup only takes ActionRows cleanly; use a PreferencesGroup
    // with a custom widget via Adw.PreferencesGroup.add for Gtk.Widget in GTK4.
    group.add(frame);
}

export default class ClipboardPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Clipboard',
            icon_name: 'edit-paste-symbolic',
        });

        // --- General ---
        const general = new Adw.PreferencesGroup({ title: 'General' });

        general.add(new ShortcutRow({ settings, key: 'toggle-picker' }));

        const historyRow = new Adw.SpinRow({
            title: 'History size',
            subtitle: 'Maximum non-pinned items kept in memory',
            adjustment: new Gtk.Adjustment({
                lower: 5, upper: 50, step_increment: 1, page_increment: 5,
            }),
            digits: 0,
        });
        historyRow.set_value(settings.get_int('history-size'));
        historyRow.connect('changed', () =>
            settings.set_int('history-size', historyRow.get_value()));
        general.add(historyRow);

        const autoPasteRow = new Adw.SwitchRow({
            title: 'Auto-paste on select',
            subtitle: 'Synthesize Ctrl+V into the focused app after picking',
        });
        autoPasteRow.set_active(settings.get_boolean('auto-paste'));
        autoPasteRow.connect('notify::active', () =>
            settings.set_boolean('auto-paste', autoPasteRow.get_active()));
        general.add(autoPasteRow);

        const textDelay = new Adw.SpinRow({
            title: 'Text paste delay (ms)',
            subtitle: 'Wait after closing the picker before pasting text',
            adjustment: new Gtk.Adjustment({
                lower: 50, upper: 2000, step_increment: 50, page_increment: 100,
            }),
            digits: 0,
        });
        textDelay.set_value(settings.get_int('paste-delay-text-ms'));
        textDelay.connect('changed', () =>
            settings.set_int('paste-delay-text-ms', textDelay.get_value()));
        general.add(textDelay);

        const imageDelay = new Adw.SpinRow({
            title: 'Image paste delay (ms)',
            subtitle: 'Wait after closing the picker before pasting images',
            adjustment: new Gtk.Adjustment({
                lower: 50, upper: 2000, step_increment: 50, page_increment: 100,
            }),
            digits: 0,
        });
        imageDelay.set_value(settings.get_int('paste-delay-image-ms'));
        imageDelay.connect('changed', () =>
            settings.set_int('paste-delay-image-ms', imageDelay.get_value()));
        general.add(imageDelay);

        page.add(general);

        // --- Images ---
        const images = new Adw.PreferencesGroup({ title: 'Images' });

        const mbDefault = settings.get_int('max-image-bytes') / (1024 * 1024);
        const imageCapRow = new Adw.SpinRow({
            title: 'Max image size (MB)',
            subtitle: 'Images larger than this are skipped',
            adjustment: new Gtk.Adjustment({
                lower: 0.1, upper: 50, step_increment: 0.5, page_increment: 1,
            }),
            digits: 1,
        });
        imageCapRow.set_value(mbDefault);
        imageCapRow.connect('changed', () => {
            const mb = imageCapRow.get_value();
            settings.set_int('max-image-bytes', Math.round(mb * 1024 * 1024));
        });
        images.add(imageCapRow);

        const maxPinned = new Adw.SpinRow({
            title: 'Max pinned images',
            subtitle: 'Oldest image pin is evicted beyond this cap',
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 50, step_increment: 1, page_increment: 5,
            }),
            digits: 0,
        });
        maxPinned.set_value(settings.get_int('max-pinned-images'));
        maxPinned.connect('changed', () =>
            settings.set_int('max-pinned-images', maxPinned.get_value()));
        images.add(maxPinned);

        page.add(images);

        // --- Privacy ---
        const privacy = new Adw.PreferencesGroup({ title: 'Privacy' });

        const pauseRow = new Adw.SwitchRow({
            title: 'Pause capture',
            subtitle: 'Temporarily stop adding new clipboard items to history',
        });
        pauseRow.set_active(settings.get_boolean('capture-paused'));
        pauseRow.connect('notify::active', () =>
            settings.set_boolean('capture-paused', pauseRow.get_active()));
        privacy.add(pauseRow);

        page.add(privacy);

        const appDeny = new Adw.PreferencesGroup({
            title: 'App denylist',
            description: 'One window class substring per line (e.g. bitwarden, keepassxc). Copies from matching focused apps are skipped.',
        });
        addStrvEditor(appDeny, {
            settings,
            key: 'privacy-app-denylist',
            title: 'Blocked apps',
            subtitle: 'wm_class substrings',
            placeholder: 'Example: bitwarden',
        });
        page.add(appDeny);

        const textDeny = new Adw.PreferencesGroup({
            title: 'Text regex denylist',
            description: 'One JavaScript regex per line. Matching text is not stored. Invalid patterns are ignored.',
        });
        addStrvEditor(textDeny, {
            settings,
            key: 'privacy-text-denylist',
            title: 'Patterns',
            subtitle: 'Regex patterns',
            placeholder: 'Example: sk_live_[0-9a-zA-Z]+',
        });
        page.add(textDeny);

        // --- Maintenance ---
        const danger = new Adw.PreferencesGroup({ title: 'Maintenance' });

        const debugRow = new Adw.SwitchRow({
            title: 'Debug logging',
            subtitle: 'Write verbose capture traces to the system journal (may include clipboard previews)',
        });
        debugRow.set_active(settings.get_boolean('debug'));
        debugRow.connect('notify::active', () =>
            settings.set_boolean('debug', debugRow.get_active()));
        danger.add(debugRow);

        const clearRow = new Adw.ActionRow({
            title: 'Clear history now',
            subtitle: 'Removes all non-pinned items from memory',
        });
        const clearBtn = new Gtk.Button({
            label: 'Clear',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        clearBtn.connect('clicked', () => {
            settings.set_int('clear-requested', settings.get_int('clear-requested') + 1);
        });
        clearRow.add_suffix(clearBtn);
        danger.add(clearRow);

        page.add(danger);

        window.add(page);
        window.set_default_size(560, 720);
    }
}
