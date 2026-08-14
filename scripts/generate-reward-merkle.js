/**
 * Production reward Merkle tree generator for CaseFlip.
 *
 * Reads the reward CSV (token_id,reward — rewards in WHOLE DOLLARS), converts to
 * token base units, assigns a cryptographically random salt per token, builds the
 * tree, and verifies every single proof before writing anything.
 *
 * Leaf must match CaseFlip.reveal():
 *   keccak256(abi.encodePacked(uint256 tokenId, uint256 rewardAmount, bytes32 salt))
 * Pairs are sorted, matching OpenZeppelin MerkleProof.verifyCalldata.
 *
 * Usage:
 *   REWARD_CSV=~/Desktop/Case20K-Rewards.csv \
 *   OUT_DIR=~/Desktop/CaseFlip-Private \
 *   EXPECTED_POOL=10000000000 \
 *   node scripts/generate-reward-merkle.js
 *
 * The output file contains the full prize map. Keep it OFFLINE until
 * startReveal() has been mined. See the warning printed at the end.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const REWARD_DECIMALS = BigInt(process.env.REWARD_DECIMALS || 6);
const UNITS_PER_DOLLAR = 10n ** REWARD_DECIMALS;
const EXPECTED_SUPPLY = Number(process.env.EXPECTED_SUPPLY || 20000);

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

const CSV_PATH = expandHome(process.env.REWARD_CSV || path.join(os.homedir(), "Desktop", "Case20K-Rewards.csv"));
const OUT_DIR = expandHome(process.env.OUT_DIR || path.join(os.homedir(), "Desktop", "CaseFlip-Private"));

/* ---------------- Merkle primitives (identical to the verified testnet run) ---------------- */

function leafFor({ tokenId, rewardAmount, salt }) {
  return ethers.solidityPackedKeccak256(["uint256", "uint256", "bytes32"], [tokenId, rewardAmount, salt]);
}

function hashPair(a, b) {
  const [left, right] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([left, right]));
}

function buildTree(leaves) {
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  return layers;
}

function getProof(layers, index) {
  const proof = [];
  let idx = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const pair = idx ^ 1;
    if (pair < layers[level].length) proof.push(layers[level][pair]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Mirrors MerkleProof.processProof + sorted pairs. */
function verifyProof(proof, root, leaf) {
  let computed = leaf;
  for (const node of proof) computed = hashPair(computed, node);
  return computed === root;
}

/* ---------------- CSV ---------------- */

function readRewards(csvPath) {
  const text = fs.readFileSync(csvPath, "utf8").trim();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",").map(h => h.trim());
  const idIdx = header.indexOf("token_id");
  const rewardIdx = header.indexOf("reward");
  if (idIdx === -1 || rewardIdx === -1) {
    throw new Error(`CSV must have token_id and reward columns, got: ${header.join(",")}`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const tokenId = Number(cols[idIdx].trim());
    const dollars = cols[rewardIdx].trim();

    if (!Number.isInteger(tokenId) || tokenId < 1) throw new Error(`Bad token_id on line ${i + 1}: ${cols[idIdx]}`);
    if (!/^\d+$/.test(dollars)) {
      // Guard against decimals in the CSV — silent truncation here would misprice rewards.
      throw new Error(`Reward for token ${tokenId} is not a whole number: "${dollars}". Update this script before continuing.`);
    }

    rows.push({ tokenId, dollars: BigInt(dollars) });
  }
  return rows;
}

/* ---------------- main ---------------- */

function main() {
  console.log(`Reading ${CSV_PATH}`);
  const rows = readRewards(CSV_PATH);

  // --- integrity checks on the source data ---
  const ids = new Set();
  for (const r of rows) {
    if (ids.has(r.tokenId)) throw new Error(`Duplicate token_id in CSV: ${r.tokenId}`);
    ids.add(r.tokenId);
  }
  if (rows.length !== EXPECTED_SUPPLY) {
    throw new Error(`Expected ${EXPECTED_SUPPLY} rows, CSV has ${rows.length}`);
  }
  for (let id = 1; id <= EXPECTED_SUPPLY; id++) {
    if (!ids.has(id)) throw new Error(`CSV is missing token_id ${id}`);
  }

  // --- THE conversion: CSV holds whole dollars, the contract transfers base units ---
  const entries = rows.map(r => ({
    tokenId: r.tokenId,
    dollars: r.dollars,
    rewardAmount: r.dollars * UNITS_PER_DOLLAR,
    salt: "0x" + crypto.randomBytes(32).toString("hex")
  }));

  const totalDollars = entries.reduce((a, e) => a + e.dollars, 0n);
  const totalUnits = entries.reduce((a, e) => a + e.rewardAmount, 0n);
  const winners = entries.filter(e => e.rewardAmount > 0n).length;

  if (process.env.EXPECTED_POOL && totalUnits !== BigInt(process.env.EXPECTED_POOL)) {
    throw new Error(
      `Pool mismatch: tree totals ${totalUnits} units but EXPECTED_POOL is ${process.env.EXPECTED_POOL}. ` +
      `This value must equal the contract's totalRewardPool or startReveal() will revert.`
    );
  }

  // --- build + verify ---
  console.log(`Building tree over ${entries.length} leaves...`);
  const leaves = entries.map(leafFor);
  const layers = buildTree(leaves);
  const root = layers[layers.length - 1][0];

  console.log("Verifying every proof against the root...");
  const byToken = {};
  entries.forEach((e, i) => {
    const proof = getProof(layers, i);
    if (!verifyProof(proof, root, leaves[i])) {
      throw new Error(`Proof verification FAILED for token ${e.tokenId} — refusing to write output.`);
    }
    byToken[e.tokenId] = {
      tokenId: e.tokenId,
      rewardAmount: e.rewardAmount.toString(),
      salt: e.salt,
      proof
    };
  });

  // A wrong reward with a valid-looking proof must not verify.
  const probe = entries[0];
  const tampered = leafFor({ ...probe, rewardAmount: probe.rewardAmount + 1n });
  if (verifyProof(getProof(layers, 0), root, tampered)) {
    throw new Error("Tamper check failed: a modified reward verified against the root.");
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dataPath = path.join(OUT_DIR, "reveal-data.json");
  const rootPath = path.join(OUT_DIR, "merkle-root.txt");
  if (fs.existsSync(dataPath)) {
    throw new Error(`${dataPath} already exists. Salts are unrecoverable — move the old file aside before regenerating.`);
  }

  fs.writeFileSync(dataPath, JSON.stringify({
    merkleRoot: root,
    rewardDecimals: Number(REWARD_DECIMALS),
    totalRewardPool: totalUnits.toString(),
    supply: entries.length,
    winners,
    rewards: byToken
  }, null, 2));
  fs.writeFileSync(rootPath, root + "\n");

  console.log("\n--- Summary ---");
  console.log(`Supply           : ${entries.length}`);
  console.log(`Winners          : ${winners}`);
  console.log(`Total (dollars)  : ${totalDollars}`);
  console.log(`Total (units)    : ${totalUnits}   <-- fundRewardVault() / totalRewardPool`);
  console.log(`Merkle root      : ${root}`);
  console.log(`\nRoot written to  : ${rootPath}   (public)`);
  console.log(`Reveal data      : ${dataPath}   (PRIVATE)`);
  console.log(`
!! reveal-data.json is the complete prize map.
!! Do not commit, upload or host it until startReveal() is mined.
!! Back it up offline — the salts exist nowhere else, and without them
!! no holder can ever reveal.`);
}

main();
