// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ClaimToken} from "./ClaimToken.sol";
import {PayoutMath} from "./PayoutMath.sol";

contract ComputeMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Config {
        address collateral;
        address settlementAuthority;
        bytes32 indexId;
        bytes32 specHash;
        uint8 priceDecimals;
        uint256 lower;
        uint256 upper;
        uint64 periodStart;
        uint64 periodEnd;
        uint64 maxReportAge;
    }

    struct Report {
        address market;
        uint256 chainId;
        bytes32 indexId;
        bytes32 specHash;
        uint8 priceDecimals;
        uint64 periodStart;
        uint64 periodEnd;
        uint256 price;
        uint64 publishedAt;
        bytes32 evidenceHash;
    }

    error InvalidConfig();
    error Unauthorized();
    error MarketExpired();
    error BeforeExpiry();
    error AlreadySettled();
    error NotSettled();
    error InvalidReport();
    error InvalidRecipient();
    error ZeroAmount();
    error MinimumPayoutNotMet();
    error UnsupportedCollateral();

    event PairsMinted(address indexed account, uint256 quantity);
    event PairsMerged(address indexed account, address indexed recipient, uint256 quantity);
    event Settled(uint256 price, uint64 publishedAt, bytes32 indexed evidenceHash);
    event Redeemed(
        address indexed account, address indexed recipient, uint256 longAmount, uint256 shortAmount, uint256 payout
    );

    IERC20 public immutable collateral;
    address public immutable settlementAuthority;
    bytes32 public immutable indexId;
    bytes32 public immutable specHash;
    uint8 public immutable priceDecimals;
    uint256 public immutable lower;
    uint256 public immutable upper;
    uint64 public immutable periodStart;
    uint64 public immutable periodEnd;
    uint64 public immutable maxReportAge;
    ClaimToken public immutable longClaim;
    ClaimToken public immutable shortClaim;

    uint256 public collateralLocked;
    bool public settled;
    uint256 public settlementPrice;
    uint64 public reportPublishedAt;
    bytes32 public settlementEvidenceHash;

    constructor(Config memory config) {
        if (
            config.collateral.code.length == 0 || config.settlementAuthority == address(0)
                || config.indexId == bytes32(0) || config.specHash == bytes32(0) || config.priceDecimals > 18
                || config.lower >= config.upper || config.periodStart < block.timestamp
                || config.periodEnd <= config.periodStart || config.maxReportAge == 0
        ) revert InvalidConfig();
        uint8 decimals_ = IERC20Metadata(config.collateral).decimals();
        if (decimals_ > 18) revert InvalidConfig();
        collateral = IERC20(config.collateral);
        settlementAuthority = config.settlementAuthority;
        indexId = config.indexId;
        specHash = config.specHash;
        priceDecimals = config.priceDecimals;
        lower = config.lower;
        upper = config.upper;
        periodStart = config.periodStart;
        periodEnd = config.periodEnd;
        maxReportAge = config.maxReportAge;
        longClaim = new ClaimToken("Piry Long Claim", "PIRY-L", decimals_);
        shortClaim = new ClaimToken("Piry Short Claim", "PIRY-S", decimals_);
    }

    function mintPairs(uint256 quantity) external nonReentrant {
        if (block.timestamp >= periodEnd) revert MarketExpired();
        if (quantity == 0) revert ZeroAmount();
        uint256 beforeBalance = collateral.balanceOf(address(this));
        uint256 beforePayer = collateral.balanceOf(msg.sender);
        collateral.safeTransferFrom(msg.sender, address(this), quantity);
        uint256 afterBalance = collateral.balanceOf(address(this));
        uint256 afterPayer = collateral.balanceOf(msg.sender);
        if (
            afterBalance < beforeBalance || afterBalance - beforeBalance != quantity || afterPayer > beforePayer
                || beforePayer - afterPayer != quantity
        ) revert UnsupportedCollateral();
        collateralLocked += quantity;
        if (afterBalance < collateralLocked) revert UnsupportedCollateral();
        longClaim.mint(msg.sender, quantity);
        shortClaim.mint(msg.sender, quantity);
        emit PairsMinted(msg.sender, quantity);
    }

    function mergePairs(uint256 quantity, address recipient) external nonReentrant {
        if (quantity == 0) revert ZeroAmount();
        longClaim.burn(msg.sender, quantity);
        shortClaim.burn(msg.sender, quantity);
        _pay(recipient, quantity);
        emit PairsMerged(msg.sender, recipient, quantity);
    }

    function settle(Report calldata report) external nonReentrant {
        if (msg.sender != settlementAuthority) revert Unauthorized();
        if (settled) revert AlreadySettled();
        if (block.timestamp < periodEnd) revert BeforeExpiry();
        if (
            report.market != address(this) || report.chainId != block.chainid || report.indexId != indexId
                || report.specHash != specHash || report.priceDecimals != priceDecimals
                || report.periodStart != periodStart || report.periodEnd != periodEnd
                || report.evidenceHash == bytes32(0) || report.publishedAt < periodEnd
                || report.publishedAt > block.timestamp || block.timestamp - report.publishedAt > maxReportAge
        ) revert InvalidReport();
        settled = true;
        settlementPrice = report.price;
        reportPublishedAt = report.publishedAt;
        settlementEvidenceHash = report.evidenceHash;
        emit Settled(report.price, report.publishedAt, report.evidenceHash);
    }

    function previewRedeem(uint256 longAmount, uint256 shortAmount) public view returns (uint256) {
        if (!settled) revert NotSettled();
        (uint256 longPayout,) = PayoutMath.payouts(longAmount, settlementPrice, lower, upper);
        (, uint256 shortPayout) = PayoutMath.payouts(shortAmount, settlementPrice, lower, upper);
        return longPayout + shortPayout;
    }

    function redeem(uint256 longAmount, uint256 shortAmount, address recipient, uint256 minPayout)
        external
        nonReentrant
        returns (uint256 payout)
    {
        if (longAmount == 0 && shortAmount == 0) revert ZeroAmount();
        payout = previewRedeem(longAmount, shortAmount);
        if (payout < minPayout) revert MinimumPayoutNotMet();
        if (longAmount > 0) longClaim.burn(msg.sender, longAmount);
        if (shortAmount > 0) shortClaim.burn(msg.sender, shortAmount);
        _pay(recipient, payout);
        emit Redeemed(msg.sender, recipient, longAmount, shortAmount, payout);
    }

    function _pay(address recipient, uint256 amount) private {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        collateralLocked -= amount;
        if (amount == 0) return;
        uint256 beforeVault = collateral.balanceOf(address(this));
        uint256 beforeRecipient = collateral.balanceOf(recipient);
        collateral.safeTransfer(recipient, amount);
        uint256 afterVault = collateral.balanceOf(address(this));
        uint256 afterRecipient = collateral.balanceOf(recipient);
        if (
            afterVault > beforeVault || beforeVault - afterVault != amount || afterRecipient < beforeRecipient
                || afterRecipient - beforeRecipient != amount || afterVault < collateralLocked
        ) revert UnsupportedCollateral();
    }
}
