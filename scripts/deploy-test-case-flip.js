const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  const mintPrice = process.env.TEST_MINT_PRICE || "53152755704620";
  const totalRewardPool = process.env.TEST_TOTAL_REWARD_POOL || "1000000";
  const unrevealedBaseURI = process.env.UNREVEALED_BASE_URI || "ipfs://TEST_UNREVEALED/";
  const revealedBaseURI = process.env.REVEALED_BASE_URI || "ipfs://TEST_REVEALED/";
  const treasury = process.env.TREASURY || deployer.address;

  const MockUSDG = await ethers.getContractFactory("MockUSDG");
  const mockUSDG = await MockUSDG.deploy(deployer.address);
  await mockUSDG.waitForDeployment();

  const rewardToken = await mockUSDG.getAddress();
  const CaseFlip = await ethers.getContractFactory("CaseFlip");
  const caseFlip = await CaseFlip.deploy(
    deployer.address,
    rewardToken,
    treasury,
    3,
    3,
    mintPrice,
    totalRewardPool,
    unrevealedBaseURI,
    revealedBaseURI
  );
  await caseFlip.waitForDeployment();

  await mockUSDG.mint(deployer.address, ethers.parseUnits("100", 6));

  console.log("MockUSDG deployed:", rewardToken);
  console.log("CaseFlip test deployed:", await caseFlip.getAddress());
  console.log("Owner:", deployer.address);
  console.log("Test maxSupply: 3");
  console.log("Test maxPerWallet: 3");
  console.log("Test mintPrice wei:", mintPrice);
  console.log("Test rewardPool units:", totalRewardPool);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
