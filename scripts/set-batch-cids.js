#!/usr/bin/env node
/**
 * Fill the batch CIDs into the manifest, then prove each one actually serves
 * the tokens it is supposed to.
 *
 * A transposed or mistyped CID would not fail loudly — the metadata would just
 * point 2,000 tokens at an image that does not exist. So every batch is checked
 * against the gateway for its first and last token before being accepted.
 *
 *   node scripts/set-batch-cids.js <cid1> <cid2> ... <cid10>      # in batch order
 *   node scripts/set-batch-cids.js 3=bafy... 7=bafy...            # or individually
 *   node scripts/set-batch-cids.js --verify                       # re-check what is stored
 *   node scripts/set-batch-cids.js --no-verify <cids...>          # skip the gateway check
 */

const fs = require("fs");
const os = require("os");

const MANIFEST = (process.env.BATCH_MANIFEST || "~/caseflip-assets/batches/batches.json")
  .replace(/^~/, os.homedir());
const GATEWAY = process.env.IPFS_GATEWAY || "https://gateway.pinata.cloud/ipfs";
const TIMEOUT = Number(process.env.VERIFY_TIMEOUT_MS || 90000);

const args = process.argv.slice(2);
const noVerify = args.includes("--no-verify");
const verifyOnly = args.includes("--verify");
const values = args.filter(a => !a.startsWith("--"));

if (!fs.existsSync(MANIFEST)) { console.error(`manifest not found: ${MANIFEST}`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const { batches, extension: ext } = manifest;

const looksLikeCid = s => /^(baf|Qm)[0-9a-zA-Z]+$/.test(s);

if (!verifyOnly && values.length) {
  if (values.every(v => v.includes("="))) {
    for (const pair of values) {
      const [n, cid] = pair.split("=");
      const b = batches.find(x => x.batch === Number(n));
      if (!b) { console.error(`no batch ${n}`); process.exit(1); }
      if (!looksLikeCid(cid)) { console.error(`batch ${n}: not a CID: ${cid}`); process.exit(1); }
      b.cid = cid;
    }
  } else {
    if (values.length !== batches.length) {
      console.error(`expected ${batches.length} CIDs in batch order, got ${values.length}.\n` +
                    `Use N=cid form to set individual batches.`);
      process.exit(1);
    }
    values.forEach((cid, i) => {
      if (!looksLikeCid(cid)) { console.error(`position ${i + 1}: not a CID: ${cid}`); process.exit(1); }
      batches[i].cid = cid;
    });
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${values.length} cid(s) to ${MANIFEST}\n`);
}

const filled = batches.filter(b => b.cid);
console.log(`${filled.length}/${batches.length} batches have a CID`);
for (const b of batches) {
  console.log(`  batch-${String(b.batch).padStart(2, "0")}  ${b.start}-${b.end}  ${b.cid || "(empty)"}`);
}

if (noVerify || !filled.length) process.exit(0);

async function head(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, signal: ctrl.signal });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  console.log(`\nverifying against ${GATEWAY} (first and last token of each batch)...`);
  let bad = 0;
  for (const b of filled) {
    const results = [];
    for (const id of [b.start, b.end]) {
      const status = await head(`${GATEWAY}/${b.cid}/${id}.${ext}`);
      results.push(`${id}:${status || "timeout"}`);
    }
    const ok = results.every(r => /:(200|206)$/.test(r));
    if (!ok) bad++;
    console.log(`  ${ok ? "OK  " : "FAIL"} batch-${String(b.batch).padStart(2, "0")}  ${results.join("  ")}`);
  }

  if (bad) {
    console.log(`\n${bad} batch(es) did not serve their tokens.`);
    console.log("Either the CID is wrong for that batch, or Pinata is still indexing it.");
    console.log("Re-run with --verify in a few minutes before writing metadata.");
    process.exitCode = 1;
  } else if (filled.length === batches.length) {
    console.log("\nAll batches verified. Now run:");
    console.log("  node scripts/write-batched-metadata.js");
  }
})();
