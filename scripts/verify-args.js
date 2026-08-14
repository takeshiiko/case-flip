/**
 * Constructor arguments for the deployed mainnet CaseFlip, in declaration order.
 * Used by `hardhat verify --constructor-args`.
 *
 * These are the exact values baked into 0xD47a0693e063765A2690CB87054242f6241Cf005
 * at block 36430093 — read back off-chain after deployment, not retyped.
 */
module.exports = [
  "0x255F24a7966AA2bA84D35e4af6bbc4bC1c06A2bc",                        // initialOwner
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",                        // rewardToken (USDG)
  "0x4f6D6bDC2fA087130f5EE50DA835f3d621c065eD",                        // treasury
  20000,                                                               // maxSupply
  10,                                                                  // maxPerWallet
  "550000000000000",                                                   // mintPrice (0.00055 ETH)
  "10000000000",                                                       // totalRewardPool (10,000 USDG)
  "ipfs://bafybeibgwqnd7k6ndogbsu5egbkquupu4oetqbdbsmrkdqspwuubsoact4/", // unrevealedBaseURI
  "ipfs://PLACEHOLDER_REVEALED/"                                       // revealedBaseURI
];
