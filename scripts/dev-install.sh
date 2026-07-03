#!/usr/bin/env bash
#
# dev-install.sh — install the Clipboard GNOME Shell extension into the
# per-user extensions directory for development, and compile its GSettings
# schema. After running this, log out and back in (Wayland cannot reload
# gnome-shell with Alt+F2 r), then:
#
#   gnome-extensions enable clipboard@haibachvan.local
#
# For faster iteration without logout, use a nested shell:
#
#   dbus-run-session -- gnome-shell --nested --wayland
#
set -euo pipefail

UUID="clipboard@haibachvan.local"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src"
DEST_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "==> Installing ${UUID}"
echo "    src: ${SRC_DIR}"
echo "    dst: ${DEST_DIR}"

mkdir -p "${DEST_DIR}"

# Rsync keeps it idempotent and removes stale files.
if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete --exclude '*.compiled' "${SRC_DIR}/" "${DEST_DIR}/"
else
    cp -a "${SRC_DIR}/." "${DEST_DIR}/"
fi

# Compile the GSettings schema in place.
SCHEMA_DIR="${DEST_DIR}/schemas"
if [ -d "${SCHEMA_DIR}" ]; then
    echo "==> Compiling schemas in ${SCHEMA_DIR}"
    glib-compile-schemas "${SCHEMA_DIR}"
fi

# Verify the schema is usable.
echo "==> Verifying schema keys"
gsettings --schemadir "${SCHEMA_DIR}" list-keys org.gnome.shell.extensions.clipboard || true

echo
echo "Done. Log out and back in, then run:"
echo "  gnome-extensions enable ${UUID}"
echo "Tail logs with:"
echo "  journalctl -f -o cat /usr/bin/gnome-shell"
