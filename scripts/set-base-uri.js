const { ethers } = require("hardhat");

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const unrevealedBaseURI = process.env.UNREVEALED_BASE_URI;
  const revealedBaseURI = process.env.REVEALED_BASE_URI || "ipfs://TEST_REVEALED/";

  if (!contractAddress) {
    throw new Error("Missing env var: CONTRACT_ADDRESS");
  }
  if (!unrevealedBaseURI) {
    throw new Error("Missing env var: UNREVEALED_BASE_URI");
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer found. Set DEPLOYER_PRIVATE_KEY before running this script.");
  }

  console.log("Signer:", signer.address);
  console.log("Unrevealed:", unrevealedBaseURI);
  console.log("Revealed:", revealedBaseURI);

  const caseFlip = await ethers.getContractAt("CaseFlip", contractAddress, signer);
  const tx = await caseFlip.setBaseURI(unrevealedBaseURI, revealedBaseURI);
  console.log("setBaseURI tx:", tx.hash);
  await tx.wait();
  console.log("tokenURI(1):", await caseFlip.tokenURI(1));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
