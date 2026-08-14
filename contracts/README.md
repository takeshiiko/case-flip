# Case Flip Contracts

`CaseFlip.sol` is an ERC-721 NFT contract for the Case Flip collection.

## Mainnet Config

```text
Network: Robinhood Chain
Chain ID: 4663
Mint payment: native ETH
Reward payment: USDG
USDG: 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
USDG decimals: 6
Max supply: 20,000
Max mint per wallet: 10
Reward pool: 10,000 USDG = 10000000000 units
```

Using the current reference price provided in chat:

```text
ETH reference price: $1,881.37
$1 mint price:       0.000531527557046195 ETH
$0.10 test mint:     0.000053152755704620 ETH
```

In wei:

```text
MAINNET_MINT_PRICE = 531527557046195
TEST_MINT_PRICE    = 53152755704620
```

Important: mint price is fixed in ETH. If ETH price changes, the USD equivalent changes unless we update deploy parameters before deployment.

## Testnet Config

Robinhood Chain Testnet:

```text
Chain ID: 46630
RPC: https://rpc.testnet.chain.robinhood.com
Explorer: https://explorer.testnet.chain.robinhood.com
Faucet: https://faucet.testnet.chain.robinhood.com
```

No official USDG testnet token address was found in the current Robinhood docs. For testnet, deploy `MockUSDG` with 6 decimals and use it as `rewardToken`.

Recommended test collection:

```text
maxSupply = 3
maxPerWallet = 3
mintPrice = 53152755704620 wei
rewardPool = 1 USDG = 1000000 units
```

## Constructor

```solidity
constructor(
    address initialOwner,
    address rewardToken_,
    address treasury_,
    uint256 maxSupply_,
    uint256 maxPerWallet_,
    uint256 mintPrice_,
    uint256 totalRewardPool_,
    string memory unrevealedBaseURI_,
    string memory revealedBaseURI_
)
```

## Reveal Leaf

The Merkle leaf format is:

```solidity
keccak256(abi.encodePacked(tokenId, rewardAmount, salt))
```

`rewardAmount` is denominated in reward token units. For USDG with 6 decimals:

```text
$0    = 0
$1    = 1000000
$2    = 2000000
$5    = 5000000
$1000 = 1000000000
```

## Expected Flow

1. Deploy `CaseFlip`.
2. Upload unrevealed metadata to IPFS.
3. Enable sale with `setSaleActive(true)`.
4. Users mint with ETH.
5. Sold out.
6. Approve USDG to the contract.
7. Fund reward vault with `fundRewardVault(10000000000)`.
8. Set Merkle root with `setRewardMerkleRoot(root)`.
9. Start reveal with `startReveal()`.
10. User calls `reveal(tokenId, rewardAmount, salt, proof)`.

Reveal starts only if sold out, Merkle root is set, and USDG vault is fully funded.
