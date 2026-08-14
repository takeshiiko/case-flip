const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Random id assignment must not cost the collection its completeness: every id
 * has to be handed out exactly once, and a full sellout has to remain possible.
 * A swap-and-pop bug would show up here as a duplicate, a gap, or a mint that
 * reverts before the supply is exhausted.
 */

const MINT_PRICE = 53152755704620n;
const DEC = 1_000_000n;

async function deploy(maxSupply, maxPerWallet) {
  const [owner, treasury] = await ethers.getSigners();
  const usdg = await (await ethers.getContractFactory("MockUSDG")).deploy(owner.address);
  const vault = await (await ethers.getContractFactory("CaseFlip")).deploy(
    owner.address, await usdg.getAddress(), treasury.address,
    maxSupply, maxPerWallet, MINT_PRICE, DEC,
    "ipfs://sealed/", "ipfs://revealed/"
  );
  await vault.setSaleActive(true);
  return { vault, usdg, owner };
}

describe("random token id assignment", function () {
  this.timeout(180000);

  it("hands out every id exactly once across a full sellout", async function () {
    const SUPPLY = 60;
    const { vault } = await deploy(SUPPLY, SUPPLY);
    const signers = await ethers.getSigners();

    const seen = [];
    let minted = 0;
    let s = 0;
    while (minted < SUPPLY) {
      const qty = Math.min(3, SUPPLY - minted);
      const who = signers[s % signers.length];
      s++;
      const tx = await vault.connect(who).mint(qty, { value: MINT_PRICE * BigInt(qty) });
      const receipt = await tx.wait();
      for (const log of receipt.logs) {
        let parsed;
        try { parsed = vault.interface.parseLog(log); } catch { continue; }
        if (parsed?.name === "Minted") seen.push(...parsed.args[2].map(Number));
      }
      minted += qty;
    }

    expect(seen.length).to.equal(SUPPLY);
    expect(new Set(seen).size).to.equal(SUPPLY, "an id was handed out twice");
    expect([...seen].sort((a, b) => a - b)).to.deep.equal(
      Array.from({ length: SUPPLY }, (_, i) => i + 1),
      "the set of minted ids is not exactly 1..maxSupply"
    );
    expect(await vault.totalMinted()).to.equal(SUPPLY);
  });

  it("actually shuffles rather than counting up", async function () {
    const SUPPLY = 40;
    const { vault } = await deploy(SUPPLY, SUPPLY);
    const [a] = await ethers.getSigners();

    const ids = [];
    for (let i = 0; i < SUPPLY; i++) {
      const receipt = await (await vault.connect(a).mint(1, { value: MINT_PRICE })).wait();
      for (const log of receipt.logs) {
        let parsed;
        try { parsed = vault.interface.parseLog(log); } catch { continue; }
        if (parsed?.name === "Minted") ids.push(Number(parsed.args[2][0]));
      }
    }

    const sequential = ids.every((id, i) => id === i + 1);
    expect(sequential).to.equal(false, "ids came out in plain 1,2,3... order");
    // The first id in particular should not reliably be #1.
    expect(ids[0]).to.not.equal(1);
  });

  it("still refuses to exceed max supply", async function () {
    const SUPPLY = 5;
    const { vault } = await deploy(SUPPLY, SUPPLY);
    const [a] = await ethers.getSigners();
    await vault.connect(a).mint(5, { value: MINT_PRICE * 5n });
    await expect(vault.connect(a).mint(1, { value: MINT_PRICE }))
      .to.be.revertedWithCustomError(vault, "ExceedsMaxSupply");
  });

  it("assigns ids the caller owns, and tokenURI works for them", async function () {
    const { vault } = await deploy(30, 30);
    const [a] = await ethers.getSigners();
    const receipt = await (await vault.connect(a).mint(4, { value: MINT_PRICE * 4n })).wait();
    let ids = [];
    for (const log of receipt.logs) {
      let parsed;
      try { parsed = vault.interface.parseLog(log); } catch { continue; }
      if (parsed?.name === "Minted") ids = parsed.args[2].map(Number);
    }
    expect(ids.length).to.equal(4);
    expect(new Set(ids).size).to.equal(4);
    for (const id of ids) {
      expect(await vault.ownerOf(id)).to.equal(a.address);
      expect(await vault.tokenURI(id)).to.equal(`ipfs://sealed/${id}.json`);
    }
  });
});
