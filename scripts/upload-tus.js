#!/usr/bin/env node
/**
 * Resumable (TUS) upload to Pinata for files over 100MB.
 *
 * Direct multipart tops out around 100MB — a 1GB CAR comes back as
 * `503 / error code: 1102`, which is Cloudflare rejecting the request body.
 * The same endpoint speaks TUS, so the file goes up in chunks and survives a
 * dropped connection.
 *
 * Whether Pinata honours `car=true` over TUS is not documented. If it is
 * ignored, the returned CID is the hash of the .car blob itself rather than the
 * DAG root, and the collection would be silently broken — so the CID is checked
 * against the CAR's own root before anything is reported as successful.
 *
 *   export PINATA_JWT='...'
 *   node scripts/upload-tus.js ~/caseflip-assets/car/images.car --car --expect <root-cid>
 *
 * Progress is written to a .tusupload file next to the target so an interrupted
 * run resumes instead of restarting.
 */

const fs = require("fs");
const path = require("path");

const ENDPOINT = "https://uploads.pinata.cloud/v3/files";
// Pinata allows up to 50MB per chunk, but a big chunk is a long-lived request:
// when their backend sheds load (500 "Durable Object is overloaded", 502) the
// whole chunk is lost and retried. Smaller chunks fail less and redo less.
const CHUNK = Number(process.env.TUS_CHUNK_MB || 16) * 1024 * 1024;
const MAX_ATTEMPTS = Number(process.env.TUS_MAX_ATTEMPTS || 40);
const backoffFor = n => Math.min(3000 * Math.pow(1.6, Math.min(n, 8)), 60000);

const args = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith("--"));
const isCar = args.includes("--car");
const expectIdx = args.indexOf("--expect");
const expected = expectIdx !== -1 ? args[expectIdx + 1] : null;

const JWT = process.env.PINATA_JWT;
if (!JWT) { console.error("Set PINATA_JWT first."); process.exit(1); }
if (!filePath || !fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }

const size = fs.statSync(filePath).size;
const name = path.basename(filePath);
const statePath = `${filePath}.tusupload`;

const b64 = s => Buffer.from(String(s)).toString("base64");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mb = n => (n / 1024 / 1024).toFixed(1);

function metadataHeader() {
  const pairs = [
    ["filename", name],
    ["name", name],
    ["network", "public"]
  ];
  // Only meaningful if Pinata reads it over TUS; verified afterwards either way.
  if (isCar) pairs.push(["car", "true"]);
  return pairs.map(([k, v]) => `${k} ${b64(v)}`).join(",");
}

async function withRetry(label, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= 8) throw err;
      const wait = backoffFor(attempt);
      console.log(`  ${label} failed (${short(err.message)}) — retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

/** Collapse the HTML error pages Cloudflare returns into one readable line. */
function short(msg) {
  const m = String(msg).replace(/\s+/g, " ").trim();
  const code = m.match(/^(\w+ failed: \d+)/);
  const detail = m.match(/"message":"([^"]+)"/)
    || m.match(/"error":"([^"]+)"/)
    || m.match(/<title>\s*\d*\s*([^<]+?)\s*<\/title>/);
  return detail ? `${code ? code[1] : ""} ${detail[1]}`.trim() : m.slice(0, 120);
}

async function createUpload() {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${JWT}`,
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(size),
      "Upload-Metadata": metadataHeader()
    }
  });
  if (!(res.status === 201 || res.status === 200)) {
    throw new Error(`create failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const location = res.headers.get("location");
  if (!location) throw new Error("no Location header on create");
  return location.startsWith("http") ? location : new URL(location, ENDPOINT).toString();
}

async function currentOffset(url) {
  const res = await fetch(url, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${JWT}`, "Tus-Resumable": "1.0.0" }
  });
  if (!res.ok) throw new Error(`HEAD failed: ${res.status}`);
  return Number(res.headers.get("upload-offset") || 0);
}

async function sendChunk(url, offset) {
  const end = Math.min(offset + CHUNK, size);
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(end - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${JWT}`,
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": String(offset),
      "Content-Type": "application/offset+octet-stream"
    },
    body: buf
  });
  if (res.status !== 204 && res.status !== 200) {
    throw new Error(`PATCH failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  let body = null;
  try { body = await res.clone().json(); } catch { /* usually empty */ }
  return { offset: Number(res.headers.get("upload-offset") || end), body };
}

async function main() {
  console.log(`file  : ${filePath}`);
  console.log(`size  : ${mb(size)} MB`);
  console.log(`mode  : TUS${isCar ? " + car=true" : ""}`);
  if (expected) console.log(`expect: ${expected}`);
  console.log();

  let url = null;
  if (fs.existsSync(statePath)) {
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (saved.size === size) {
      url = saved.url;
      console.log("resuming previous upload");
    }
  }
  if (!url) {
    url = await withRetry("create", createUpload);
    fs.writeFileSync(statePath, JSON.stringify({ url, size }));
  }

  let offset = await withRetry("offset", () => currentOffset(url));
  let last = null;
  let attempts = 0;
  const started = Date.now();
  const startOffset = offset;

  while (offset < size) {
    try {
      const result = await sendChunk(url, offset);
      offset = result.offset;
      if (result.body) last = result.body;
      attempts = 0;

      const pct = ((offset / size) * 100).toFixed(1);
      const secs = (Date.now() - started) / 1000;
      const rate = (offset - startOffset) / 1024 / 1024 / secs;
      const eta = rate > 0 ? Math.round((size - offset) / 1024 / 1024 / rate) : 0;
      process.stdout.write(
        `\r  ${pct}%  ${mb(offset)}/${mb(size)} MB  ${rate.toFixed(1)} MB/s  ETA ${Math.floor(eta / 60)}m${eta % 60}s   `
      );
    } catch (err) {
      attempts++;
      if (attempts > MAX_ATTEMPTS) throw err;
      const wait = backoffFor(attempts);
      process.stdout.write(`\n  ${short(err.message)} — retry ${attempts}/${MAX_ATTEMPTS} in ${Math.round(wait / 1000)}s\n`);
      await sleep(wait);

      // The server may have persisted part of the failed chunk. Re-reading its
      // offset instead of blindly resending is what prevents the
      // "409 incorrect upload offset" spiral.
      try {
        offset = await currentOffset(url);
      } catch { /* keep the old offset and let the next attempt sort it out */ }
    }
  }
  console.log("\n");

  fs.unlinkSync(statePath);

  const cid = last?.data?.cid ?? last?.cid ?? null;
  console.log(`returned CID: ${cid ?? "(not in response — check the Pinata dashboard)"}`);

  if (expected && cid) {
    if (cid === expected) {
      console.log(`\nOK — CID matches the CAR root. Metadata links are valid.`);
    } else {
      console.log(`\nMISMATCH — expected ${expected}`);
      console.log(`This means car=true was not honoured over TUS: the CID above is the`);
      console.log(`hash of the .car blob, not the directory root. Do not deploy with it.`);
      process.exitCode = 1;
    }
  }
}

main().catch(err => {
  console.error(`\n${err.message}`);
  console.error("Re-run the same command to resume from where it stopped.");
  process.exitCode = 1;
});
