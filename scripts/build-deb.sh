#!/usr/bin/env bash
#
# build-deb.sh — build the clipboard-extension .deb from src/ + debian/.
#
# Uses a staging-tree approach (dpkg-deb --build) for reproducibility and
# simplicity — no full debhelper toolchain required for a single JS extension.
#
# Output: dist/clipboard-extension_1.0-1_all.deb
#
set -euo pipefail

UUID="clipboard@haibachvan.local"
VERSION="1.0"
RELEASE="1"
PKG="clipboard-extension"
ARCH="all"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT}/src"
DEBIAN_DIR="${ROOT}/debian"
BUILD_DIR="${ROOT}/build/deb-staging"
DIST_DIR="${ROOT}/dist"

EXT_DEST="${BUILD_DIR}/usr/share/gnome-shell/extensions/${UUID}"
SCHEMA_DEST="${BUILD_DIR}/usr/share/glib-2.0/schemas"

echo "==> Cleaning previous build"
rm -rf "${BUILD_DIR}"
mkdir -p "${EXT_DEST}" "${SCHEMA_DEST}" "${DIST_DIR}" "${BUILD_DIR}/DEBIAN"

echo "==> Staging extension files into ${EXT_DEST}"
# Copy everything from src/ except precompiled schemas (we ship the XML and
# compile system-wide in postinst).
cp -a "${SRC_DIR}/." "${EXT_DEST}/"
rm -f "${EXT_DEST}/schemas/"*.compiled 2>/dev/null || true

echo "==> Staging GSettings schema into ${SCHEMA_DEST}"
cp -a "${SRC_DIR}/schemas/"*.gschema.xml "${SCHEMA_DEST}/"

echo "==> Writing DEBIAN control (from debian/control binary stanza)"
# debian/control is the single source of truth for the binary package
# metadata (Depends, Recommends, Description, ...). We extract the
# `Package: ${PKG}` stanza (deb822: stanzas are separated by blank lines;
# within a stanza, field lines start at column 0, continuation lines are
# indented) and inject the build-time Version + Architecture, so the
# staging tree's control stays in sync with debian/control. Source-only
# fields (Source, Build-Depends, Standards-Version) are dropped — they
# don't belong in a binary control file.
awk -v pkg="${PKG}" '
    BEGIN { stanza = ""; want = 0 }
    # Blank line: stanza boundary — flush if it is the one we want.
    /^[[:space:]]*$/ {
        if (want) printf "%s", stanza
        stanza = ""; want = 0; next
    }
    # Accumulate the current stanza; flag it if its Package field matches.
    {
        stanza = stanza $0 "\n"
        if ($0 ~ "^Package: " pkg "$") want = 1
    }
    END { if (want) printf "%s", stanza }
' "${DEBIAN_DIR}/control" > "${BUILD_DIR}/DEBIAN/control"

# Drop source-only fields that may have slipped through if the stanza
# ordering differs; they are meaningless in a binary control file.
sed -i "/^Source:/d; /^Build-Depends:/d; /^Standards-Version:/d" \
    "${BUILD_DIR}/DEBIAN/control"

# Inject build-time fields that are not in debian/control.
# Version: derived from ${VERSION}-${RELEASE} (never present in debian/control).
sed -i "/^Package:/a Version: ${VERSION}-${RELEASE}" "${BUILD_DIR}/DEBIAN/control"
# Architecture: debian/control already declares `Architecture: all`; only
# inject if missing (e.g. if debian/control is edited to omit it).
if ! grep -q "^Architecture:" "${BUILD_DIR}/DEBIAN/control"; then
    sed -i "/^Version:/a Architecture: ${ARCH}" "${BUILD_DIR}/DEBIAN/control"
fi

echo "==> Copying maintainer scripts"
cp -a "${DEBIAN_DIR}/postinst" "${BUILD_DIR}/DEBIAN/postinst"
cp -a "${DEBIAN_DIR}/postrm" "${BUILD_DIR}/DEBIAN/postrm"
chmod 0755 "${BUILD_DIR}/DEBIAN/postinst" "${BUILD_DIR}/DEBIAN/postrm"

# Compute installed size (KB) and patch it into control.
INSTALLED_SIZE="$(du -sk "${BUILD_DIR}/usr" | cut -f1)"
sed -i "/^Architecture:/a Installed-Size: ${INSTALLED_SIZE}" "${BUILD_DIR}/DEBIAN/control"

echo "==> Fixing ownership (root:root) and permissions"
if [ "$(id -u)" -eq 0 ]; then
    chown -R root:root "${BUILD_DIR}"
else
    # Best-effort when not root; dpkg-deb will still build.
    echo "    (not root, skipping chown)"
fi
find "${BUILD_DIR}/DEBIAN" -type f -exec chmod 0644 {} \;
chmod 0755 "${BUILD_DIR}/DEBIAN/postinst" "${BUILD_DIR}/DEBIAN/postrm"

DEB="${DIST_DIR}/${PKG}_${VERSION}-${RELEASE}_${ARCH}.deb"
echo "==> Building ${DEB}"
dpkg-deb --build --root-owner-group "${BUILD_DIR}" "${DEB}"

echo "==> Done"
ls -la "${DEB}"

if command -v lintian >/dev/null 2>&1; then
    echo "==> Running lintian"
    lintian "${DEB}" || true
else
    echo "==> lintian not installed; skipping (install with: sudo apt install lintian)"
fi
