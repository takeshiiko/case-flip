// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @dev TEST ONLY. Mirrors the exact leaf construction and proof verification
/// used inside CaseFlip.reveal(), so production Merkle output can be validated
/// against real on-chain logic without minting the full supply.
/// Not part of the deployed system.
contract MerkleProbe {
    function leafOf(uint256 tokenId, uint256 rewardAmount, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenId, rewardAmount, salt));
    }

    function verify(
        bytes32 root,
        uint256 tokenId,
        uint256 rewardAmount,
        bytes32 salt,
        bytes32[] calldata proof
    ) external pure returns (bool) {
        return MerkleProof.verifyCalldata(proof, root, leafOf(tokenId, rewardAmount, salt));
    }
}
