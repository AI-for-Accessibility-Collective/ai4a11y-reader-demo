#!/bin/sh
# Re-pack the two toolkit packages into vendor/ from a local checkout of the
# toolkit repository, then reinstall. The packages are not on npm yet, so a
# consumer depends on packed tarballs (see the toolkit's
# docs/using-in-your-project.md).
#
#   TOOLKIT_DIR=../AI-for-Accessibility-Toolkit npm run vendor
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TOOLKIT_DIR="${TOOLKIT_DIR:-$HERE/../AI-for-Accessibility-Toolkit-Draft}"
[ -d "$TOOLKIT_DIR/toolkit" ] || { echo "no toolkit checkout at $TOOLKIT_DIR (set TOOLKIT_DIR)"; exit 1; }

mkdir -p "$HERE/vendor"
rm -f "$HERE/vendor"/*.tgz
(cd "$TOOLKIT_DIR/toolkit" && npm pack --silent --pack-destination "$HERE/vendor" >/dev/null)
(cd "$TOOLKIT_DIR/tools"   && npm pack --silent --pack-destination "$HERE/vendor" >/dev/null)
cd "$HERE/vendor"
mv ai4a11y-toolkit-*.tgz ai4a11y-toolkit.tgz
mv ai4a11y-tools-*.tgz   ai4a11y-tools.tgz
(cd "$TOOLKIT_DIR" && echo "packed from toolkit commit $(git rev-parse --short HEAD)") > PIN.txt
cd "$HERE" && npm install --silent
echo "vendored: $(cat vendor/PIN.txt)"
