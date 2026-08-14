#!/bin/bash
#
# Split the sealed images into upload-sized batches.
#
# A single 20,000-file / 1.1GB directory has no working path into Pinata: CAR
# multipart dies at ~100MB, CAR over TUS silently drops the car flag, pin-by-CID
# needs a dialable node, and the web folder upload stalls. Smaller directories
# do go through.
#
# Nothing about the contract requires the images to live under one CID — only
# the metadata directory has to be a single CID, because tokenURI concatenates
# baseURI + tokenId + ".json". Each metadata file is free to point its `image`
# at whichever batch holds it.
#
# Files are hardlinked, not copied, so this costs no extra disk.
#
#   scripts/split-batches.sh [batch-size] [source-images-dir] [out-dir]
# Defaults: 2000, ~/caseflip-assets/sealed-webp/images, ~/caseflip-assets/batches
#
set -euo pipefail

SIZE="${1:-2000}"
SRC="${2:-$HOME/caseflip-assets/sealed-webp/images}"
OUT="${3:-$HOME/caseflip-assets/batches}"

[ -d "$SRC" ] || { echo "source not found: $SRC"; exit 1; }

TOTAL=$(find "$SRC" -type f ! -name '.*' | wc -l | tr -d ' ')
[ "$TOTAL" -gt 0 ] || { echo "no images in $SRC"; exit 1; }
EXT=$(basename "$(find "$SRC" -type f ! -name '.*' -print -quit)"); EXT="${EXT##*.}"

rm -rf "$OUT"; mkdir -p "$OUT"
BATCHES=$(( (TOTAL + SIZE - 1) / SIZE ))

echo "source  : $SRC"
echo "images  : $TOTAL (.$EXT)"
echo "batches : $BATCHES x $SIZE"
echo

MANIFEST="$OUT/batches.json"
printf '{\n  "extension": "%s",\n  "total": %d,\n  "batches": [\n' "$EXT" "$TOTAL" > "$MANIFEST"

i=0
while [ "$i" -lt "$BATCHES" ]; do
  n=$((i + 1))
  start=$(( i * SIZE + 1 ))
  end=$(( start + SIZE - 1 ))
  [ "$end" -gt "$TOTAL" ] && end=$TOTAL
  dir=$(printf '%s/batch-%02d' "$OUT" "$n")
  mkdir -p "$dir"

  id=$start
  while [ "$id" -le "$end" ]; do
    ln "$SRC/$id.$EXT" "$dir/$id.$EXT"
    id=$((id + 1))
  done

  bytes=$(du -sk "$dir" | cut -f1)
  printf '  batch-%02d : tokens %5d-%5d  %4d MB\n' "$n" "$start" "$end" "$((bytes / 1024))"

  sep=","; [ "$n" -eq "$BATCHES" ] && sep=""
  printf '    {"batch": %d, "dir": "%s", "start": %d, "end": %d, "cid": null}%s\n' \
    "$n" "$dir" "$start" "$end" "$sep" >> "$MANIFEST"

  i=$n
done

printf '  ]\n}\n' >> "$MANIFEST"

echo
echo "manifest: $MANIFEST"
echo
echo "Upload each batch-NN directory to Pinata as its own folder, then paste the"
echo "CID it returns into the matching \"cid\" field in the manifest. When every"
echo "cid is filled in, run:"
echo
echo "  node scripts/write-batched-metadata.js"
