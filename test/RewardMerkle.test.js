const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * End-to-end check of scripts/generate-reward-merkle.js against real on-chain
 * verification: generate a tree from the production CSV, then push a sample of
 * its proofs through the same MerkleProof code path CaseFlip.reveal() uses.
 *
 * Skips (rather than fails) when the CSV is not on this machine.
 */

const CSV = process.env.REWARD_CSV || path.join(os.homedir(), "Desktop", "Case20K-Rewards.csv");
const SCRIPT = path.join(__dirname, "..", "scripts", "generate-reward-merkle.js");

describe("reward Merkle generation", function () {
  this.timeout(300000);

  let data, probe;

  before(async function () {
    if (!fs.existsSync(CSV)) {
      console.log(`    (skipped: ${CSV} not found)`);
      this.skip();
    }

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "caseflip-merkle-"));
    execFileSync("node", [SCRIPT], {
      env: { ...process.env, REWARD_CSV: CSV, OUT_DIR: outDir, EXPECTED_POOL: "10000000000" },
      stdio: "pipe"
    });
    data = JSON.parse(fs.readFileSync(path.join(outDir, "reveal-data.json"), "utf8"));
    fs.rmSync(outDir, { recursive: true, force: true });

    probe = await (await ethers.getContractFactory("MerkleProbe")).deploy();
  });

  it("converts whole-dollar CSV rewards into 6-decimal base units", function () {
    expect(data.rewardDecimals).to.equal(6);
    expect(data.totalRewardPool).to.equal("10000000000");
    expect(data.supply).to.equal(20000);
    expect(data.winners).to.equal(2287);

    const total = Object.values(data.rewards).reduce((a, r) => a + BigInt(r.rewardAmount), 0n);
    expect(total).to.equal(10000000000n);

    // every non-zero reward must be a whole number of dollars in base units
    for (const r of Object.values(data.rewards)) {
      expect(BigInt(r.rewardAmount) % 1000000n).to.equal(0n);
    }
  });

  it("gives every token a unique 32-byte salt", function () {
    const salts = new Set();
    for (const r of Object.values(data.rewards)) {
      expect(r.salt).to.match(/^0x[0-9a-f]{64}$/);
      salts.add(r.salt);
    }
    expect(salts.size).to.equal(20000);
  });

  it("produces proofs that verify through the contract's MerkleProof path", async function () {
    const ids = ["1", "2", "20000", "11196", "4804", "7922", "10000", "17713"];
    const top = Object.values(data.rewards).sort((a, b) => Number(BigInt(b.rewardAmount) - BigInt(a.rewardAmount)))[0];
    ids.push(String(top.tokenId));

    for (const id of ids) {
      const r = data.rewards[id];
      expect(await probe.verify(data.merkleRoot, r.tokenId, r.rewardAmount, r.salt, r.proof), `token ${id}`)
        .to.equal(true);
    }

    // the $1,000 top prize is present and correctly scaled
    expect(top.rewardAmount).to.equal("1000000000");
  });

  it("rejects an inflated reward, a swapped salt, and a swapped tokenId on-chain", async function () {
    const a = data.rewards["11196"];
    const b = data.rewards["4804"];

    expect(await probe.verify(data.merkleRoot, a.tokenId, BigInt(a.rewardAmount) + 1n, a.salt, a.proof)).to.equal(false);
    expect(await probe.verify(data.merkleRoot, a.tokenId, a.rewardAmount, b.salt, a.proof)).to.equal(false);
    expect(await probe.verify(data.merkleRoot, b.tokenId, a.rewardAmount, a.salt, a.proof)).to.equal(false);
    // a loser cannot borrow a winner's proof
    expect(await probe.verify(data.merkleRoot, 3, a.rewardAmount, a.salt, a.proof)).to.equal(false);
  });
});
