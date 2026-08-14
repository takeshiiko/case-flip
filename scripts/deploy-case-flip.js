/**
 * Mainnet CaseFlip deployment.
 *
 * maxSupply, maxPerWallet, mintPrice, totalRewardPool and rewardToken are
 * immutable — a mistake in any of them can only be fixed by redeploying. So
 * every value is validated against the chain before a transaction is sent, and
 * everything is read back afterwards.
 *
 * Dry run (default):
 *   CONTRACT env vars... npx hardhat run scripts/deploy-case-flip.js --network robinhood
 * Live:
 *   ...same plus CONFIRM=yes
 *
 * Required:
 *   REWARD_TOKEN, TREASURY, MAX_SUPPLY, MAX_PER_WALLET, MINT_PRICE,
 *   TOTAL_REWARD_POOL, UNREVEALED_BASE_URI, REVEALED_BASE_URI
 * Optional:
 *   INITIAL_OWNER          defaults to the deploying wallet
 *   REWARD_DECIMALS        defaults to 6
 *   ALLOW_REAL_REVEALED_URI=yes  bypass the placeholder guard (see below)
 */

const { ethers } = require("hardhat");

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

const REQUIRED = [
  "REWARD_TOKEN", "TREASURY", "MAX_SUPPLY", "MAX_PER_WALLET",
  "MINT_PRICE", "TOTAL_REWARD_POOL", "UNREVEALED_BASE_URI", "REVEALED_BASE_URI"
];

function fail(msg) {
  throw new Error(msg);
}

function checksum(label, value) {
  try {
    return ethers.getAddress(value);
  } catch {
    return fail(`${label} is not a valid address: ${value}`);
  }
}

