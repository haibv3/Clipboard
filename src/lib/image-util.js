/*
 * image-util.js — shared image helpers (thumbnail + PNG normalize).
 */

import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import { debug, error } from './log.js';

const MAX_DIM = 8000;
const MAX_THUMB = 48;

/**
 * Decode image bytes via GdkPixbuf. Returns { pixbuf, width, height } or null.
 */
export function decodePixbuf(bytes) {
    try {
        const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        if (width > MAX_DIM || height > MAX_DIM) {
            debug(`skipping oversized image (${width}×${height} > ${MAX_DIM})`);
            return null;
        }
        return { pixbuf, width, height };
    } catch (e) {
        error(`image decode error: ${e}`);
        return null;
    }
}

/**
 * Build a small PNG thumbnail GLib.Bytes from a pixbuf.
 */
export function makeThumbBytes(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    let tw = width;
    let th = height;
    if (width > height) {
        tw = MAX_THUMB;
        th = Math.max(1, Math.round((height / width) * MAX_THUMB));
    } else {
        th = MAX_THUMB;
        tw = Math.max(1, Math.round((width / height) * MAX_THUMB));
    }
    const thumb = pixbuf.scale_simple(tw, th, GdkPixbuf.InterpType.NEAREST);
    const [, thumbBytes] = thumb.save_to_bufferv('png', [], []);
    return new GLib.Bytes(thumbBytes);
}

/**
 * Re-encode any pixbuf as PNG GLib.Bytes (for consistent set_content MIME).
 */
export function pixbufToPngBytes(pixbuf) {
    const [, buf] = pixbuf.save_to_bufferv('png', [], []);
    return new GLib.Bytes(buf);
}

/**
 * From raw image bytes: produce { bytes (png), thumbBytes, width, height } or null.
 */
export function buildImageItemFromBytes(bytes) {
    const decoded = decodePixbuf(bytes);
    if (!decoded) return null;
    const { pixbuf, width, height } = decoded;
    const pngBytes = pixbufToPngBytes(pixbuf);
    const thumbBytes = makeThumbBytes(pixbuf);
    return { bytes: pngBytes, thumbBytes, width, height };
}
