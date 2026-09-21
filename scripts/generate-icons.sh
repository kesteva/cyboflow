#!/usr/bin/env bash
#
# generate-icons.sh — regenerate all Cyboflow raster brand assets from the mark SVG.
#
# Source of truth: the Cyboflow MARK (square glyph). Re-run this whenever the mark
# changes. Uses only macOS built-ins (qlmanage, sips, iconutil) plus
# scripts/make-ico.mjs — no ImageMagick / rsvg / inkscape and no npm deps.
#
# Usage:
#   scripts/generate-icons.sh [path/to/cyboflow-mark.svg]
#
# Defaults to frontend/src/assets/cyboflow-logo.svg (which holds the mark SVG).
#
# Outputs:
#   frontend/public/favicon-96x96.png    (96x96)
#   frontend/public/apple-touch-icon.png (180x180)
#   main/assets/icon.png                 (1024x1024)
#   main/assets/icon.icns                (Apple iconset)
#   main/assets/icon.ico                 (Windows, 16..256)
#   main/assets/icon-dev.png             \
#   main/assets/icon-dev.icns             > the "Cyboflow Dev" variant's icon
#   main/assets/icon-dev.ico             /
#
# The DEV variant is not separate artwork: it is this same mark with the accent
# stroke hue-rotated from the stable orange to blue, so the two apps are instantly
# distinguishable in the Dock / taskbar while staying obviously the same product.
# Deriving it here (rather than committing a second hand-drawn SVG) is what keeps
# the dev icon from silently drifting when the mark is redrawn.
#
# Note: frontend/public/favicon.svg and frontend/src/assets/cyboflow-logo.svg are
# the MARK SVG and are edited directly (vector source), not generated here.

set -euo pipefail

# Resolve repo root relative to this script (scripts/ lives at the repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MARK_SVG="${1:-$ROOT/frontend/src/assets/cyboflow-logo.svg}"

# The mark's accent stroke, and the dev variant's replacement for it. The blue is
# the orange hue-rotated to 210° at identical HSL saturation and lightness, so the
# dev icon carries exactly the same visual weight as the stable one.
STABLE_ACCENT='#c96442'
DEV_ACCENT='#4286c9'

if [[ ! -f "$MARK_SVG" ]]; then
  echo "error: mark SVG not found: $MARK_SVG" >&2
  exit 1
fi

if ! grep -qi "$STABLE_ACCENT" "$MARK_SVG"; then
  echo "error: $MARK_SVG no longer contains the accent color $STABLE_ACCENT;" >&2
  echo "       update STABLE_ACCENT in this script or the dev icon would be a" >&2
  echo "       byte-for-byte copy of the stable one." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d /tmp/cyboflow-icons.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# rasterize <svg> <out.png> — 1024px master via Quick Look, size-verified.
#
# Quick Look honours the SVG's intrinsic width/height and letterboxes the result
# into the -s canvas, so rasterizing the 48x48 mark straight to 1024 yields the
# artwork stranded tiny in the top-left corner (the defect c62c7f930 had to undo
# by hand). Scaling the root element to 1024 first — the viewBox is untouched, so
# nothing is cropped or re-laid-out — makes the glyph fill the canvas.
rasterize() {
  local svg="$1" out="$2" width
  local scaled="$TMP_DIR/$(basename "${svg%.svg}")-1024.svg"
  sed -E '1,/<svg/ s/(<svg[^>]*[[:space:]])width="[^"]*"([[:space:]]+)height="[^"]*"/\1width="1024"\2height="1024"/' \
    "$svg" > "$scaled"
  if ! grep -q 'width="1024"' "$scaled"; then
    echo "error: could not scale $svg to 1024px — is its <svg> tag still 'width=\"..\" height=\"..\"'?" >&2
    exit 1
  fi
  qlmanage -t -s 1024 -o "$TMP_DIR" "$scaled" >/dev/null 2>&1
  local produced="$TMP_DIR/$(basename "$scaled").png"
  if [[ ! -f "$produced" ]]; then
    echo "error: qlmanage did not produce a raster from $svg" >&2
    exit 1
  fi
  width="$(sips -g pixelWidth "$produced" 2>/dev/null | awk '/pixelWidth/{print $2}')"
  if [[ "$width" != "1024" ]]; then
    echo "error: master raster is not 1024px wide (got: ${width:-none})" >&2
    exit 1
  fi
  mv "$produced" "$out"
}

