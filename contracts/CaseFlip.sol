// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract CaseFlip is ERC721, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Strings for uint256;

    error SaleInactive();
    error RevealInactive();
    error ExceedsMaxSupply();
    error ExceedsPerWalletLimit();
    error InvalidQuantity();
    error InvalidProof();
    error AlreadyRevealed();
    error NotTokenOwner();
    error VaultNotFunded();
    error NotSoldOut();
    error MerkleRootNotSet();
    error InvalidAddress();
    error InvalidConfig();
    error IncorrectPayment();
    error EthTransferFailed();
    error InsufficientWithdrawableBalance();
    error RevealNotStarted();
    error SweepLocked();
    error RevealAlreadyStarted();

    /// @notice Holders get this long after reveal opens to claim before the
    /// owner may recover whatever is left in the reward vault.
    uint256 public constant UNCLAIMED_SWEEP_DELAY = 15 days;

    uint256 public immutable maxSupply;
    uint256 public immutable maxPerWallet;

    address public treasury;
    IERC20 public immutable rewardToken;

    uint256 public immutable mintPrice;
    uint256 public immutable totalRewardPool;
    uint256 public totalMinted;

    bool public saleActive;
    bool public revealActive;
    uint256 public revealStartedAt;

    bytes32 public rewardMerkleRoot;
    string private unrevealedBaseURI;
    string private revealedBaseURI;

    mapping(address => uint256) public mintedByWallet;
    mapping(uint256 => bool) public revealed;
    mapping(uint256 => uint256) public revealedReward;

    /// @dev Sparse swap-and-pop pool for random id assignment. Slot k stands for
    /// id k+1 until it is overwritten, so the full 1..maxSupply range never has
    /// to be written out up front.
    mapping(uint256 => uint256) private idPool;

    event SaleActiveSet(bool active);
    event RevealStarted(bytes32 rewardMerkleRoot);
    event BaseURISet(string unrevealedBaseURI, string revealedBaseURI);
    event TreasurySet(address treasury);
    event RewardMerkleRootSet(bytes32 rewardMerkleRoot);
    event Minted(address indexed minter, uint256 quantity, uint256[] tokenIds);
    event Revealed(address indexed owner, uint256 indexed tokenId, uint256 rewardAmount);
    event RewardVaultFunded(address indexed funder, uint256 amount);
    event EthReceived(address indexed sender, uint256 amount);
    event TreasuryWithdraw(address indexed treasury, uint256 amount);
    event UnclaimedRewardsSwept(address indexed treasury, uint256 amount);

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
    ) ERC721("Case Flip", "FLIP") Ownable(initialOwner) {
        if (
            initialOwner == address(0) ||
            rewardToken_ == address(0) ||
            treasury_ == address(0)
        ) {
            revert InvalidAddress();
        }
        if (maxSupply_ == 0 || maxPerWallet_ == 0 || maxPerWallet_ > maxSupply_) {
            revert InvalidConfig();
        }

        rewardToken = IERC20(rewardToken_);
        treasury = treasury_;
        maxSupply = maxSupply_;
        maxPerWallet = maxPerWallet_;
        mintPrice = mintPrice_;
        totalRewardPool = totalRewardPool_;
        unrevealedBaseURI = unrevealedBaseURI_;
        revealedBaseURI = revealedBaseURI_;
    }

    receive() external payable {
        emit EthReceived(msg.sender, msg.value);
    }

    function setSaleActive(bool active) external onlyOwner {
        saleActive = active;
        emit SaleActiveSet(active);
    }

    /// @notice Commit the reward tree. Only possible before reveal opens.
    /// @dev Once `startReveal()` has run, the root is what every outstanding
    /// proof was built against, and the reward vault is fully funded but still
    /// locked to the owner for 15 days. Leaving the root mutable here would let
    /// a stolen owner key swap in a tree whose wins land on tokens it already
    /// holds and claim immediately — walking straight past that time lock. So
    /// the root is frozen at reveal: after that point not even the owner can
    /// change who won.
    function setRewardMerkleRoot(bytes32 newRoot) external onlyOwner {
        if (revealActive) revert RevealAlreadyStarted();
        rewardMerkleRoot = newRoot;
        emit RewardMerkleRootSet(newRoot);
    }

    function setBaseURI(string calldata newUnrevealedBaseURI, string calldata newRevealedBaseURI) external onlyOwner {
        unrevealedBaseURI = newUnrevealedBaseURI;
        revealedBaseURI = newRevealedBaseURI;
        emit BaseURISet(newUnrevealedBaseURI, newRevealedBaseURI);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function mint(uint256 quantity) external payable nonReentrant whenNotPaused {
        if (!saleActive) revert SaleInactive();
        if (quantity == 0) revert InvalidQuantity();
        if (totalMinted + quantity > maxSupply) revert ExceedsMaxSupply();
        if (mintedByWallet[msg.sender] + quantity > maxPerWallet) revert ExceedsPerWalletLimit();
        if (msg.value != mintPrice * quantity) revert IncorrectPayment();

        mintedByWallet[msg.sender] += quantity;

        uint256[] memory tokenIds = new uint256[](quantity);
        for (uint256 i = 0; i < quantity; i++) {
            tokenIds[i] = _drawTokenId(i);
        }
        for (uint256 i = 0; i < quantity; i++) {
            _safeMint(msg.sender, tokenIds[i]);
        }

        emit Minted(msg.sender, quantity, tokenIds);
    }

    /// @dev Pull one id at random out of the unminted pool (swap-and-pop, so
    /// every id is still handed out exactly once and the collection sells out
    /// completely).
    ///
    /// The entropy here is deliberately modest: this chain has no usable
    /// randomness (prevrandao is a slow counter), so a determined caller could
    /// steer which id it lands on. That is acceptable because an id says
    /// nothing about its prize — the reward map is committed behind a Merkle
    /// root with per-leaf salts and only becomes public after sellout, by which
    /// point there is nothing left to mint.
    function _drawTokenId(uint256 nonce) private returns (uint256 tokenId) {
        uint256 remaining = maxSupply - totalMinted;
        uint256 index = uint256(
            keccak256(abi.encodePacked(block.prevrandao, block.timestamp, msg.sender, totalMinted, nonce))
        ) % remaining;

        // Slot k is implicitly id k+1 until something is swapped into it.
        tokenId = idPool[index] == 0 ? index + 1 : idPool[index];

        uint256 lastIndex = remaining - 1;
        if (index != lastIndex) {
            idPool[index] = idPool[lastIndex] == 0 ? lastIndex + 1 : idPool[lastIndex];
        }
        delete idPool[lastIndex];

        totalMinted++;
    }

    function fundRewardVault(uint256 amount) external nonReentrant {
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardVaultFunded(msg.sender, amount);
    }

    function startReveal() external onlyOwner {
        if (totalMinted != maxSupply) revert NotSoldOut();
        if (rewardMerkleRoot == bytes32(0)) revert MerkleRootNotSet();
        if (rewardToken.balanceOf(address(this)) < totalRewardPool) revert VaultNotFunded();

        revealActive = true;
        revealStartedAt = block.timestamp;
        emit RevealStarted(rewardMerkleRoot);
    }

    function reveal(
        uint256 tokenId,
        uint256 rewardAmount,
        bytes32 salt,
        bytes32[] calldata proof
    ) external nonReentrant whenNotPaused {
        if (!revealActive) revert RevealInactive();
        if (ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (revealed[tokenId]) revert AlreadyRevealed();

        bytes32 leaf = keccak256(abi.encodePacked(tokenId, rewardAmount, salt));
        if (!MerkleProof.verifyCalldata(proof, rewardMerkleRoot, leaf)) revert InvalidProof();

        revealed[tokenId] = true;
        revealedReward[tokenId] = rewardAmount;

        if (rewardAmount > 0) {
            rewardToken.safeTransfer(msg.sender, rewardAmount);
        }

        emit Revealed(msg.sender, tokenId, rewardAmount);
    }

    function withdrawMintProceeds(uint256 amount) external onlyOwner nonReentrant {
        if (amount > address(this).balance) {
            revert InsufficientWithdrawableBalance();
        }

        (bool ok, ) = payable(treasury).call{value: amount}("");
        if (!ok) revert EthTransferFailed();
        emit TreasuryWithdraw(treasury, amount);
    }

    /// @notice Recover reward tokens that holders never claimed.
    /// @dev Only callable once reveal has been open for UNCLAIMED_SWEEP_DELAY,
    /// so an unrevealed holder always has a guaranteed window to claim first.
    /// Funds go to `treasury`, never to an arbitrary address.
    function sweepUnclaimedRewards(uint256 amount) external onlyOwner nonReentrant {
        if (revealStartedAt == 0) revert RevealNotStarted();
        if (block.timestamp < revealStartedAt + UNCLAIMED_SWEEP_DELAY) revert SweepLocked();

        rewardToken.safeTransfer(treasury, amount);
        emit UnclaimedRewardsSwept(treasury, amount);
    }

    /// @notice Timestamp after which sweepUnclaimedRewards() unlocks (0 before reveal).
    function sweepUnlocksAt() external view returns (uint256) {
        return revealStartedAt == 0 ? 0 : revealStartedAt + UNCLAIMED_SWEEP_DELAY;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        ownerOf(tokenId);

        string memory base = revealed[tokenId] ? revealedBaseURI : unrevealedBaseURI;
        return string.concat(base, tokenId.toString(), ".json");
    }
}
