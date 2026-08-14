/**
 * Mainnet reveal opener. Runs the four steps in order, checking state before
 * each one so a half-finished run can be re-run safely.
 *
 *   setRewardMerkleRoot -> approve -> fundRewardVault -> startReveal
 *
 * Unlike start-test-reveal.js this talks to the real reward token through the
 * ERC20 interface (no MockUSDG) and reads the root from the production
 * reveal-data.json produced by generate-reward-merkle.js.
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... \
 *   REVEAL_DATA=~/Desktop/CaseFlip-Private/reveal-data.json \
 *   npx hardhat run scripts/start-reveal.js --network robinhood
 *
 * Add CONFIRM=yes to actually send transactions. Without it the script only
 * reports what it would do.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const revealDataPath = expandHome(process.env.REVEAL_DATA || "~/Desktop/CaseFlip-Private/reveal-data.json");
  const live = process.env.CONFIRM === "yes";

  if (!contractAddress) throw new Error("Missing env var: CONTRACT_ADDRESS");
  if (!fs.existsSync(revealDataPath)) throw new Error(`Reveal data not found: ${revealDataPath}`);

  const revealData = JSON.parse(fs.readFileSync(revealDataPath, "utf8"));
  const root = revealData.merkleRoot;
  if (!/^0x[0-9a-fA-F]{64}$/.test(root)) throw new Error(`Bad merkleRoot in ${revealDataPath}`);

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY.");

  const vault = await ethers.getContractAt("CaseFlip", contractAddress, signer);
  const token = new ethers.Contract(await vault.rewardToken(), ERC20_ABI, signer);

  const [symbol, decimals, pool, minted, maxSupply, currentRoot, revealActive, vaultBalance, owner] = await Promise.all([
    token.symbol(), token.decimals(),
    vault.totalRewardPool(), vault.totalMinted(), vault.maxSupply(),
    vault.rewardMerkleRoot(), vault.revealActive(),
    token.balanceOf(contractAddress), vault.owner()
  ]);

  const fmt = v => `${ethers.formatUnits(v, decimals)} ${symbol}`;

  console.log(`Signer          : ${signer.address}`);
  console.log(`Contract owner  : ${owner}`);
  console.log(`Reward token    : ${await token.getAddress()} (${symbol}, ${decimals} decimals)`);
  console.log(`Supply          : ${minted} / ${maxSupply}`);
  console.log(`Required pool   : ${fmt(pool)}`);
  console.log(`Vault balance   : ${fmt(vaultBalance)}`);
  console.log(`Root on-chain   : ${currentRoot}`);
  console.log(`Root in file    : ${root}`);
  console.log(`revealActive    : ${revealActive}`);
  console.log(`Mode            : ${live ? "LIVE" : "dry run (set CONFIRM=yes to send)"}`);
  console.log("");

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("Signer is not the contract owner.");
  }
  if (revealActive) {
    console.log("Reveal is already active. Nothing to do.");
    return;
  }
  if (minted !== maxSupply) {
    throw new Error(`Not sold out (${minted}/${maxSupply}). startReveal() would revert.`);
  }

  // Cross-check the file against the contract before touching anything.
  const fileTotal = BigInt(revealData.totalRewardPool);
  if (fileTotal !== pool) {
    throw new Error(`reveal-data.json totals ${fileTotal} but the contract expects ${pool}.`);
  }
  if (Number(revealData.supply) !== Number(maxSupply)) {
    throw new Error(`reveal-data.json covers ${revealData.supply} tokens, contract maxSupply is ${maxSupply}.`);
  }

  const send = async (label, fn) => {
    if (!live) return console.log(`[dry run] would ${label}`);
    const tx = await fn();
    console.log(`${label} -> ${tx.hash}`);
    await tx.wait();
  };

  if (currentRoot.toLowerCase() !== root.toLowerCase()) {
    await send("setRewardMerkleRoot", () => vault.setRewardMerkleRoot(root));
  } else {
    console.log("Root already set, skipping.");
  }

  const missing = pool > vaultBalance ? pool - vaultBalance : 0n;
  if (missing > 0n) {
    const holderBalance = await token.balanceOf(signer.address);
    if (holderBalance < missing) {
      throw new Error(`Need ${fmt(missing)} more in the vault but the signer only holds ${fmt(holderBalance)}.`);
    }
    const allowance = await token.allowance(signer.address, contractAddress);
    if (allowance < missing) {
      await send(`approve ${fmt(missing)}`, () => token.approve(contractAddress, missing));
    }
    await send(`fundRewardVault ${fmt(missing)}`, () => vault.fundRewardVault(missing));
  } else {
    console.log("Reward vault already funded, skipping.");
  }

  await send("startReveal", () => vault.startReveal());

  if (live) {
    console.log("");
    console.log(`revealActive : ${await vault.revealActive()}`);
    console.log(`vault balance: ${fmt(await token.balanceOf(contractAddress))}`);
    const unlocksAt = await vault.sweepUnlocksAt();
    console.log(`sweep unlocks: ${new Date(Number(unlocksAt) * 1000).toISOString()}`);
    console.log("");
    console.log("Reveal is open. NOW publish the per-token proof files and point");
    console.log("REVEAL_PROOF_BASE in index.html at them. Not before this line.");
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
