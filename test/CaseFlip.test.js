const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MAX_SUPPLY = 4;
const MAX_PER_WALLET = 2;
const MINT_PRICE = 53152755704620n;
const DEC = 1_000_000n; // USDG has 6 decimals

// tokenId => reward in whole dollars, mirroring the shape of Case20K-Rewards.csv
const REWARDS = { 1: 0, 2: 5, 3: 0, 4: 2 };
const TOTAL_POOL = (5n + 2n) * DEC;

function leafFor(tokenId, rewardAmount, salt) {
  return ethers.solidityPackedKeccak256(["uint256", "uint256", "bytes32"], [tokenId, rewardAmount, salt]);
}

function hashPair(a, b) {
  const [l, r] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([l, r]));
}

function buildTree(leaves) {
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    }
    layers.push(next);
  }
  return layers;
}

function getProof(layers, index) {
  const proof = [];
  let idx = index;
  for (let level = 0; level < layers.length - 1; level++) {
    const pair = idx ^ 1;
    if (pair < layers[level].length) proof.push(layers[level][pair]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function buildRewardData(rewards = REWARDS, saltTag = "salt") {
  const entries = Object.entries(rewards).map(([tokenId, dollars], i) => ({
    tokenId: Number(tokenId),
    rewardAmount: BigInt(dollars) * DEC,
    salt: ethers.id(`${saltTag}-${tokenId}-${i}`)
  }));
  const leaves = entries.map(e => leafFor(e.tokenId, e.rewardAmount, e.salt));
  const layers = buildTree(leaves);
  const byToken = {};
  entries.forEach((e, i) => { byToken[e.tokenId] = { ...e, proof: getProof(layers, i) }; });
  return { root: layers[layers.length - 1][0], byToken };
}

describe("CaseFlip", function () {
  let owner, treasury, alice, bob, vault, usdg, data;

  beforeEach(async function () {
    [owner, treasury, alice, bob] = await ethers.getSigners();

    usdg = await (await ethers.getContractFactory("MockUSDG")).deploy(owner.address);
    data = buildRewardData();

    vault = await (await ethers.getContractFactory("CaseFlip")).deploy(
      owner.address,
      await usdg.getAddress(),
      treasury.address,
      MAX_SUPPLY,
      MAX_PER_WALLET,
      MINT_PRICE,
      TOTAL_POOL,
      "ipfs://sealed/",
      "ipfs://revealed/"
    );
    await vault.setSaleActive(true);
  });

  async function sellOut() {
    await vault.connect(alice).mint(2, { value: MINT_PRICE * 2n });
    await vault.connect(bob).mint(2, { value: MINT_PRICE * 2n });
  }

  async function openReveal() {
    await sellOut();
    await vault.setRewardMerkleRoot(data.root);
    await usdg.mint(owner.address, TOTAL_POOL);
    await usdg.approve(await vault.getAddress(), TOTAL_POOL);
    await vault.fundRewardVault(TOTAL_POOL);
    await vault.startReveal();
  }

  describe("mint", function () {
    it("enforces the per-wallet limit", async function () {
      await vault.connect(alice).mint(2, { value: MINT_PRICE * 2n });
      await expect(vault.connect(alice).mint(1, { value: MINT_PRICE }))
        .to.be.revertedWithCustomError(vault, "ExceedsPerWalletLimit");
    });

    it("requires exact payment", async function () {
      await expect(vault.connect(alice).mint(1, { value: MINT_PRICE + 1n }))
        .to.be.revertedWithCustomError(vault, "IncorrectPayment");
    });
  });

  describe("reveal", function () {
    // Ids are assigned at random, so a test cannot assume who holds what —
    // ask the contract instead.
    async function holderOf(tokenId) {
      const addr = await vault.ownerOf(tokenId);
      return [alice, bob].find(s => s.address === addr);
    }
    async function pick(predicate) {
      for (const tokenId of Object.keys(REWARDS).map(Number)) {
        if (predicate(REWARDS[tokenId])) return { tokenId, signer: await holderOf(tokenId) };
      }
      throw new Error("no token matched");
    }

    it("pays the reward and marks the token revealed", async function () {
      await openReveal();
      const { tokenId, signer } = await pick(r => r === 5);
      const d = data.byToken[tokenId];
      const before = await usdg.balanceOf(signer.address);

      await expect(vault.connect(signer).reveal(tokenId, d.rewardAmount, d.salt, d.proof))
        .to.emit(vault, "Revealed").withArgs(signer.address, tokenId, d.rewardAmount);

      expect(await usdg.balanceOf(signer.address)).to.equal(before + 5n * DEC);
      expect(await vault.revealed(tokenId)).to.equal(true);
      expect(await vault.tokenURI(tokenId)).to.equal(`ipfs://revealed/${tokenId}.json`);
    });

    it("marks a zero-reward token revealed without transferring", async function () {
      await openReveal();
      const { tokenId, signer } = await pick(r => r === 0);
      const d = data.byToken[tokenId];
      const before = await usdg.balanceOf(signer.address);

      await vault.connect(signer).reveal(tokenId, d.rewardAmount, d.salt, d.proof);
      expect(await usdg.balanceOf(signer.address)).to.equal(before);
      expect(await vault.revealed(tokenId)).to.equal(true);
    });

    it("rejects a reveal from a non-owner of the token", async function () {
      await openReveal();
      const { tokenId, signer } = await pick(r => r === 5);
      const other = signer.address === alice.address ? bob : alice;
      const d = data.byToken[tokenId];
      await expect(vault.connect(other).reveal(tokenId, d.rewardAmount, d.salt, d.proof))
        .to.be.revertedWithCustomError(vault, "NotTokenOwner");
    });

    it("rejects an inflated reward amount", async function () {
      await openReveal();
      const { tokenId, signer } = await pick(r => r === 5);
      const d = data.byToken[tokenId];
      await expect(vault.connect(signer).reveal(tokenId, d.rewardAmount * 100n, d.salt, d.proof))
        .to.be.revertedWithCustomError(vault, "InvalidProof");
    });

    it("rejects a second reveal of the same token", async function () {
      await openReveal();
      const { tokenId, signer } = await pick(r => r === 5);
      const d = data.byToken[tokenId];
      await vault.connect(signer).reveal(tokenId, d.rewardAmount, d.salt, d.proof);
      await expect(vault.connect(signer).reveal(tokenId, d.rewardAmount, d.salt, d.proof))
        .to.be.revertedWithCustomError(vault, "AlreadyRevealed");
    });
  });

  describe("reward root is frozen at reveal", function () {
    it("can still be set before reveal opens", async function () {
      const other = ethers.hexlify(ethers.randomBytes(32));
      await vault.setRewardMerkleRoot(other);
      expect(await vault.rewardMerkleRoot()).to.equal(other);
      await vault.setRewardMerkleRoot(data.root);
      expect(await vault.rewardMerkleRoot()).to.equal(data.root);
    });

    it("cannot be changed once reveal has started", async function () {
      await openReveal();
      await expect(vault.setRewardMerkleRoot(ethers.hexlify(ethers.randomBytes(32))))
        .to.be.revertedWithCustomError(vault, "RevealAlreadyStarted");
      expect(await vault.rewardMerkleRoot()).to.equal(data.root);
    });

    it("closes the stolen-key path that skipped the 15-day sweep lock", async function () {
      await openReveal();

      // A compromised owner cannot swap in a tree whose wins land on tokens it
      // controls: build one that pays the owner's own address 7 USDG.
      const evil = buildRewardData({ 1: 7, 2: 0, 3: 0, 4: 0 }, "evil");
      await expect(vault.setRewardMerkleRoot(evil.root))
        .to.be.revertedWithCustomError(vault, "RevealAlreadyStarted");

      // The forged proof is therefore worthless against the committed root.
      const holderAddr = await vault.ownerOf(1);
      const holder = [alice, bob].find(s => s.address === holderAddr);
      const e = evil.byToken[1];
      await expect(vault.connect(holder).reveal(1, e.rewardAmount, e.salt, e.proof))
        .to.be.revertedWithCustomError(vault, "InvalidProof");

      // And the vault is still only reachable through the time lock.
      await expect(vault.sweepUnclaimedRewards(1n))
        .to.be.revertedWithCustomError(vault, "SweepLocked");
    });
  });

  describe("startReveal", function () {
    it("requires sellout", async function () {
      await vault.connect(alice).mint(1, { value: MINT_PRICE });
      await vault.setRewardMerkleRoot(data.root);
      await expect(vault.startReveal()).to.be.revertedWithCustomError(vault, "NotSoldOut");
    });

    it("requires a funded vault", async function () {
      await sellOut();
      await vault.setRewardMerkleRoot(data.root);
      await expect(vault.startReveal()).to.be.revertedWithCustomError(vault, "VaultNotFunded");
    });

    it("records the reveal timestamp", async function () {
      await openReveal();
      expect(await vault.revealStartedAt()).to.be.gt(0);
      expect(await vault.sweepUnlocksAt())
        .to.equal((await vault.revealStartedAt()) + (await vault.UNCLAIMED_SWEEP_DELAY()));
    });
  });

  describe("sweepUnclaimedRewards", function () {
    it("reverts before reveal has started", async function () {
      expect(await vault.sweepUnlocksAt()).to.equal(0);
      await expect(vault.sweepUnclaimedRewards(1n))
        .to.be.revertedWithCustomError(vault, "RevealNotStarted");
    });

    it("stays locked for the full 15 days after reveal", async function () {
      await openReveal();
      await expect(vault.sweepUnclaimedRewards(1n))
        .to.be.revertedWithCustomError(vault, "SweepLocked");

      await time.increase(15 * 24 * 60 * 60 - 60); // one minute short
      await expect(vault.sweepUnclaimedRewards(1n))
        .to.be.revertedWithCustomError(vault, "SweepLocked");
    });

    it("sends the unclaimed remainder to the treasury after the delay", async function () {
      await openReveal();
      // Ids are random, so ask who actually holds the $5 token.
      const winner = Object.keys(REWARDS).map(Number).find(id => REWARDS[id] === 5);
      const holderAddr = await vault.ownerOf(winner);
      const holder = [alice, bob].find(s => s.address === holderAddr);
      const d = data.byToken[winner];
      await vault.connect(holder).reveal(winner, d.rewardAmount, d.salt, d.proof); // $5 claimed, $2 left

      await time.increase(15 * 24 * 60 * 60 + 1);
      const left = await usdg.balanceOf(await vault.getAddress());
      expect(left).to.equal(2n * DEC);

      await expect(vault.sweepUnclaimedRewards(left))
        .to.emit(vault, "UnclaimedRewardsSwept").withArgs(treasury.address, left);
      expect(await usdg.balanceOf(treasury.address)).to.equal(2n * DEC);
      expect(await usdg.balanceOf(await vault.getAddress())).to.equal(0n);
    });

    it("is owner-only", async function () {
      await openReveal();
      await time.increase(15 * 24 * 60 * 60 + 1);
      await expect(vault.connect(alice).sweepUnclaimedRewards(1n))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("cannot take more than the vault holds", async function () {
      await openReveal();
      await time.increase(15 * 24 * 60 * 60 + 1);
      await expect(vault.sweepUnclaimedRewards(TOTAL_POOL + 1n)).to.be.reverted;
    });
  });

  describe("mint proceeds", function () {
    it("are separate from the reward vault and go to the treasury", async function () {
      await openReveal();
      const proceeds = MINT_PRICE * 4n;
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(proceeds);

      const before = await ethers.provider.getBalance(treasury.address);
      await vault.withdrawMintProceeds(proceeds);
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(before + proceeds);
      // reward vault untouched
      expect(await usdg.balanceOf(await vault.getAddress())).to.equal(TOTAL_POOL);
    });
  });
});
