/*
 * privacy.js — privacy filter for clipboard capture.
 *
 * Gates (cheapest first, applied by monitor):
 *  1. MIME sensitive / concealed / password-manager hints
 *  2. Nautilus file-op mimetypes (unless image/png also offered)
 *  3. App denylist (focused wm_class)
 *  4. Text regex denylist
 */

import Meta from 'gi://Meta';
import { error, warn } from './log.js';

const SELECTION_CLIPBOARD = Meta.SelectionType.SELECTION_CLIPBOARD;

// Cap text length scanned by regex denylist (ReDoS / cost guard).
const MAX_TEXT_CHECK = 64 * 1024;

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

const FILE_OP_MIMETYPES = new Set([
    'application/x-nautilus-clipboard',
    'x-special/gnome-copied-files',
]);

export class PrivacyFilter {
    constructor({ settings } = {}) {
        this._settings = settings ?? null;
        this._regexCache = new Map(); // pattern -> RegExp | null (invalid)
    }

    /**
     * Returns true if the current clipboard selection should be skipped
     * based on offered mimetypes.
     */
    shouldSkip(selection) {
        if (!selection) return false;

        let mimetypes = [];
        try {
            mimetypes = selection.get_mimetypes(SELECTION_CLIPBOARD) ?? [];
        } catch (e) {
            error(`get_mimetypes failed: ${e}`);
            return false;
        }

        for (const mt of mimetypes) {
            const lower = (mt ?? '').toLowerCase();
            if (SENSITIVE_MIMETYPES.has(lower) || SENSITIVE_MIMETYPES.has(mt))
                return true;
            if (lower.includes('password') || lower.includes('secret') || lower.includes('concealed'))
                return true;
        }

        const hasImage = mimetypes.some(
            (mt) => (mt ?? '').toLowerCase() === 'image/png' ||
                (mt ?? '').toLowerCase() === 'image/jpeg' ||
                (mt ?? '').toLowerCase() === 'image/webp' ||
                (mt ?? '').toLowerCase() === 'image/bmp',
        );
        if (hasImage)
            return false;

        for (const mt of mimetypes) {
            const lower = (mt ?? '').toLowerCase();
            if (FILE_OP_MIMETYPES.has(lower) || FILE_OP_MIMETYPES.has(mt))
                return true;
        }
        return false;
    }

    /**
     * Skip if focused app wm_class matches any denylist entry (substring, ci).
     */
    shouldSkipApp(wmClass) {
        const list = this._settings?.get_strv('privacy-app-denylist') ?? [];
        if (list.length === 0) return false;
        const c = (wmClass ?? '').toLowerCase();
        if (!c) return false;
        return list.some((entry) => {
            const e = (entry ?? '').trim().toLowerCase();
            return e.length > 0 && c.includes(e);
        });
    }

    /**
     * Skip if any configured regex matches the text (first 64KiB).
     */
    shouldSkipText(text) {
        if (!text) return false;
        const list = this._settings?.get_strv('privacy-text-denylist') ?? [];
        if (list.length === 0) return false;

        const sample = text.length > MAX_TEXT_CHECK
            ? text.substring(0, MAX_TEXT_CHECK)
            : text;

        for (const pat of list) {
            const p = (pat ?? '').trim();
            if (!p) continue;
            let re = this._regexCache.get(p);
            if (re === undefined) {
                try {
                    re = new RegExp(p);
                } catch (_e) {
                    warn(`invalid privacy regex ignored: ${p}`);
                    re = null;
                }
                this._regexCache.set(p, re);
            }
            if (re && re.test(sample))
                return true;
        }
        return false;
    }
}
