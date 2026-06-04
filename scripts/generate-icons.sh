#!/usr/bin/env bash
#
# generate-icons.sh — regenerate all Cyboflow raster brand assets from the mark SVG.
#
# Source of truth: the Cyboflow MARK (square glyph). Re-run this whenever the mark
# changes. Uses only macOS built-ins (qlmanage, sips, iconutil) — no ImageMagick /
# rsvg / inkscape and no npm deps required.
#
# Usage:
#   scripts/generate-icons.sh [path/to/cyboflow-mark.svg]
#
# Defaults to frontend/src/assets/cyboflow-logo.svg (which holds the mark SVG).
#
# Outputs:
#   frontend/public/favicon-96x96.png   (96x96)
#   frontend/public/apple-touch-icon.png (180x180)
#   main/assets/icon.png                 (1024x1024)
#   main/assets/icon.icns                (Apple iconset)
#
# Note: frontend/public/favicon.svg and frontend/src/assets/cyboflow-logo.svg are
# the MARK SVG and are edited directly (vector source), not generated here.

set -euo pipefail

# Resolve repo root relative to this script (scripts/ lives at the repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MARK_SVG="${1:-$ROOT/frontend/src/assets/cyboflow-logo.svg}"

if [[ ! -f "$MARK_SVG" ]]; then
  echo "error: mark SVG not found: $MARK_SVG" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d /tmp/cyboflow-icons.XXXXXX)"
ICONSET="$(mktemp -d /tmp/cyboflow.iconset.XXXXXX)"
trap 'rm -rf "$TMP_DIR" "$ICONSET"' EXIT

# 1. Rasterize the mark SVG to a 1024px master PNG via Quick Look.
qlmanage -t -s 1024 -o "$TMP_DIR" "$MARK_SVG" >/dev/null 2>&1
MASTER="$TMP_DIR/$(basename "$MARK_SVG").png"

if [[ ! -f "$MASTER" ]]; then
  echo "error: qlmanage did not produce a raster from $MARK_SVG" >&2
  exit 1
fi

# Verify the master is a real 1024px raster before deriving anything from it.
WIDTH="$(sips -g pixelWidth "$MASTER" 2>/dev/null | awk '/pixelWidth/{print $2}')"
if [[ "$WIDTH" != "1024" ]]; then
  echo "error: master raster is not 1024px wide (got: ${WIDTH:-none})" >&2
  exit 1
fi

# 2. Derive the standalone PNG assets.
sips -z 96 96     "$MASTER" --out "$ROOT/frontend/public/favicon-96x96.png"   >/dev/null
sips -z 180 180   "$MASTER" --out "$ROOT/frontend/public/apple-touch-icon.png" >/dev/null
sips -z 1024 1024 "$MASTER" --out "$ROOT/main/assets/icon.png"                >/dev/null

# 3. Build the Apple iconset and pack it into icon.icns.
sips -z 16 16     "$MASTER" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z 32 32     "$MASTER" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 32 32     "$MASTER" --out "$ICONSET/icon_32x32.png"      >/dev/null
sips -z 64 64     "$MASTER" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 128 128   "$MASTER" --out "$ICONSET/icon_128x128.png"    >/dev/null
sips -z 256 256   "$MASTER" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$MASTER" --out "$ICONSET/icon_256x256.png"    >/dev/null
sips -z 512 512   "$MASTER" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$MASTER" --out "$ICONSET/icon_512x512.png"    >/dev/null
sips -z 1024 1024 "$MASTER" --out "$ICONSET/icon_512x512@2x.png" >/dev/null

iconutil -c icns -o "$ROOT/main/assets/icon.icns" "$ICONSET"

echo "Generated:"
echo "  frontend/public/favicon-96x96.png"
echo "  frontend/public/apple-touch-icon.png"
echo "  main/assets/icon.png"
echo "  main/assets/icon.icns"
