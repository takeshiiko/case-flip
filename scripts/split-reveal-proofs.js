/**
 * Split reveal-data.json into one small file per token, which is what the site
 * fetches from REVEAL_PROOF_BASE.
 *
 * The single file is ~20 MB; a holder only needs their own ~400 byte entry.
 *
 * Run this AFTER startReveal() is mined. Publishing the output earlier exposes
 * the whole prize map.
 *
 * Usage:
 *   REVEAL_DATA=~/Desktop/CaseFlip-Private/reveal-data.json \
 *   OUT_DIR=~/Desktop/CaseFlip-Private/proofs \
 *   node scripts/split-reveal-proofs.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

const SRC = expandHome(process.env.REVEAL_DATA || "~/Desktop/CaseFlip-Private/reveal-data.json");
const OUT = expandHome(process.env.OUT_DIR || "~/Desktop/CaseFlip-Private/proofs");

function main() {
  const data = JSON.parse(fs.readFileSync(SRC, "utf8"));
  const entries = Object.values(data.rewards);
  if (!entries.length) throw new Error("No rewards in reveal data.");

  fs.mkdirSync(OUT, { recursive: true });

  let total = 0n;
  let bytes = 0;
  for (const entry of entries) {
    const body = JSON.stringify({
      tokenId: entry.tokenId,
      rewardAmount: entry.rewardAmount,
      salt: entry.salt,
      proof: entry.proof
    });
    fs.writeFileSync(path.join(OUT, `${entry.tokenId}.json`), body);
    total += BigInt(entry.rewardAmount);
    bytes += body.length;
  }

  // The site never sends the root, but publishing it lets anyone verify a proof
  // independently against what the contract stores.
  fs.writeFileSync(path.join(OUT, "root.json"), JSON.stringify({
    merkleRoot: data.merkleRoot,
    totalRewardPool: data.totalRewardPool,
    supply: data.supply
  }, null, 2));

  console.log(`Wrote ${entries.length} proof files to ${OUT}`);
  console.log(`Total size   : ${(bytes / 1e6).toFixed(1)} MB  (avg ${Math.round(bytes / entries.length)} bytes)`);
  console.log(`Pool check   : ${total} units`);
  if (total !== BigInt(data.totalRewardPool)) {
    throw new Error(`Split totals ${total} but reveal-data says ${data.totalRewardPool}`);
  }
  console.log(`Root         : ${data.merkleRoot}`);
  console.log("");
  console.log("Serve this directory so that <base>/<tokenId>.json resolves, then set");
  console.log("REVEAL_PROOF_BASE in index.html. Only after startReveal() is mined.");
}

main();
