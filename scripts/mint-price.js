/**
 * Work out MINT_PRICE in wei for a target USD price.
 *
 * mintPrice is immutable, so this is a one-shot decision made at deploy time.
 * Run it minutes before deploying, with a live ETH price you trust.
 *
 *   ETH_USD=3120.55 node scripts/mint-price.js
 *   ETH_USD=3120.55 USD_TARGET=1 SUPPLY=20000 node scripts/mint-price.js
 *
 * The price source is deliberately manual — no oracle, no API. Read it off an
 * exchange yourself so the number that gets frozen into the contract is one you
 * actually chose.
 */

const { ethers } = require("ethers");

const ethUsd = Number(process.env.ETH_USD);
const usdTarget = Number(process.env.USD_TARGET || 1);
const supply = BigInt(process.env.SUPPLY || 20000);

if (!Number.isFinite(ethUsd) || ethUsd <= 0) {
  console.error("Set ETH_USD to the current ETH price, e.g. ETH_USD=3120.55 node scripts/mint-price.js");
  process.exit(1);
}
if (!Number.isFinite(usdTarget) || usdTarget <= 0) {
  console.error("USD_TARGET must be positive.");
  process.exit(1);
}

// Do the division in wei-space to avoid float drift in the value that gets frozen.
const SCALE = 10n ** 18n;
const usdTargetScaled = BigInt(Math.round(usdTarget * 1e6));
const ethUsdScaled = BigInt(Math.round(ethUsd * 1e6));
const wei = (usdTargetScaled * SCALE) / ethUsdScaled;

const backToUsd = (Number(wei) / 1e18) * ethUsd;
const grossWei = wei * supply;

console.log(`ETH price      : $${ethUsd.toLocaleString("en-US")}`);
console.log(`target per mint: $${usdTarget}`);
console.log("");
console.log(`MINT_PRICE     : ${wei}`);
console.log(`               = ${ethers.formatEther(wei)} ETH`);
console.log(`               = $${backToUsd.toFixed(6)} at the price above`);
console.log("");
console.log(`full sellout   : ${supply} x ${ethers.formatEther(wei)} = ${ethers.formatEther(grossWei)} ETH`);
console.log(`               ≈ $${((Number(grossWei) / 1e18) * ethUsd).toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
console.log("");
console.log("Export it for the deploy:");
console.log(`  export MINT_PRICE=${wei}`);
console.log("");
console.log("Note: this freezes on deploy. If ETH doubles, a mint costs $2 and");
console.log("sellout gets harder — and reveal needs a full sellout.");
