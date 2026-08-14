const { ethers } = require("hardhat");

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const active = process.env.SALE_ACTIVE !== "false";

  if (!contractAddress) {
    throw new Error("Missing env var: CONTRACT_ADDRESS");
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer found. Set DEPLOYER_PRIVATE_KEY before running this script.");
  }

  console.log("Signer:", signer.address);

  const caseFlip = await ethers.getContractAt("CaseFlip", contractAddress, signer);
  const tx = await caseFlip.setSaleActive(active);
  console.log("setSaleActive tx:", tx.hash);
  await tx.wait();
  console.log("saleActive:", await caseFlip.saleActive());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
