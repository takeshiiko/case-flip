const { ethers } = require("hardhat");
const revealData = require("../generated/test-reveal-data.json");

async function main() {
  const contractAddress = process.env.CONTRACT_ADDRESS;
  const rewardTokenAddress = process.env.REWARD_TOKEN;
  const rewardPool = process.env.TEST_TOTAL_REWARD_POOL || "1000000";

  if (!contractAddress) {
    throw new Error("Missing env var: CONTRACT_ADDRESS");
  }
  if (!rewardTokenAddress) {
    throw new Error("Missing env var: REWARD_TOKEN");
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No signer found. Set DEPLOYER_PRIVATE_KEY before running this script.");
  }

  console.log("Signer:", signer.address);
  console.log("Merkle root:", revealData.merkleRoot);

  const rewardToken = await ethers.getContractAt("MockUSDG", rewardTokenAddress, signer);
  const caseFlip = await ethers.getContractAt("CaseFlip", contractAddress, signer);

  let tx = await caseFlip.setRewardMerkleRoot(revealData.merkleRoot);
  console.log("setRewardMerkleRoot tx:", tx.hash);
  await tx.wait();

  tx = await rewardToken.approve(contractAddress, rewardPool);
  console.log("approve tx:", tx.hash);
  await tx.wait();

  tx = await caseFlip.fundRewardVault(rewardPool);
  console.log("fundRewardVault tx:", tx.hash);
  await tx.wait();

  tx = await caseFlip.startReveal();
  console.log("startReveal tx:", tx.hash);
  await tx.wait();

  console.log("revealActive:", await caseFlip.revealActive());
  console.log("vault balance:", (await rewardToken.balanceOf(contractAddress)).toString());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
