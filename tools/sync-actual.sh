#!/usr/bin/env bash
# Copy the PCAQ ontology viewer (supergus/pcaq-viewer, private) into public/actual/ so the Pages project serves it at
# /actual/ behind the existing gate. Usage: tools/sync-actual.sh /path/to/pcaq-viewer
# Only the static viewer, structural TTL and fictional demo data are copied (no workbooks; that repo's sanitize test guards it).
set -euo pipefail
SRC="${1:?path to a pcaq-viewer checkout}"; cd "$(dirname "$0")/.."
( cd "$SRC" && node tests/sanitize.test.mjs >/dev/null && node tests/basepath.test.mjs >/dev/null )
rm -rf public/actual && mkdir -p public/actual
( cd "$SRC/public" && tar --exclude=_headers --exclude=robots.txt -cf - . ) | ( cd public/actual && tar -xf - )
echo "supergus/pcaq-viewer@$(git -C "$SRC" rev-parse --short HEAD)" > public/actual/SOURCE.txt
find public/actual -iregex '.*\.\(xlsm\|xlsx\|xls\|xlsb\|bin\|bak\)$' | grep . && { echo "forbidden file in public/actual"; exit 1; } || true
echo "public/actual synced from $(cat public/actual/SOURCE.txt)"
