# Asset generation

Exact commands used for the Case Flip collection. The `--digits-box` values are
NOT the script defaults — the defaults put the number in the wrong place. These
were recovered by fitting against the original renders and verified to within a
few pixels. Do not change them without re-checking a sample against an existing
image.

Output goes to `~/caseflip-assets/`, deliberately **outside** `~/Desktop`, which
is synced to iCloud — files there get offloaded and would have to be downloaded
again before uploading to Pinata.

## Sealed (mint-time artwork)

20,000 images, 5-digit serial printed on the case, matching `Case Flip #00001`
names. No rarity attributes.

```bash
python3 tools/generate_numbered_cases.py \
  --base assets/case-blank-square.png \
  --out ~/caseflip-assets/sealed-webp \
  --start 1 --end 20000 \
  --digits 5 --digits-box 347,605,907,884 \
  --size 1024 --format webp --quality 88 \
  --metadata
```

~35 minutes, ~1.1 GB. WebP at q88 measured smaller *and* higher PSNR than JPEG
q85 on this artwork (43.0 dB vs 42.6 dB) — the number is a flat shape on a
smooth gradient, which WebP handles far better than JPEG. The JPEG q92 run was
2.7 GB for the same pixels; halving the bytes matters because the whole cost of
pinning is the upload, not the local packing.

Swap `--format jpg --quality 92` if a marketplace ever turns out not to render
WebP. The metadata `image` extension follows `--format` automatically.

## Pinning

`scripts/pack-for-pinata.sh` does the whole preparation in one go: it packs the
images into a CAR (which computes the root CID **locally**, in seconds), rewrites
the metadata to point at that real CID, packs the metadata into a second CAR, and
prints the `UNREVEALED_BASE_URI` for the deploy.

```bash
scripts/pack-for-pinata.sh ~/caseflip-assets/sealed-webp
```

Because both CIDs are known before anything is uploaded, the two CARs go up in
parallel — no waiting for the image upload to finish just to learn its CID. CAR
upload needs a paid Pinata plan and is processed asynchronously.

Local packing is negligible (16 s for 20,000 files / 2.7 GB), so the entire cost
of pinning is bytes over the wire. That is the only reason the format choice
matters.

To rewrite metadata by hand instead:

```bash
python3 tools/generate_numbered_cases.py \
  --base assets/case-blank-square.png \
  --out ~/caseflip-assets/sealed-webp \
  --start 1 --end 20000 --digits 5 --format webp \
  --metadata-only --image-base "ipfs://<sealed-image-cid>/"
```

Add a `/images` path segment to `--image-base` if an upload path nests the files
in a folder. Open one URI and check it resolves before pinning the metadata.

## Revealed (post-reveal artwork)

**Generate this only when reveal is imminent.** Each revealed image has the prize
amount printed on it, so the folder *is* the prize map. Publishing it — or
setting `revealedBaseURI` on the contract to a pinned CID — before
`startReveal()` is mined makes every reward public and defeats the Merkle
commitment.

Deploy with a placeholder `revealedBaseURI` and call `setBaseURI` with the real
one at reveal time.

```bash
python3 tools/generate_revealed_cases.py \
  --base assets/case-open-square.png \
  --out ~/caseflip-assets/revealed \
  --rewards ~/Desktop/Case20K-Rewards.csv \
  --start 1 --end 20000 \
  --digits 5 \
  --size 1024 --format jpg --quality 92 \
  --metadata
```

`--digits` only affects the metadata name here; the revealed artwork shows the
prize, not a serial (`--show-serial` stays off). It must still be `5` so a token
does not rename itself when it flips from sealed to revealed.

## Invariants

- Filenames stay **unpadded** (`1.jpg`, `1.json`). `CaseFlip.tokenURI()`
  concatenates `tokenId.toString()`, so padding the filenames 404s every token.
- Padding lives in `--digits` only, which drives both the printed serial and the
  metadata name.
- Reward amounts in the CSV are whole dollars; the on-chain values are 6-decimal
  USDG units. That conversion happens in `scripts/generate-reward-merkle.js`,
  never here.