async function main() {
  const live = process.env.CONFIRM === "yes";
  const missing = REQUIRED.filter(k => !process.env[k]);
  if (missing.length) fail(`Missing env vars: ${missing.join(", ")}`);

  const rewardToken = checksum("REWARD_TOKEN", process.env.REWARD_TOKEN);
  const treasury = checksum("TREASURY", process.env.TREASURY);
  const maxSupply = BigInt(process.env.MAX_SUPPLY);
  const maxPerWallet = BigInt(process.env.MAX_PER_WALLET);
  const mintPrice = BigInt(process.env.MINT_PRICE);
  const totalRewardPool = BigInt(process.env.TOTAL_REWARD_POOL);
  const unrevealedBaseURI = process.env.UNREVEALED_BASE_URI;
  const revealedBaseURI = process.env.REVEALED_BASE_URI;
  const rewardDecimals = BigInt(process.env.REWARD_DECIMALS || 6);

  // A dry run must work with no key present, so the signer is optional until
  // CONFIRM=yes. Every read below goes through the provider, not the signer.
  const [deployer] = await ethers.getSigners();
  if (live && !deployer) fail("No signer. Set DEPLOYER_PRIVATE_KEY.");

  const initialOwner = process.env.INITIAL_OWNER
    ? checksum("INITIAL_OWNER", process.env.INITIAL_OWNER)
    : (deployer ? deployer.address : null);
  if (live && !initialOwner) fail("Cannot resolve the initial owner.");

  // ---- config sanity (mirrors the constructor's own reverts, but earlier) ----
  if (maxSupply === 0n) fail("MAX_SUPPLY is 0");
  if (maxPerWallet === 0n) fail("MAX_PER_WALLET is 0");
  if (maxPerWallet > maxSupply) fail("MAX_PER_WALLET exceeds MAX_SUPPLY");
  if (mintPrice === 0n) fail("MINT_PRICE is 0 — minting would be free");
  if (totalRewardPool === 0n) fail("TOTAL_REWARD_POOL is 0 — startReveal() could never be satisfied");

  // tokenURI() concatenates directly: base + tokenId + ".json"
  for (const [label, uri] of [["UNREVEALED_BASE_URI", unrevealedBaseURI], ["REVEALED_BASE_URI", revealedBaseURI]]) {
    if (!uri.endsWith("/")) fail(`${label} must end with "/" or every tokenURI will be malformed: ${uri}`);
  }

  // Each revealed image has its prize printed on it, so a real revealed CID
  // published before startReveal() leaks the entire prize map.
  const looksReal = /^ipfs:\/\/(baf|Qm)/i.test(revealedBaseURI);
  if (looksReal && process.env.ALLOW_REAL_REVEALED_URI !== "yes") {
    fail(
      "REVEALED_BASE_URI looks like a real IPFS CID. Deploy with a placeholder and " +
      "set the real one via setBaseURI only after startReveal() is mined. " +
      "Pass ALLOW_REAL_REVEALED_URI=yes to override."
    );
  }

  // ---- verify the reward token on-chain ----
  const token = new ethers.Contract(rewardToken, ERC20_ABI, ethers.provider);
  const code = await ethers.provider.getCode(rewardToken);
  if (code === "0x") fail(`REWARD_TOKEN has no contract code on this network: ${rewardToken}`);

  let symbol, decimals;
  try {
    [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  } catch {
    fail(`REWARD_TOKEN does not respond as an ERC20: ${rewardToken}`);
  }
  if (BigInt(decimals) !== rewardDecimals) {
    fail(`REWARD_TOKEN has ${decimals} decimals but REWARD_DECIMALS is ${rewardDecimals}. ` +
         `TOTAL_REWARD_POOL would be wrong by 10^${Math.abs(Number(decimals) - Number(rewardDecimals))}.`);
  }

  const net = await ethers.provider.getNetwork();
  const balance = deployer ? await ethers.provider.getBalance(deployer.address) : null;
  const poolHuman = ethers.formatUnits(totalRewardPool, decimals);
  const priceEth = ethers.formatEther(mintPrice);

  console.log("=".repeat(64));
  console.log("  CaseFlip deployment");
  console.log("=".repeat(64));
  console.log(`network         : ${net.name} (chainId ${net.chainId})`);
  console.log(`deployer        : ${deployer ? deployer.address : "(no key set — dry run only)"}`);
  console.log(`deployer balance: ${balance === null ? "-" : ethers.formatEther(balance) + " ETH"}`);
  console.log(`initial owner   : ${initialOwner || "(will be the deployer)"}` +
              `${deployer && initialOwner === deployer.address ? "  (= deployer)" : ""}`);
  console.log(`treasury        : ${treasury}`);
  console.log("-".repeat(64));
  console.log("IMMUTABLE — cannot be changed after deployment:");
  console.log(`  maxSupply       : ${maxSupply}`);
  console.log(`  maxPerWallet    : ${maxPerWallet}`);
  console.log(`  mintPrice       : ${mintPrice} wei  (${priceEth} ETH)`);
  console.log(`  totalRewardPool : ${totalRewardPool}  (${poolHuman} ${symbol})`);
  console.log(`  rewardToken     : ${rewardToken}  (${symbol}, ${decimals} decimals)`);
  console.log("-".repeat(64));
  console.log("Changeable later via setBaseURI / setTreasury:");
  console.log(`  unrevealedBaseURI : ${unrevealedBaseURI}`);
  console.log(`  revealedBaseURI   : ${revealedBaseURI}${looksReal ? "" : "   (placeholder — set the real CID at reveal time)"}`);
  console.log("=".repeat(64));

  if (balance === 0n) {
    console.log("\nWARNING: deployer has 0 ETH on this network. Fund it before deploying.\n");
  }

  if (!live) {
    console.log("\nDry run. Nothing was sent. Re-run with CONFIRM=yes to deploy.");
    return;
  }

  const CaseFlip = await ethers.getContractFactory("CaseFlip");
  const vault = await CaseFlip.deploy(
    initialOwner, rewardToken, treasury,
    maxSupply, maxPerWallet, mintPrice, totalRewardPool,
    unrevealedBaseURI, revealedBaseURI
  );
  console.log(`\ndeploy tx : ${vault.deploymentTransaction().hash}`);
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  const receipt = await ethers.provider.getTransactionReceipt(vault.deploymentTransaction().hash);

  // ---- read everything back ----
  const [oMaxSupply, oMaxPerWallet, oMintPrice, oPool, oToken, oTreasury, oOwner, oSale, oReveal] =
    await Promise.all([
      vault.maxSupply(), vault.maxPerWallet(), vault.mintPrice(), vault.totalRewardPool(),
      vault.rewardToken(), vault.treasury(), vault.owner(), vault.saleActive(), vault.revealActive()
    ]);

  const checks = [
    ["maxSupply", oMaxSupply === maxSupply],
    ["maxPerWallet", oMaxPerWallet === maxPerWallet],
    ["mintPrice", oMintPrice === mintPrice],
    ["totalRewardPool", oPool === totalRewardPool],
    ["rewardToken", oToken === rewardToken],
    ["treasury", oTreasury === treasury],
    ["owner", oOwner === initialOwner],
    ["saleActive is false", oSale === false],
    ["revealActive is false", oReveal === false]
  ];

  console.log(`\nCaseFlip deployed: ${address}`);
  console.log(`deployed in block : ${receipt.blockNumber}   <-- set DEPLOY_BLOCK in index.html to this`);
  console.log("\npost-deploy verification:");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "OK  " : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }
  if (!ok) fail("Deployed contract does not match the requested config. Do NOT open the sale.");

  console.log("\nNext: verify the source on the explorer, then setSaleActive(true) when you are ready.");
}

main().catch(error => {
  console.error("\n" + (error.message || error));
  process.exitCode = 1;
});
