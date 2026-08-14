#!/bin/bash
#
# Pin the images DAG on Pinata by CID, serving it from a local IPFS node.
#
# Why this route: `car=true` is honoured on Pinata's direct multipart upload but
# NOT over TUS, and multipart is capped near 100MB by Cloudflare (503 /
# "error code: 1102"). A 1GB CAR therefore has no working upload path — it goes
# up as an opaque blob under a different CID, and the gateway answers 404 for
# the directory we actually need.
#
# Importing the CAR into a local node rebuilds the exact same DAG, root CID and
# all. Pinata then fetches it from that node, so the CID the metadata already
# points at is the CID that ends up pinned. No metadata rewrite, no re-upload.
#
# Prerequisites:
#   brew install ipfs
#   ipfs init                     # once
#   ipfs daemon                   # leave running in another terminal
#   export PINATA_JWT='...'
#
#   scripts/pin-by-cid.sh [car-file]
#
set -euo pipefail

CAR="${1:-$HOME/caseflip-assets/car/images.car}"
API="https://api.pinata.cloud/pinning/pinByHash"
GATEWAY="https://gateway.pinata.cloud/ipfs"

command -v ipfs >/dev/null || { echo "ipfs not found. Install it: brew install ipfs"; exit 1; }
[ -n "${PINATA_JWT:-}" ] || { echo "Set PINATA_JWT first."; exit 1; }
[ -f "$CAR" ] || { echo "CAR not found: $CAR"; exit 1; }

ipfs id >/dev/null 2>&1 || { echo "The IPFS daemon is not running. Start it: ipfs daemon"; exit 1; }

ROOT=$(npx --yes ipfs-car@3.1.0 roots "$CAR" 2>/dev/null | tr -d '[:space:]')
[ -n "$ROOT" ] || { echo "could not read the CAR root"; exit 1; }
echo "root CID : $ROOT"

echo
echo "importing the CAR into the local node (rebuilds the identical DAG)..."
ipfs dag import --pin-roots=true "$CAR"
ipfs pin add --recursive "$ROOT" >/dev/null 2>&1 || true

# Prove the node really holds and can traverse the DAG before asking Pinata for
# it. Listing all 20,000 entries is needlessly slow, and piping `ipfs ls` into
# `head` trips SIGPIPE under `set -o pipefail`. Check the root block exists and
# that one known path resolves through it — that is what Pinata will do too.
echo
if ! ipfs block stat --offline "$ROOT" >/dev/null 2>&1; then
  echo "the root block is not in the local store — the CAR import did not take"; exit 1
fi
echo "root block present locally"

SAMPLE_EXT="${SAMPLE_EXT:-webp}"
if ipfs resolve --offline "/ipfs/$ROOT/1.$SAMPLE_EXT" >/dev/null 2>&1; then
  echo "path /ipfs/$ROOT/1.$SAMPLE_EXT resolves locally"
else
  echo "root exists but /1.$SAMPLE_EXT does not resolve — wrong CAR or wrong extension"; exit 1
fi

# Pinata can be pointed at specific peers, which matters a lot behind home NAT.
# (macOS ships bash 3.2, so no mapfile — go through a temp file instead.)
echo
echo "collecting reachable multiaddrs..."
ADDR_FILE=$(mktemp)
# Keep publicly dialable addresses and relay (/p2p-circuit) addresses — behind
# home NAT a relay hop is often the only way in.
ipfs id -f='<addrs>\n' 2>/dev/null \
  | grep -v -E '/(127\.0\.0\.1|::1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|/ip6/(fe80|::1))' \
  | grep -E '/tcp/|/udp/.*/quic|/p2p-circuit' \
  | head -5 > "$ADDR_FILE" || true

if [ -s "$ADDR_FILE" ]; then
  sed 's/^/  /' "$ADDR_FILE"
else
  echo "  none public — Pinata will have to find the node over the DHT, which is"
  echo "  slower and less certain. Leave the daemon running; if it stalls, check"
  echo "  that inbound port 4001 reaches this machine."
fi

HOST_JSON=$(python3 -c "
import json
print(json.dumps([l.strip() for l in open('$ADDR_FILE') if l.strip()]))")

umask 077
CFG=$(mktemp); trap 'rm -f "$CFG" "$ADDR_FILE"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$PINATA_JWT" > "$CFG"

echo
echo "asking Pinata to pin $ROOT ..."
# Sending `hostNodes: []` is rejected outright — the property has to be absent
# when there is nothing to hint with, so Pinata falls back to the DHT.
BODY=$(python3 -c "
import json
opts = {}
hosts = json.loads('''$HOST_JSON''')
if hosts:
    opts['hostNodes'] = hosts
payload = {'hashToPin': '$ROOT', 'pinataMetadata': {'name': 'caseflip-sealed-images'}}
if opts:
    payload['pinataOptions'] = opts
print(json.dumps(payload))")

RESP=$(curl --silent --show-error --config "$CFG" \
  --request POST "$API" \
  --header "Content-Type: application/json" \
  --data "$BODY") || { echo "request failed"; exit 1; }
echo "$RESP"

# The API answers 200 with an {"error": ...} body, so the response has to be
# inspected rather than trusting the exit status.
if printf '%s' "$RESP" | grep -q '"error"'; then
  cat <<'ERR'

The pin request was REJECTED — nothing is being fetched.

If it complains about hostNodes, this node has no address Pinata can dial yet.
Check what it is advertising:

  ipfs id -f='<addrs>\n'

Anything on /p2p-circuit means a relay is in play and is worth passing as a
hint; only loopback/LAN entries means the node is unreachable from outside, and
pin-by-CID cannot work until that changes.
ERR
  exit 1
fi

cat <<EOF

Pinata accepted the request and is retrieving the DAG from your node.

KEEP THE DAEMON RUNNING and the machine awake until it finishes. If the node
goes away mid-fetch the job flips to "Expired" and has to be re-queued.

Watch for the directory to come alive:
  curl -s -o /dev/null -w '%{http_code}\\n' $GATEWAY/$ROOT/1.webp

200 means done. While it is still fetching you will get 404 with
"searching for a file on the non-pinata IPFS network".
EOF
