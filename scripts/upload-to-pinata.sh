#!/bin/bash
#
# Upload the two prepared CAR files to Pinata and verify the CIDs come back
# exactly as packed.
#
# The metadata files embed the image CID, so if Pinata returns a different CID
# for the images than the one metadata points at, every image link is dead. This
# script fails loudly in that case rather than leaving a broken collection.
#
# The token is read from the environment and never printed. It is passed to curl
# through a 0600 config file so it does not show up in `ps` output.
#
#   export PINATA_JWT='...'            # your Pinata JWT, not the API key/secret
#   scripts/upload-to-pinata.sh [car-dir]
#
# Default car-dir: ~/caseflip-assets/car
#
set -euo pipefail

CAR_DIR="${1:-$HOME/caseflip-assets/car}"
ENDPOINT="https://uploads.pinata.cloud/v3/files"
GATEWAY="https://gateway.pinata.cloud/ipfs"

[ -n "${PINATA_JWT:-}" ] || { echo "Set PINATA_JWT first (export PINATA_JWT='...')"; exit 1; }
[ -f "$CAR_DIR/images.car" ]   || { echo "missing $CAR_DIR/images.car — run pack-for-pinata.sh"; exit 1; }
[ -f "$CAR_DIR/metadata.car" ] || { echo "missing $CAR_DIR/metadata.car — run pack-for-pinata.sh"; exit 1; }

# What the packer produced, and what the metadata therefore depends on.
EXPECTED_IMG=$(npx --yes ipfs-car@3.1.0 roots "$CAR_DIR/images.car" 2>/dev/null | tr -d '[:space:]')
EXPECTED_META=$(npx --yes ipfs-car@3.1.0 roots "$CAR_DIR/metadata.car" 2>/dev/null | tr -d '[:space:]')
[ -n "$EXPECTED_IMG" ] && [ -n "$EXPECTED_META" ] || { echo "could not read CAR roots"; exit 1; }

umask 077
CFG=$(mktemp)
trap 'rm -f "$CFG"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$PINATA_JWT" > "$CFG"

upload() {  # name, path -> prints returned CID
  local label="$1" path="$2"
  local size; size=$(du -h "$path" | cut -f1)
  echo "uploading $label ($size)..." >&2
  local body
  body=$(curl --silent --show-error --fail-with-body \
    --config "$CFG" \
    --request POST "$ENDPOINT" \
    --form "file=@$path" \
    --form "network=public" \
    --form "name=$label" \
    --form "car=true" \
    --progress-bar) || { echo "upload failed for $label:" >&2; echo "$body" >&2; return 1; }
  echo "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("data",{}).get("cid",""))'
}

echo "packed image CID    : $EXPECTED_IMG"
echo "packed metadata CID : $EXPECTED_META"
echo

GOT_META=$(upload "caseflip-metadata.car" "$CAR_DIR/metadata.car")
echo "  returned: ${GOT_META:-<none>}"
GOT_IMG=$(upload "caseflip-images.car" "$CAR_DIR/images.car")
echo "  returned: ${GOT_IMG:-<none>}"

echo
fail=0
for pair in "images:$EXPECTED_IMG:$GOT_IMG" "metadata:$EXPECTED_META:$GOT_META"; do
  IFS=: read -r what want got <<< "$pair"
  if [ "$want" = "$got" ]; then
    echo "OK    $what CID matches"
  else
    echo "FAIL  $what CID differs — wanted $want, got ${got:-<none>}"
    fail=1
  fi
done

if [ "$fail" = 1 ]; then
  cat <<EOF

The returned CID does not match what was packed. Do NOT deploy with these.
If only the IMAGE CID differs, repoint the metadata at the CID Pinata actually
returned and repack + reupload the metadata (about 15 seconds of local work):

  python3 tools/generate_numbered_cases.py --base assets/case-blank-square.png \\
    --out ~/caseflip-assets/sealed-webp --start 1 --end 20000 --digits 5 \\
    --format webp --metadata-only --image-base "ipfs://<cid-pinata-returned>/"
EOF
  exit 1
fi

cat <<EOF

Both CARs uploaded with matching CIDs.

CAR processing is asynchronous — indexing can take a few minutes. Check:
  $GATEWAY/$GOT_META/1.json
  $GATEWAY/$GOT_IMG/1.webp

Then deploy with:
  export UNREVEALED_BASE_URI="ipfs://$GOT_META/"
EOF
