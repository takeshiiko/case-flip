#!/usr/bin/env node
/**
 * Rewrite all metadata so each token's `image` points at the batch CID that
 * actually holds it.
 *
 * The contract only needs the metadata directory to be one CID — `tokenURI` is
 * baseURI + tokenId + ".json". The images behind it can be spread over as many
 * CIDs as the upload path can cope with.
 *
 *   node scripts/write-batched-metadata.js [manifest] [metadata-dir]
 * Defaults: ~/caseflip-assets/batches/batches.json
 *           ~/caseflip-assets/sealed-webp/metadata
 *
 * Refuses to write unless every batch has a CID and the ranges cover every
 * token exactly once — a gap would mean silently dead images.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const NAME_PREFIX = "Case Flip";
const PAD = 5;
const DESCRIPTION =
  "Case Flip is a 20,000-piece mystery case collection on Robinhood Chain. " +
  "Each NFT starts sealed and can be revealed after sellout to uncover a prize result, " +
  "with eligible rewards paid automatically to the holder's wallet.";

const home = p => p.replace(/^~/, os.homedir());
const manifestPath = home(process.argv[2] || "~/caseflip-assets/batches/batches.json");
const metaDir = home(process.argv[3] || "~/caseflip-assets/sealed-webp/metadata");

function fail(msg) { console.error(msg); process.exit(1); }

if (!fs.existsSync(manifestPath)) fail(`manifest not found: ${manifestPath}`);
if (!fs.existsSync(metaDir)) fail(`metadata dir not found: ${metaDir}`);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const { extension: ext, total, batches } = manifest;

const missing = batches.filter(b => !b.cid);
if (missing.length) {
  fail(`These batches still have no cid: ${missing.map(b => b.batch).join(", ")}\n` +
       `Fill them in in ${manifestPath} first.`);
}
for (const b of batches) {
  if (!/^(baf|Qm)[0-9a-zA-Z]+$/.test(b.cid)) {
    fail(`batch ${b.batch} has a cid that does not look like a CID: ${b.cid}`);
  }
}

// Every token must be covered exactly once.
const owner = new Map();
for (const b of batches) {
  for (let id = b.start; id <= b.end; id++) {
    if (owner.has(id)) fail(`token ${id} appears in batch ${owner.get(id).batch} and ${b.batch}`);
    owner.set(id, b);
  }
}
for (let id = 1; id <= total; id++) {
  if (!owner.has(id)) fail(`token ${id} is not covered by any batch`);
}

let written = 0;
const perBatch = new Map();
for (let id = 1; id <= total; id++) {
  const b = owner.get(id);
  const body = {
    name: `${NAME_PREFIX} #${String(id).padStart(PAD, "0")}`,
    description: DESCRIPTION,
    image: `ipfs://${b.cid}/${id}.${ext}`
  };
  fs.writeFileSync(path.join(metaDir, `${id}.json`), JSON.stringify(body, null, 2));
  perBatch.set(b.batch, (perBatch.get(b.batch) || 0) + 1);
  written++;
}

console.log(`wrote ${written} metadata files into ${metaDir}\n`);
for (const b of batches) {
  console.log(`  batch-${String(b.batch).padStart(2, "0")}  tokens ${b.start}-${b.end}  ${perBatch.get(b.batch)} files  ${b.cid}`);
}

// Read a couple back so the output is proof, not a claim.
const check = [1, Math.floor(total / 2), total];
console.log("\nspot check:");
for (const id of check) {
  const j = JSON.parse(fs.readFileSync(path.join(metaDir, `${id}.json`), "utf8"));
  const b = owner.get(id);
  const ok = j.image === `ipfs://${b.cid}/${id}.${ext}` && j.name === `${NAME_PREFIX} #${String(id).padStart(PAD, "0")}`;
  console.log(`  ${ok ? "OK  " : "BAD "} #${id}  ${j.image}`);
  if (!ok) process.exitCode = 1;
}

console.log(`
Next: repack and upload just the metadata (about 9 MB, that path already works).

  scripts/pack-for-pinata.sh   # will repack; ignore its image step
  or upload ~/caseflip-assets/sealed-webp/metadata as a folder

Then UNREVEALED_BASE_URI is ipfs://<metadata-cid>/`);