# build_app_icons <master.png> <suffix> — writes main/assets/icon<suffix>.{png,icns,ico}.
build_app_icons() {
  local master="$1" suffix="${2:-}"
  local iconset="$TMP_DIR/cyboflow${suffix}.iconset"
  local ico_dir="$TMP_DIR/ico${suffix}"
  mkdir -p "$iconset" "$ico_dir"

  sips -z 1024 1024 "$master" --out "$ROOT/main/assets/icon${suffix}.png" >/dev/null

  # Apple iconset → .icns
  sips -z 16 16     "$master" --out "$iconset/icon_16x16.png"      >/dev/null
  sips -z 32 32     "$master" --out "$iconset/icon_16x16@2x.png"   >/dev/null
  sips -z 32 32     "$master" --out "$iconset/icon_32x32.png"      >/dev/null
  sips -z 64 64     "$master" --out "$iconset/icon_32x32@2x.png"   >/dev/null
  sips -z 128 128   "$master" --out "$iconset/icon_128x128.png"    >/dev/null
  sips -z 256 256   "$master" --out "$iconset/icon_128x128@2x.png" >/dev/null
  sips -z 256 256   "$master" --out "$iconset/icon_256x256.png"    >/dev/null
  sips -z 512 512   "$master" --out "$iconset/icon_256x256@2x.png" >/dev/null
  sips -z 512 512   "$master" --out "$iconset/icon_512x512.png"    >/dev/null
  sips -z 1024 1024 "$master" --out "$iconset/icon_512x512@2x.png" >/dev/null
  iconutil -c icns -o "$ROOT/main/assets/icon${suffix}.icns" "$iconset"

  # Windows .ico — the seven sizes the committed icon.ico has always carried.
  local sizes=(16 24 32 48 64 128 256) size pngs=()
  for size in "${sizes[@]}"; do
    sips -z "$size" "$size" "$master" --out "$ico_dir/$size.png" >/dev/null
    pngs+=("$ico_dir/$size.png")
  done
  node "$SCRIPT_DIR/make-ico.mjs" "$ROOT/main/assets/icon${suffix}.ico" "${pngs[@]}" >/dev/null
}

# 1. Stable: rasterize the mark and derive every stable asset.
rasterize "$MARK_SVG" "$TMP_DIR/master.png"
sips -z 96 96   "$TMP_DIR/master.png" --out "$ROOT/frontend/public/favicon-96x96.png"   >/dev/null
sips -z 180 180 "$TMP_DIR/master.png" --out "$ROOT/frontend/public/apple-touch-icon.png" >/dev/null
build_app_icons "$TMP_DIR/master.png" ""

# 2. Dev: same mark, accent recolored, app icons only (the favicons are the
#    product's, not a variant's).
sed "s/${STABLE_ACCENT}/${DEV_ACCENT}/gI" "$MARK_SVG" > "$TMP_DIR/cyboflow-mark-dev.svg"
rasterize "$TMP_DIR/cyboflow-mark-dev.svg" "$TMP_DIR/master-dev.png"
build_app_icons "$TMP_DIR/master-dev.png" "-dev"

echo "Generated:"
echo "  frontend/public/favicon-96x96.png"
echo "  frontend/public/apple-touch-icon.png"
echo "  main/assets/icon.png / icon.icns / icon.ico"
echo "  main/assets/icon-dev.png / icon-dev.icns / icon-dev.ico"
