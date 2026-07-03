/*
 * picker.js — Super+V overlay picker.
 *
 * A centered modal overlay over the UI group showing the clipboard history
 * with: a title bar, a search entry, a scrollable list grouped into Pinned /
 * Recent sections (with empty / no-results states), a footer (Clear all +
 * count), keyboard navigation, and live updates from the store. Selecting an
 * item puts it back on the clipboard and closes the overlay. Auto-paste is
 * wired in Phase 5 via the `paster` collaborator.
 *
 * Theming follows the system color-scheme + accent color (GNOME 47+) at
 * runtime; see lib/theme.js. St CSS has no CSS variables, so colors are
 * resolved in JS and applied per-actor via set_style().
 */

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';

import * as Theme from './theme.js';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;

const MAX_PREVIEW = 80;
const ANIM_OPEN_MS = 220;
const ANIM_CLOSE_MS = 160;

export class ClipboardPicker {
    constructor({ settings, store, storage, paster, monitor } = {}) {
        this._settings = settings;
        this._store = store;
        this._storage = storage; // Phase 4: persist on pin toggle
        this._paster = paster; // Phase 5: auto-paste after close
        this._monitor = monitor; // used to setIgnoreNext on select

        this._actor = null;
        this._grab = null;
        this._searchEntry = null;
        this._listBox = null;
        this._countLabel = null;
        this._rows = []; // current rendered ITEM row actors (filtered), no headers
        this._highlighted = -1;
        this._storeChangedCb = null;
        this._closedResolve = null; // for post-close paste timing

        // Theming + chrome refs added in the GNOME-native refresh.
        this._palette = null;
        this._themeUnwatch = null;
        this._closing = false;
        this._titlebar = null;
        this._closeBtn = null;
        this._emptyState = null;
        this._scroll = null;
        this._footer = null;
        this._clearAllBtn = null;
    }

    isOpen() {
        return this._actor !== null;
    }

