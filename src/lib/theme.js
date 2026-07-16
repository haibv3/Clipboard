/*
 * theme.js — runtime theming for the overlay picker.
 *
 * GNOME 47+ exposes the user's accent color and color-scheme via the
 * `org.gnome.desktop.interface` GSettings schema. St CSS does NOT support
 * CSS variables (`var(...)`), so we resolve the palette in JS and apply it
 * per-actor via `St.Widget.set_style(css)`. Structural rules (padding,
 * spacing, radius, shadow geometry) stay in stylesheet.css; colors are
 * injected here so the picker follows the system theme live.
 *
 * All GSettings access is wrapped defensively: on shells older than 47 the
 * `accent-color` key is absent, so we fall back to Adwaita blue.
 */

import Gio from 'gi://Gio';
import { error } from './log.js';

const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

// GNOME 47+ accent-color enum → brand hex values.
// Ubuntu/Yaru uses orange (#E95420) as its signature accent.
const ACCENT_HEX = {
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#e95420', // Ubuntu orange
    red: '#e62d42',
    pink: '#d56b99',
    purple: '#9141ac',
    slate: '#6f8396',
};

const DEFAULT_ACCENT = 'blue';

let _schema = null;

/**
 * Lazily fetch the interface schema singleton. Returns null if the schema is
 * not installed (very old/custom shells) so callers can fall back to defaults.
 */
function _getSchema() {
    if (_schema !== null) return _schema;
    try {
        // get_settings() is available on GNOME 46+; the older new GSettings(...)
        // path requires a source, so prefer the Gio accessor.
        _schema = Gio.Settings.new(INTERFACE_SCHEMA);
    } catch (e) {
        error(`theme: interface schema unavailable: ${e}`);
        _schema = null;
    }
    return _schema;
}

/** Parse "#rrggbb" → { r, g, b } (0–255 ints). Falls back to Adwaita blue. */
function _hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    if (!m) return { r: 53, g: 132, b: 228 };
    return {
        r: parseInt(m[1], 16),
        g: parseInt(m[2], 16),
        b: parseInt(m[3], 16),
    };
}

/** Build an "r,g,b,a" rgba() string from a hex color + alpha (0–1). */
function _rgba(hex, alpha = 1) {
    const { r, g, b } = _hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Resolve the full picker palette from the current system settings.
 * Returns a plain object; safe to call even if the schema is missing.
 */
export function getPalette() {
    const schema = _getSchema();

    let accentName = DEFAULT_ACCENT;
    let isDark = false;

    if (schema) {
        try {
            // `accent-color` is an enum string since GNOME 47.
            accentName = schema.get_string('accent-color') || DEFAULT_ACCENT;
        } catch (e) {
            accentName = DEFAULT_ACCENT;
        }
        try {
            // 0 = no preference/default, 1 = prefer-dark, 2 = prefer-light.
            isDark = schema.get_enum('color-scheme') === 1;
        } catch (e) {
            isDark = false;
        }
    }

    const accentHex = ACCENT_HEX[accentName] ?? ACCENT_HEX[DEFAULT_ACCENT];
    const accent = _hexToRgb(accentHex);

    if (isDark) {
        return {
            isDark: true,
            accent: { ...accent, hex: accentHex },
            // Surface hierarchy — card body, header/footer, search, hover.
            bg: 'rgba(31, 31, 33, 0.98)',
            bgSolid: '#1f1f21',
            bgHigh: '#2a2a2c',       // header + footer
            bgLow: '#0e0e10',        // search input (deepest)
            bgBright: '#39393b',     // row hover
            bgHighest: '#353437',    // thumbnail placeholder
            fg: '#e4e2e4',           // on-surface
            dim: '#c1c6d4',          // on-surface-variant (metadata, hints)
            card: 'transparent',
            cardHover: '#39393b',
            cardSelected: _rgba(accentHex, 0.15),
            cardSelectedBorder: accentHex,
            border: '#414752',       // outline-variant
            entryBg: '#0e0e10',
            entryFocusBg: _rgba(accentHex, 0.12),
            shadow: 'rgba(0, 0, 0, 0.60)',
            pin: '#f5c249',          // starred (amber)
            destructive: '#ffb4ab',  // error/destructive text
            destructiveHover: _rgba('#e62d42', 0.20),
        };
    }

    return {
        isDark: false,
        accent: { ...accent, hex: accentHex },
        bg: 'rgba(252, 252, 252, 0.98)',
        bgSolid: '#fcfcfc',
        bgHigh: '#f4f4f5',         // header + footer
        bgLow: '#ffffff',          // search input
        bgBright: '#eeedee',       // row hover
        bgHighest: '#e8e7e8',      // thumbnail placeholder
        fg: 'rgba(0, 0, 0, 0.88)',
        dim: 'rgba(0, 0, 0, 0.55)',
        card: 'transparent',
        cardHover: '#eeedee',
        cardSelected: _rgba(accentHex, 0.12),
        cardSelectedBorder: accentHex,
        border: 'rgba(0, 0, 0, 0.10)',
        entryBg: '#ffffff',
        entryFocusBg: _rgba(accentHex, 0.10),
        shadow: 'rgba(0, 0, 0, 0.25)',
        pin: '#c88800',
        destructive: '#c01c28',
        destructiveHover: _rgba('#e62d42', 0.12),
    };
}

/**
 * Watch the system theme for live changes (user toggles dark mode or switches
 * accent color while the picker is open). `cb` is called with a fresh palette.
 * Returns a disconnect function (no-op if the schema is unavailable).
 */
export function watch(cb) {
    if (typeof cb !== 'function') return () => {};
    const schema = _getSchema();
    if (!schema) return () => {};

    const handler = () => {
        try {
            cb(getPalette());
        } catch (e) {
            error(`theme watch callback error: ${e}`);
        }
    };

    const ids = [];
    try {
        ids.push(schema.connect('changed::color-scheme', handler));
    } catch (e) { /* key may not exist on old shells */ }
    try {
        ids.push(schema.connect('changed::accent-color', handler));
    } catch (e) { /* same as above */ }

    return () => {
        for (const id of ids) {
            try {
                schema.disconnect(id);
            } catch (e) { /* already disconnected */ }
        }
    };
}
