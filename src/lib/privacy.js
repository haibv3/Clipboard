/*
 * privacy.js — privacy filter for clipboard capture.
 *
 * Before storing a clipboard entry, the monitor asks this filter whether the
 * current selection should be skipped. We inspect the offered mimetypes via
 * `Meta.Selection.get_mimetypes` and skip content flagged as sensitive /
 * concealed (password managers) or as file cut/copy operations.
 *
 * Limitation: not all password managers set a hint mimetype. A configurable
 * regex denylist can be added later (non-goal for v1 core).
 */

import Meta from 'gi://Meta';

const SELECTION_CLIPBOARD = Meta.SelectionType.SELECTION_CLIPBOARD;

// Mimetypes that mark sensitive / concealed clipboard content.
const SENSITIVE_MIMETYPES = new Set([
    'x-kde-passwordManagerHint',
    'application/x-kde-passwordManagerHint',
    'x-kde-secret',
    'application/x-kde-secret',
    'application/x-gnome-password-manager-hint',
    'password-manager-hint',
    'concealed',
    'application/x-concealed',
]);

// File cut/copy (Nautilus) — not real text content we want to recall.
// Note: `text/uri-list` is intentionally NOT included here, because browsers
// and other apps offer it alongside `text/plain` when copying a URL, and the
// plan treats links as plain text (no special link handling in v1). Including
// it would silently drop legitimate URL copies.
const FILE_OP_MIMETYPES = new Set([
    'application/x-nautilus-clipboard',
    'x-special/gnome-copied-files',
]);

export class PrivacyFilter {
    /**
     * Returns true if the current clipboard selection should be skipped
     * (not stored). `selection` is the `Meta.Selection` object from
     * `global.display.get_selection()`.
     */
    shouldSkip(selection) {
        if (!selection) return false;

        let mimetypes = [];
        try {
            mimetypes = selection.get_mimetypes(SELECTION_CLIPBOARD) ?? [];
        } catch (e) {
            // If we can't read mimetypes, don't block — fall through to allow.
            log(`[Clipboard] get_mimetypes failed: ${e}`);
            return false;
        }

        // Sensitive mimetypes always skip (password managers), even if an
        // image is also offered — a password manager screenshot is unlikely
        // and the risk of storing a secret outweighs the convenience.
        for (const mt of mimetypes) {
            const lower = (mt ?? '').toLowerCase();
            if (SENSITIVE_MIMETYPES.has(lower) || SENSITIVE_MIMETYPES.has(mt)) {
                return true;
            }
            if (lower.includes('password') || lower.includes('secret') || lower.includes('concealed')) {
                return true;
            }
        }

        // File cut/copy (Nautilus) — skip UNLESS image/png is also offered.
        // GNOME Screenshot copies the image as image/png AND may also offer
        // x-special/gnome-copied-files (file reference). In that case the
        // image is the primary content we want to capture, not a file op.
        const hasImage = mimetypes.some(
            (mt) => (mt ?? '').toLowerCase() === 'image/png',
        );
        if (hasImage) {
            log('[Clipboard] image/png offered, allowing despite file-op mimetypes');
            return false;
        }

        for (const mt of mimetypes) {
            const lower = (mt ?? '').toLowerCase();
            if (FILE_OP_MIMETYPES.has(lower) || FILE_OP_MIMETYPES.has(mt)) {
                return true;
            }
        }
        return false;
    }
}