    open() {
        if (this.isOpen()) return;

        this._closing = false;
        this._palette = Theme.getPalette();
        this._build();

        // Start hidden for the open animation; pivot at center so the scale
        // animates from the middle of the window.
        this._actor.set_opacity(0);
        this._actor.set_scale(0.96, 0.96);
        this._actor.set_pivot_point(0.5, 0.5);

        Main.layoutManager.uiGroup.add_child(this._actor);

        const timestamp = global.get_current_time();
        this._grab = Main.pushModal(this._actor, { timestamp });
        // pushModal can return null if another modal already holds the grab
        // or the seat doesn't support keyboard grabs. In that case the overlay
        // would be visible but non-interactive (no Esc/Enter/typing) — tear it
        // down immediately rather than stranding the user.
        if (!this._grab) {
            log('[Clipboard] pushModal failed; aborting picker open');
            Main.layoutManager.uiGroup.remove_child(this._actor);
            this._actor.destroy();
            this._actor = null;
            this._rows = [];
            this._highlighted = -1;
            this._teardownThemeWatch();
            return;
        }
        this._searchEntry.grab_key_focus();

        // Re-theme live if the user toggles dark mode / accent while open.
        this._themeUnwatch = Theme.watch((palette) => {
            this._palette = palette;
            this._applyTheme();
        });

        this._storeChangedCb = this._store.connectChanged(() => this._render());
        this._render();
        this._applyTheme();

        // Animate in — ease-out for a natural deceleration feel.
        this._actor.ease({
            opacity: 255,
            scale_x: 1.0,
            scale_y: 1.0,
            duration: ANIM_OPEN_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    close() {
        if (!this.isOpen() || this._closing) return;
        this._closing = true;

        if (this._storeChangedCb) {
            this._storeChangedCb();
            this._storeChangedCb = null;
        }

        this._teardownThemeWatch();

        // Release the modal grab BEFORE animating so focus returns to the
        // previously focused app right away (the paster relies on this).
        try {
            if (this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            }
        } catch (e) {
            log(`[Clipboard] popModal error: ${e}`);
            this._grab = null;
        }

        const actor = this._actor;
        // Mark closed immediately so isOpen() is truthful during the close
        // animation and a re-open can't race with the teardown.
        this._actor = null;
        this._rows = [];
        this._highlighted = -1;

        if (actor) {
            actor.ease({
                opacity: 0,
                scale_x: 0.96,
                scale_y: 0.96,
                duration: ANIM_CLOSE_MS,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    Main.layoutManager.uiGroup.remove_child(actor);
                    actor.destroy();
                },
            });
        }
    }

    destroy() {
        this.close();
        this._store = null;
        this._paster = null;
        this._monitor = null;
        this._storage = null;
        this._settings = null;
    }

    _teardownThemeWatch() {
        if (this._themeUnwatch) {
            this._themeUnwatch();
            this._themeUnwatch = null;
        }
    }

    // --- Build the actor tree ---

    _build() {
        this._actor = new St.BoxLayout({
            name: 'clipboard-picker',
            style_class: 'clipboard-picker',
            vertical: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Center within the primary monitor via constraints.
        // Width: 480px is comfortable for previews + the title bar. Cap at 28%
        // of monitor width so it never dominates the screen on large displays,
        // and allow it to shrink on small displays (e.g. 1366px laptop).
        const primary = Main.layoutManager.primaryMonitor;
        const width = Math.min(480, Math.floor(primary.width * 0.28));
        const height = Math.min(600, Math.floor(primary.height * 0.68));
        this._actor.set_size(width, height);

        // --- Title bar (libadwaita-style header) ---
        this._titlebar = new St.BoxLayout({
            style_class: 'clipboard-titlebar',
            x_expand: true,
        });
        const titleIcon = new St.Icon({
            icon_name: 'edit-paste-symbolic',
            icon_size: 18,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titlebar.add_child(titleIcon);
        // Title + subtitle stacked vertically for a richer header.
        const titleBox = new St.BoxLayout({
            style_class: 'clipboard-title-box',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({
            style_class: 'clipboard-title',
            text: 'Clipboard',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleBox.add_child(title);
        this._subtitle = new St.Label({
            style_class: 'clipboard-subtitle',
            text: 'Recent items',
        });
        titleBox.add_child(this._subtitle);
        this._titlebar.add_child(titleBox);
        this._closeBtn = new St.Button({
            style_class: 'clipboard-close button',
            can_focus: true,
            child: new St.Icon({ icon_name: 'window-close-symbolic', icon_size: 16 }),
        });
        this._closeBtn.connect('clicked', () => this.close());
        this._titlebar.add_child(this._closeBtn);
        this._actor.add_child(this._titlebar);

        // --- Search entry ---
        this._searchEntry = new St.Entry({
            style_class: 'clipboard-search-entry',
            hint_text: 'Search clipboard…',
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        // Leading search icon inside the entry.
        this._searchEntry.set_primary_icon(new St.Icon({
            icon_name: 'system-search-symbolic',
            icon_size: 14,
        }));
        const entryClutterText = this._searchEntry.clutter_text;
        entryClutterText.connect('text-changed', () => this._onSearchChanged());
        this._actor.add_child(this._searchEntry);

        // --- Scrollable list ---
        this._scroll = new St.ScrollView({
            style_class: 'clipboard-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._listBox = new St.BoxLayout({
            style_class: 'clipboard-list',
            vertical: true,
            x_expand: true,
        });
        this._scroll.set_child(this._listBox);
        this._actor.add_child(this._scroll);

        // --- Footer ---
        this._footer = new St.BoxLayout({
            style_class: 'clipboard-footer',
            x_expand: true,
        });
        this._countLabel = new St.Label({ style_class: 'clipboard-count', text: '0 items' });
        this._countLabel.set_x_expand(true);
        this._countLabel.set_y_align(Clutter.ActorAlign.CENTER);
        this._footer.add_child(this._countLabel);

        this._clearAllBtn = new St.Button({
            style_class: 'clipboard-clear-all button',
            label: 'Clear all',
            can_focus: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clearAllBtn.connect('clicked', () => {
            this._store.clear();
        });
        this._footer.add_child(this._clearAllBtn);
        this._actor.add_child(this._footer);

        // Key handling on the modal actor.
        this._actor.connect('key-press-event', (_a, event) =>
            this._onKeyPress(event),
        );
    }

    // --- Rendering ---

    _filteredItems() {
        const query = (this._searchEntry?.get_text() ?? '').trim().toLowerCase();
        const items = this._store.getItems();
        if (!query) return items;
        return items.filter((it) => {
            if (it.type === 'text') return (it.text ?? '').toLowerCase().includes(query);
            return it.type === 'image'; // images always match (no text to filter)
        });
    }

    _render() {
        if (!this.isOpen()) return;

        // Clear existing rows (items + headers + empty state).
        this._listBox.destroy_all_children();
        this._rows = [];
        this._emptyState = null;

        const items = this._filteredItems();
        const hasQuery = (this._searchEntry?.get_text() ?? '').trim().length > 0;

        if (items.length === 0) {
            // Empty history vs. no search match — different copy.
            if (hasQuery) {
                this._emptyState = this._makeEmptyState(
                    'system-search-symbolic',
                    'No matching items',
                    'Try a different search',
                );
            } else {
                this._emptyState = this._makeEmptyState(
                    'edit-paste-symbolic',
                    'Clipboard is empty',
                    'Copied items will appear here',
                );
            }
            this._listBox.add_child(this._emptyState);
        } else {
            // Group into Pinned (first) then Recent, mirroring store order.
            const pinned = items.filter((it) => it.pinned);
            const recent = items.filter((it) => !it.pinned);

            if (pinned.length > 0) {
                this._listBox.add_child(this._makeSectionHeader('Pinned'));
                for (const item of pinned) {
                    const row = this._makeRow(item);
                    this._listBox.add_child(row);
                    this._rows.push(row);
                }
            }
            if (recent.length > 0) {
                if (pinned.length > 0) {
                    // Spacer between sections.
                    this._listBox.add_child(this._makeSectionSpacer());
                }
                this._listBox.add_child(this._makeSectionHeader('Recent'));
                for (const item of recent) {
                    const row = this._makeRow(item);
                    this._listBox.add_child(row);
                    this._rows.push(row);
                }
            }
        }

        this._countLabel.set_text(`${items.length} item${items.length === 1 ? '' : 's'}`);

        // Update the subtitle to reflect the current view state.
        if (this._subtitle) {
            if (hasQuery) {
                this._subtitle.set_text(`${items.length} match${items.length === 1 ? '' : 'es'}`);
            } else {
                const pinnedCount = items.filter((it) => it.pinned).length;
                const recentCount = items.length - pinnedCount;
                const parts = [];
                if (pinnedCount > 0) parts.push(`${pinnedCount} pinned`);
                if (recentCount > 0) parts.push(`${recentCount} recent`);
                this._subtitle.set_text(parts.length > 0 ? parts.join(' · ') : 'Recent items');
            }
        }

        this._highlighted = items.length > 0 ? 0 : -1;
        this._applyHighlight();
        this._applyTheme();
    }

    _makeSectionHeader(text) {
        return new St.Label({
            style_class: 'clipboard-section-header',
            text,
            x_expand: true,
        });
    }

    _makeSectionSpacer() {
        return new St.BoxLayout({ style_class: 'clipboard-section-spacer' });
    }

    _makeEmptyState(iconName, title, subtitle) {
        const box = new St.BoxLayout({
            style_class: 'clipboard-empty',
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(new St.Icon({
            style_class: 'clipboard-empty-icon',
            icon_name: iconName,
            icon_size: 48,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            style_class: 'clipboard-empty-title',
            text: title,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            style_class: 'clipboard-empty-sub',
            text: subtitle,
            x_align: Clutter.ActorAlign.CENTER,
        }));
        return box;
    }

    _makeRow(item) {
        // Use a St.Button for the row so it reliably receives click events.
        // St.BoxLayout with reactive=true does NOT reliably get
        // button-release-event when children (St.Label/St.Icon) are not
        // reactive — the event gets eaten by the clutter input pipeline.
        // St.Button has built-in click handling that works regardless of
        // child reactivity.
        const row = new St.Button({
            style_class: 'clipboard-row',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            button_mask: St.ButtonMask.ONE,
        });
        row._itemId = item.id;

        // Inner layout box holds the actual content (thumb + preview + actions).
        const inner = new St.BoxLayout({
            style_class: 'clipboard-row-inner',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.set_child(inner);

        // Image thumbnail goes first (left side) for visual scanning.
        if (item.type === 'image' && item.thumbBytes) {
            this._addThumbnail(inner, item.thumbBytes);
        } else if (item.type === 'image') {
            // Fallback icon when no thumbnail bytes are available.
            inner.add_child(new St.Icon({
                icon_name: 'image-x-generic-symbolic',
                icon_size: 28,
                style_class: 'clipboard-row-thumb-placeholder',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        // Preview content.
        let previewText;
        if (item.type === 'text') {
            previewText = (item.text ?? '').replace(/\s+/g, ' ').trim();
            if (previewText.length > MAX_PREVIEW) {
                previewText = previewText.slice(0, MAX_PREVIEW) + '…';
            }
            if (previewText.length === 0) previewText = '(empty)';
        } else {
            previewText = `Image · ${item.width}×${item.height}`;
        }

        const preview = new St.Label({
            style_class: 'clipboard-row-preview',
            text: previewText,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        inner.add_child(preview);

        // Pin toggle.
        const pinIcon = item.pinned ? 'starred-symbolic' : 'non-starred-symbolic';
        const pinBtn = new St.Button({
            style_class: 'clipboard-row-pin button',
            can_focus: false,
            track_hover: false,
            child: new St.Icon({ icon_name: pinIcon, icon_size: 15 }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        pinBtn.connect('clicked', () => {
            log(`[Clipboard] pin clicked for item ${item.id}`);
            row._childActionFired = true;
            this._store.togglePin(item.id);
        });
        inner.add_child(pinBtn);

        // Delete (×).
        const delBtn = new St.Button({
            style_class: 'clipboard-row-delete button',
            can_focus: false,
            track_hover: false,
            child: new St.Icon({ icon_name: 'user-trash-symbolic', icon_size: 15 }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        delBtn.connect('clicked', () => {
            log(`[Clipboard] delete clicked for item ${item.id}`);
            row._childActionFired = true;
            this._store.remove(item.id);
        });
        inner.add_child(delBtn);

        // Activate on row click (St.Button's `clicked` signal).
        // A flag on the row is set by pin/delete handlers so we can skip
        // activation when the click was consumed by a child action button.
        // St.Button's clicked fires AFTER children's clicked, so the flag
        // is already set by the time we get here.
        row.connect('clicked', () => {
            if (row._childActionFired) {
                row._childActionFired = false;
                return;
            }
            log(`[Clipboard] row clicked → activating item ${item.id}`);
            this._activate(item.id);
        });

        return row;
    }

    _addThumbnail(row, thumbBytes) {
        // Render a real thumbnail via Gio.BytesIcon.
        try {
            const icon = new St.Icon({
                gicon: Gio.BytesIcon.new(thumbBytes),
                icon_size: 36,
                style_class: 'clipboard-row-thumb',
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.insert_child_at_index(icon, 0);
        } catch (e) {
            log(`[Clipboard] thumbnail render error: ${e}`);
        }
    }

    // --- Dynamic theming ---

    /**
     * Apply the current palette to every themed actor. St CSS does not cascade
     * from the window, so we set colors explicitly on each node. Called on
     * open, on every re-render, and whenever the system theme changes.
     */
    _applyTheme() {
        if (!this.isOpen() || !this._palette) return;
        const p = this._palette;

        // Window chrome — Ubuntu/Yaru uses a slightly larger radius and
        // a softer, deeper shadow for a floating-card feel.
        this._actor.set_style(
            `background-color: ${p.bg};` +
            `border: 1px solid ${p.border};` +
            `color: ${p.fg};` +
            `box-shadow: 0 16px 40px ${p.shadow}, 0 2px 8px ${p.shadow};`,
        );

        // Title bar.
        this._titlebar?.set_style(
            `color: ${p.fg};` +
            `border-bottom: 1px solid ${p.border};`,
        );
        // Subtitle in the header.
        this._subtitle?.set_style(`color: ${p.dim};`);
        // Close button.
        this._closeBtn?.set_style(`color: ${p.dim};`);

        // Search entry.
        this._searchEntry?.set_style(
            `background-color: ${p.entryBg};` +
            `border: 1px solid ${p.border};` +
            `color: ${p.fg};`,
        );

        // Footer.
        this._footer?.set_style(
            `color: ${p.dim};` +
            `border-top: 1px solid ${p.border};`,
        );
        this._countLabel?.set_style(`color: ${p.dim};`);
        // Clear-all button gets a subtle destructive tint on hover.
        this._clearAllBtn?.set_style(`color: ${p.dim};`);

        // Rows + headers + empty state live inside the list box.
        const children = this._listBox?.get_children() ?? [];
        for (const child of children) {
            if (child === this._emptyState) {
                this._themeEmptyState(child);
            } else if (child.has_style_class_name('clipboard-section-header')) {
                child.set_style(`color: ${p.dim};`);
            } else if (child.has_style_class_name('clipboard-row')) {
                this._themeRow(child);
            }
        }
    }

    _themeRow(row) {
        const p = this._palette;
        const selected = row.has_style_pseudo_class('selected');
        const hovered = row.has_style_pseudo_class('hover');
        const pinned = row._itemId
            ? !!this._store.getItem(row._itemId)?.pinned
            : false;

        // Layered background: base card → hover → selected (highest priority).
        let bg = p.card;
        if (hovered && !selected) bg = p.cardHover;
        if (selected) bg = p.cardSelected;

        // Selected rows get an accent left edge; pinned rows (unselected) keep
        // a subtle amber marker so the section grouping reads at a glance.
        let borderLeft = 'none';
        if (selected) {
            borderLeft = `3px solid ${p.cardSelectedBorder}`;
        } else if (pinned) {
            borderLeft = `3px solid ${p.pin}`;
        }

        row.set_style(
            `background-color: ${bg};` +
            `border-left: ${borderLeft};` +
            `color: ${p.fg};`,
        );

        // Row is now a St.Button; its child is the inner BoxLayout.
        const inner = row.get_child();
        const innerChildren = inner ? inner.get_children() : [];

        // Tint the pin icon amber when pinned, dim otherwise.
        const pinBtn = innerChildren.find((c) =>
            c.has_style_class_name?.('clipboard-row-pin'));
        pinBtn?.set_style(`color: ${pinned ? p.pin : p.dim};`);

        // Delete + preview color.
        const delBtn = innerChildren.find((c) =>
            c.has_style_class_name?.('clipboard-row-delete'));
        delBtn?.set_style(`color: ${p.dim};`);
    }

    _themeEmptyState(box) {
        const p = this._palette;
        for (const child of box.get_children()) {
            if (child.has_style_class_name('clipboard-empty-icon')) {
                child.set_style(`color: ${p.dim};`);
            } else if (child.has_style_class_name('clipboard-empty-title')) {
                child.set_style(`color: ${p.fg};`);
            } else if (child.has_style_class_name('clipboard-empty-sub')) {
                child.set_style(`color: ${p.dim};`);
            }
        }
    }

    // --- Keyboard navigation ---

    _onSearchChanged() {
        this._render();
    }

    _onKeyPress(event) {
        const key = event.get_key_symbol();
        const items = this._filteredItems();

        switch (key) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            if (this._highlighted >= 0 && this._highlighted < items.length) {
                this._activate(items[this._highlighted].id);
            }
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Down:
            if (this._highlighted < items.length - 1) {
                this._highlighted += 1;
                this._applyHighlight();
                this._scrollToHighlighted();
            }
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Up:
            if (this._highlighted > 0) {
                this._highlighted -= 1;
                this._applyHighlight();
                this._scrollToHighlighted();
            }
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Delete:
        case Clutter.KEY_KP_Delete:
            if (this._highlighted >= 0 && this._highlighted < items.length) {
                const id = items[this._highlighted].id;
                this._store.remove(id);
            }
            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _applyHighlight() {
        for (let i = 0; i < this._rows.length; i++) {
            const row = this._rows[i];
            if (i === this._highlighted) {
                row.add_style_pseudo_class('selected');
            } else {
                row.remove_style_pseudo_class('selected');
            }
        }
        this._applyTheme();
    }

    _scrollToHighlighted() {
        if (this._highlighted < 0 || this._highlighted >= this._rows.length) return;
        const row = this._rows[this._highlighted];
        // Ensure the highlighted row is visible in the scroll view.
        const adjust = this._listBox.get_parent()?.get_vadjustment?.();
        if (adjust) {
            const y = row.get_allocation_box().y1;
            const h = row.get_allocation_box().get_height();
            const page = adjust.get_page_size();
            const value = adjust.get_value();
            if (y < value) adjust.set_value(y);
            else if (y + h > value + page) adjust.set_value(y + h - page);
        }
    }

    // --- Activation (select + copy + close) ---

    _activate(id) {
        const item = this._store.getItem(id);
        if (!item) {
            log(`[Clipboard] _activate: item ${id} not found`);
            return;
        }
        log(`[Clipboard] _activate: type=${item.type}, text="${item.text?.substring(0, 40) ?? ''}", hasBytes=${!!item.bytes}`);

        const clip = St.Clipboard.get_default();
        if (item.type === 'text') {
            clip.set_text(CLIPBOARD, item.text ?? '');
            log('[Clipboard] _activate: set_text done');
        } else if (item.type === 'image' && item.bytes) {
            // set_content with large image bytes can block; wrap in try/catch
            // to prevent a crash from taking down the whole shell.
            try {
                clip.set_content(CLIPBOARD, 'image/png', item.bytes);
                log('[Clipboard] _activate: set_content done');
            } catch (e) {
                log(`[Clipboard] _activate: set_content error: ${e}`);
            }
        } else {
            log(`[Clipboard] _activate: nothing to set (type=${item.type}, bytes=${!!item.bytes})`);
        }

        // Prevent the monitor from re-capturing the item we just set.
        // For images, set_content may trigger multiple owner-changed events
        // (GNOME Shell sometimes fires twice for binary content), so ignore
        // a few extra events to avoid re-capturing the image we just pasted.
        this._monitor?.setIgnoreNext();
        if (item.type === 'image') {
            this._monitor?.setIgnoreNext();
            this._monitor?.setIgnoreNext();
        }

        this.close();

        // Phase 5: auto-paste into the previously focused app.
        if (this._paster) {
            log('[Clipboard] _activate: calling paster.pasteAfterClose');
            this._paster.pasteAfterClose(item);
        } else {
            log('[Clipboard] _activate: no paster available');
        }
    }
}
