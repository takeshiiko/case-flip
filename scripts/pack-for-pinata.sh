#!/bin/bash
#
# Prepare the sealed collection for Pinata as two CAR files.
#
# Packing computes the root CIDs locally, so the image CID is known before any
# upload starts. That lets the metadata be written with the real CID up front
# and both CARs uploaded in parallel, instead of the usual serial round trip
# (upload images -> wait -> get CID -> rewrite metadata -> upload metadata).
#
# CAR upload requires a paid Pinata plan and is processed asynchronously.
#
# Usage:
#   scripts/pack-for-pinata.sh [source-dir] [output-dir]
# Defaults:
#   source  ~/caseflip-assets/sealed
#   output  ~/caseflip-assets/car
#
set -euo pipefail

SRC="${1:-$HOME/caseflip-assets/sealed}"
OUT="${2:-$HOME/caseflip-assets/car}"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ -d "$SRC/images" ]   || { echo "missing $SRC/images"; exit 1; }
[ -d "$SRC/metadata" ] || { echo "missing $SRC/metadata"; exit 1; }

# `find | head` would SIGPIPE under `set -o pipefail`, so collect once into an array.
IFS=$'\n' read -r -d '' -a IMG_FILES < <(find "$SRC/images" -type f ! -name '.*' && printf '\0')
IMG_COUNT=${#IMG_FILES[@]}
META_COUNT=$(find "$SRC/metadata" -name '*.json' -type f | wc -l | tr -d ' ')
[ "$IMG_COUNT" = "$META_COUNT" ] || { echo "count mismatch: $IMG_COUNT images vs $META_COUNT metadata"; exit 1; }
[ "$IMG_COUNT" -gt 0 ] || { echo "no images found in $SRC/images"; exit 1; }

# Image extension drives what the metadata must point at (.jpg vs .webp).
EXT="${IMG_FILES[0]##*.}"

mkdir -p "$OUT"
echo "source      : $SRC"
echo "files       : $IMG_COUNT images (.$EXT) + $META_COUNT metadata"
echo

# ---- 1. images -------------------------------------------------------------
echo "packing images..."
npx --yes ipfs-car@3.1.0 pack "$SRC/images" --output "$OUT/images.car" --no-wrap >"$OUT/.imgcid" 2>/dev/null
IMG_CID=$(tr -d '[:space:]' < "$OUT/.imgcid"); rm -f "$OUT/.imgcid"
[ -n "$IMG_CID" ] || { echo "failed to get image CID"; exit 1; }
echo "  image CID : $IMG_CID"

# ---- 2. metadata now points at the real image CID --------------------------
echo
echo "rewriting metadata with the real image CID..."
python3 "$PROJECT/tools/generate_numbered_cases.py" \
  --base "$PROJECT/assets/case-blank-square.png" \
  --out "$SRC" --start 1 --end "$META_COUNT" --digits 5 \
  --format "$EXT" --metadata-only \
  --image-base "ipfs://$IMG_CID/" >/dev/null

SAMPLE=$(python3 -c "import json;print(json.load(open('$SRC/metadata/1.json'))['image'])")
echo "  sample    : $SAMPLE"
case "$SAMPLE" in
  "ipfs://$IMG_CID/1.$EXT") ;;
  *) echo "metadata image field is wrong, aborting"; exit 1 ;;
esac

# ---- 3. metadata -----------------------------------------------------------
echo
echo "packing metadata..."
npx --yes ipfs-car@3.1.0 pack "$SRC/metadata" --output "$OUT/metadata.car" --no-wrap >"$OUT/.metacid" 2>/dev/null
META_CID=$(tr -d '[:space:]' < "$OUT/.metacid"); rm -f "$OUT/.metacid"
[ -n "$META_CID" ] || { echo "failed to get metadata CID"; exit 1; }
echo "  meta CID  : $META_CID"

echo
echo "================================================================"
echo "  Upload these two to Pinata (CAR mode). They are independent."
echo "================================================================"
ls -lh "$OUT"/images.car "$OUT"/metadata.car | awk '{printf "  %-14s %s\n", $9, $5}'
echo
echo "  images   CID : $IMG_CID"
echo "  metadata CID : $META_CID"
echo
echo "  Deploy parameter:"
echo "    export UNREVEALED_BASE_URI=\"ipfs://$META_CID/\""
echo
echo "  Spot-check after Pinata finishes indexing:"
echo "    https://gateway.pinata.cloud/ipfs/$META_CID/1.json"
echo "    https://gateway.pinata.cloud/ipfs/$IMG_CID/1.$EXT"
echo
echo "  Reminder: revealed art is NOT part of this. It carries each prize on"
echo "  its face, so it is generated and uploaded only once reveal is imminent."
