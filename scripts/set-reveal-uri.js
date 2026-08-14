/**
 * Point revealedBaseURI at the real CID after startReveal() is mined.
 *
 * setBaseURI() overwrites BOTH URIs in one call, and unrevealedBaseURI has no
 * public getter — so passing only the revealed one would silently wipe the
 * sealed URI and break the metadata of every unopened token.
 *
 * This script recovers the current sealed base from tokenURI() of a token that
 * is still unrevealed (tokenURI returns `<base><id>.json`, so the suffix is
 * stripped), and passes it back unchanged.
 *
 *   CONTRACT_ADDRESS=0x... REVEALED_BASE_URI="ipfs://<cid>/" \
 *   npx hardhat run scripts/set-reveal-uri.js --network robinhood
 *
 * Add CONFIRM=yes to send. UNREVEALED_BASE_URI overrides the recovery if every
 * token has already been revealed.
 */

const { ethers } = require("hardhat");

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const revealedBaseURI = process.env.REVEALED_BASE_URI;
  const live = process.env.CONFIRM === "yes";

  if (!contractAddress) throw new Error("Missing env var: CONTRACT_ADDRESS");
  if (!revealedBaseURI) throw new Error("Missing env var: REVEALED_BASE_URI");
  if (!revealedBaseURI.endsWith("/")) {
    throw new Error(`REVEALED_BASE_URI must end with "/": ${revealedBaseURI}`);
  }

  const [signer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("CaseFlip", contractAddress, signer || undefined);

  const [owner, revealActive, maxSupply] = await Promise.all([
    vault.owner(), vault.revealActive(), vault.maxSupply()
  ]);

  // Publishing the revealed CID before reveal is open exposes the prize map.
  if (!revealActive) {
    throw new Error("revealActive is false. Run startReveal() first — the revealed art shows each prize.");
  }

  let sealedBase = process.env.UNREVEALED_BASE_URI;
  if (!sealedBase) {
    let found = null;
    for (let id = 1n; id <= maxSupply && id <= 200n; id++) {
      if (!(await vault.revealed(id))) { found = id; break; }
    }
    if (found === null) {
      throw new Error("Could not find an unrevealed token to recover the sealed URI from. Pass UNREVEALED_BASE_URI explicitly.");
    }
    const uri = await vault.tokenURI(found);
    const suffix = `${found}.json`;
    if (!uri.endsWith(suffix)) throw new Error(`Unexpected tokenURI shape: ${uri}`);
    sealedBase = uri.slice(0, -suffix.length);
    console.log(`recovered sealed base from token #${found}: ${sealedBase}`);
  }

  if (!sealedBase.endsWith("/")) throw new Error(`Recovered sealed base does not end with "/": ${sealedBase}`);

  console.log("");
  console.log(`contract        : ${contractAddress}`);
  console.log(`owner           : ${owner}`);
  console.log(`signer          : ${signer ? signer.address : "(none)"}`);
  console.log(`unrevealed (keep): ${sealedBase}`);
  console.log(`revealed   (new) : ${revealedBaseURI}`);
  console.log(`mode            : ${live ? "LIVE" : "dry run (set CONFIRM=yes to send)"}`);

  if (!live) return;
  if (!signer) throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY.");
  if (owner.toLowerCase() !== signer.address.toLowerCase()) throw new Error("Signer is not the owner.");

  const tx = await vault.setBaseURI(sealedBase, revealedBaseURI);
  console.log(`\nsetBaseURI tx: ${tx.hash}`);
  await tx.wait();

  // Confirm both sides still resolve the way they should.
  let sealedCheck = null;
  for (let id = 1n; id <= maxSupply && id <= 200n; id++) {
    if (!(await vault.revealed(id))) { sealedCheck = await vault.tokenURI(id); break; }
  }
  let revealedCheck = null;
  for (let id = 1n; id <= maxSupply && id <= 200n; id++) {
    if (await vault.revealed(id)) { revealedCheck = await vault.tokenURI(id); break; }
  }

  console.log("\nafter:");
  console.log(`  an unrevealed tokenURI: ${sealedCheck ?? "(none left)"}`);
  console.log(`  a revealed tokenURI   : ${revealedCheck ?? "(none revealed yet)"}`);
  if (sealedCheck && !sealedCheck.startsWith(sealedBase)) {
    throw new Error("Sealed URI no longer matches — investigate before announcing.");
  }
}

main().catch(error => {
  console.error("\n" + (error.message || error));
  process.exitCode = 1;
});
