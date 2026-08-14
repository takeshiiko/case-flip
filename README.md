# Case Flip

A 20,000-piece mystery case collection on Robinhood Chain. Each NFT starts
sealed. Once the collection sells out, holders can open their case to uncover a
prize result, and any reward is paid to their wallet in the same transaction.

**Contract:** [`0xD47a0693e063765A2690CB87054242f6241Cf005`](https://robinhoodchain.blockscout.com/address/0xD47a0693e063765A2690CB87054242f6241Cf005)
· Robinhood Chain (4663) · 20,000 supply · 10 per wallet · 0.00055 ETH

## How the prizes work

$10,000 of USDG is split across 2,287 winning cases, from $1 up to a single
$1,000. The other 17,713 cases win nothing.

Which case holds which prize is fixed before minting opens, but nobody — not
even a holder — can read it early. The contract stores only a Merkle root over
`keccak256(tokenId, rewardAmount, salt)`, with a fresh 32-byte random salt per
token, so the commitment reveals nothing about its contents. To open a case you
submit the amount, the salt and a proof; the contract checks them against the
root and pays out only if they match.

Three properties fall out of that:

- **The map cannot change.** `setRewardMerkleRoot` reverts once reveal is open,
  so the tree everyone's proofs were built against is frozen — the owner cannot
  swap it, and neither can a stolen owner key.
- **Reveal cannot start unfunded.** `startReveal()` requires the contract to
  already hold the full reward pool, so the money is on-chain before the first
  case opens.
- **Token ids are drawn at random.** Minting pulls an unused id out of the pool
  rather than counting up, so the first buyer does not automatically get #00001.

Unclaimed rewards can be recovered by the owner, but only 15 days after reveal
opens — `UNCLAIMED_SWEEP_DELAY`. Mint proceeds and the reward vault are separate
balances.

## Layout

```
contracts/CaseFlip.sol      the collection
contracts/MockUSDG.sol      stand-in reward token, testnet only
scripts/                    deploy, reveal, Merkle generation, IPFS packing
tools/                      artwork + metadata generation (see tools/README.md)
test/                       27 tests
index.html                  the mint/reveal site, no build step
```

## Running the tests

```bash
npm install
npx hardhat test
```

The Merkle suite regenerates a tree from the reward CSV and pushes a sample of
its proofs through the same `MerkleProof` code path the contract uses. It skips
itself when the CSV is not present.

## What is deliberately not in this repo

The reward map itself. `reveal-data.json` — the file pairing every token with
its prize, salt and proof — is generated offline and stays offline until
`startReveal()` is mined. Publishing it earlier would let anyone read the
prizes the Merkle root exists to hide. `.gitignore` covers it, along with
`generated/`, `.env` and key material.

## Notes

The site reads `maxSupply`, `maxPerWallet`, `mintPrice`, `totalRewardPool` and
the reward token's symbol from the contract rather than hardcoding them, so it
cannot drift from what is actually deployed. Wallet holdings are discovered from
`Transfer` logs and confirmed with `ownerOf`, because the collection is a plain
ERC-721 with no enumeration.
