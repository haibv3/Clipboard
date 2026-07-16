/*
 * log.js — gated logger for the Clipboard extension.
 *
 * debug() is silent unless GSettings key `debug` is true (default false),
 * so normal use never dumps clipboard content into journald.
 * warn()/error() always log.
 */

let _debug = false;
let _settings = null;
let _handlerId = 0;

/**
 * Bind to extension settings. Safe to call once from enable().
 * @param {Gi.Gio.Settings|null} settings
 */
export function init(settings) {
    teardown();
    _settings = settings ?? null;
    if (!_settings) {
        _debug = false;
        return;
    }
    _debug = _settings.get_boolean('debug');
    _handlerId = _settings.connect('changed::debug', () => {
        _debug = _settings.get_boolean('debug');
    });
}

/** Disconnect settings watcher (call from disable). */
export function teardown() {
    if (_settings && _handlerId) {
        try {
            _settings.disconnect(_handlerId);
        } catch (_e) {
            // ignore
        }
    }
    _handlerId = 0;
    _settings = null;
    _debug = false;
}

export function isDebug() {
    return _debug;
}

export function debug(msg) {
    if (_debug)
        log(`[Clipboard] ${msg}`);
}

export function warn(msg) {
    log(`[Clipboard] ${msg}`);
}

export function error(msg) {
    log(`[Clipboard] ${msg}`);
}
