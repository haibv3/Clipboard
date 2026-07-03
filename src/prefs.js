/*
 * Preferences — GNOME Shell extension (ESM, Adwaita).
 *
 * Phase 6: full preferences window with rows for the toggle shortcut,
 * history size, max image bytes, auto-paste toggle, and a "clear history
 * now" button.
 */

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

const SCHEMA = 'org.gnome.shell.extensions.clipboard';

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

        // Attach the key controller to the row itself (a focusable
        // Gtk.ListBoxRow), not to the Gtk.ShortcutLabel suffix — labels are
        // not focusable, so a controller on them never receives key events.
        // The row receives focus on activation; key events then bubble to
        // its controllers. The controller is created per-capture and removed
        // in _stopCapture to avoid intercepting keys while not capturing.
        const controller = new Gtk.EventControllerKey({
            propagation_phase: Gtk.PropagationPhase.CAPTURE,
        });
        this.add_controller(controller);
        this._controller = controller;

        controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            // Esc cancels.
            if (keyval === Gtk.KEY_Escape) {
                this._stopCapture();
                return;
            }
            // Backspace/Delete clears the binding.
            if (keyval === Gtk.KEY_BackSpace || keyval === Gtk.KEY_Delete) {
                this._settings.set_strv(this._key, []);
                this._syncLabel();
                this._stopCapture();
                return;
            }
            // Require a modifier (avoid binding a bare letter).
            if (mods === 0) return;

            const accel = Gtk.accelerator_name_with_keyval(null, keyval, mods);
            this._settings.set_strv(this._key, [accel]);
            this._syncLabel();
            this._stopCapture();
        });

        // Ensure the row holds focus so it receives key events.
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

export default class ClipboardPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Clipboard',
            icon_name: 'edit-paste-symbolic',
        });

        // --- General group ---
        const general = new Adw.PreferencesGroup({ title: 'General' });

        const shortcutRow = new ShortcutRow({ settings, key: 'toggle-picker' });
        general.add(shortcutRow);

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

        page.add(general);

        // --- Images group ---
        const images = new Adw.PreferencesGroup({ title: 'Images' });

        const imageCapRow = new Adw.SpinRow({
            title: 'Max image size (bytes)',
            subtitle: 'Images larger than this are skipped',
            adjustment: new Gtk.Adjustment({
                lower: 102400, upper: 52428800,
                step_increment: 102400, page_increment: 1048576,
            }),
            digits: 0,
        });
        imageCapRow.set_value(settings.get_int('max-image-bytes'));
        imageCapRow.connect('changed', () =>
            settings.set_int('max-image-bytes', imageCapRow.get_value()));
        images.add(imageCapRow);

        page.add(images);

        // --- Maintenance ---
        const danger = new Adw.PreferencesGroup({ title: 'Maintenance' });

        const clearRow = new Adw.ActionRow({
            title: 'Clear history now',
            subtitle: 'Removes all non-pinned items from memory',
        });
        const clearBtn = new Gtk.Button({
            label: 'Clear',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        // Clearing from prefs: prefs runs in a separate process and cannot
        // touch the live in-memory store directly. Increment a GSettings
        // counter; the running extension listens to `changed::clear-requested`
        // and clears its history.
        clearBtn.connect('clicked', () => {
            settings.set_int('clear-requested', settings.get_int('clear-requested') + 1);
        });
        clearRow.add_suffix(clearBtn);
        danger.add(clearRow);

        page.add(danger);

        window.add(page);
    }
}
