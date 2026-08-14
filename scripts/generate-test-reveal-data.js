const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const rewards = [
  { tokenId: 1, rewardAmount: "0" },
  { tokenId: 2, rewardAmount: "1000000" },
  { tokenId: 3, rewardAmount: "0" }
];

function leafFor(item) {
  return ethers.solidityPackedKeccak256(
    ["uint256", "uint256", "bytes32"],
    [item.tokenId, item.rewardAmount, item.salt]
  );
}

function hashPair(a, b) {
  const [left, right] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([left, right]));
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
    const pairIndex = idx ^ 1;
    if (pairIndex < layers[level].length) {
      proof.push(layers[level][pairIndex]);
    }
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function main() {
  const data = rewards.map((reward) => ({
    ...reward,
    salt: ethers.id(`case-flip-test-salt-${reward.tokenId}`)
  }));
  const leaves = data.map(leafFor);
  const layers = buildTree(leaves);
  const root = layers[layers.length - 1][0];

  const byToken = {};
  data.forEach((item, index) => {
    byToken[item.tokenId] = {
      tokenId: item.tokenId,
      rewardAmount: item.rewardAmount,
      salt: item.salt,
      proof: getProof(layers, index)
    };
  });

  const out = {
    merkleRoot: root,
    rewards: byToken
  };

  const outPath = path.join(__dirname, "..", "generated", "test-reveal-data.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main();
