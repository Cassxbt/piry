// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ClaimToken} from "../contracts/ClaimToken.sol";
import {ComputeMarket} from "../contracts/ComputeMarket.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

contract TestCollateral is ERC20 {
    bool public fee;
    constructor() ERC20("Test USD", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFee(bool enabled) external {
        fee = enabled;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (fee && from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0), 1);
            value -= 1;
        }
        super._update(from, to, value);
    }
}

contract SenderFeeCollateral is ERC20 {
    constructor() ERC20("Sender Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (from != address(0) && to != address(0)) super._update(from, address(0), 1);
        super._update(from, to, value);
    }
}

contract ComputeMarketTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant INDEX = keccak256("DEMO-GPU-USD-PER-HOUR-V1");
    TestCollateral internal usd;
    ComputeMarket internal market;
    ClaimToken internal longClaim;
    ClaimToken internal shortClaim;

    function setUp() public {
        vm.warp(1_000);
        usd = new TestCollateral();
        market = new ComputeMarket(
            ComputeMarket.Config({
                collateral: address(usd),
                settlementAuthority: address(this),
                indexId: INDEX,
                specHash: keccak256("demo-spec-v1"),
                priceDecimals: 2,
                lower: 100,
                upper: 300,
                periodStart: 2_000,
                periodEnd: 3_000,
                maxReportAge: 100
            })
        );
        longClaim = market.longClaim();
        shortClaim = market.shortClaim();
        usd.mint(ALICE, 10_000_000);
        vm.prank(ALICE);
        usd.approve(address(market), type(uint256).max);
    }

    function report(uint256 price) internal view returns (ComputeMarket.Report memory) {
        return ComputeMarket.Report({
            market: address(market),
            chainId: block.chainid,
            indexId: INDEX,
            specHash: keccak256("demo-spec-v1"),
            priceDecimals: 2,
            periodStart: 2_000,
            periodEnd: 3_000,
            price: price,
            publishedAt: uint64(block.timestamp),
            evidenceHash: keccak256("synthetic test report")
        });
    }

    function mint(uint256 quantity) internal {
        vm.prank(ALICE);
        market.mintPairs(quantity);
    }

    function testMintAndMergeConserveCollateral() public {
        mint(1_000_000);
        require(longClaim.balanceOf(ALICE) == 1_000_000);
        require(shortClaim.balanceOf(ALICE) == 1_000_000);
        require(longClaim.decimals() == 6 && shortClaim.decimals() == 6);
        require(usd.balanceOf(address(market)) == market.collateralLocked());
        vm.prank(ALICE);
        market.mergePairs(1_000_000, ALICE);
        require(usd.balanceOf(ALICE) == 10_000_000 && market.collateralLocked() == 0);
    }

    function testClaimTransferThenSettleAndRedeem() public {
        mint(1_000_000);
        vm.prank(ALICE);
        require(longClaim.transfer(BOB, 1_000_000));
        vm.warp(3_000);
        market.settle(report(250));
        vm.prank(BOB);
        market.redeem(1_000_000, 0, BOB, 0);
        vm.prank(ALICE);
        market.redeem(0, 1_000_000, ALICE, 0);
        require(usd.balanceOf(BOB) == 750_000 && usd.balanceOf(ALICE) == 9_250_000);
        require(market.collateralLocked() == 0 && usd.balanceOf(address(market)) == 0);
    }

    function testOnlyMarketCanMintOrBurnClaims() public {
        mint(100);
        vm.expectRevert();
        longClaim.mint(BOB, 100);
        vm.expectRevert();
        shortClaim.burn(ALICE, 100);
    }

    function testMintBoundaryAndMergeAfterExpiry() public {
        vm.warp(2_999);
        mint(100);
        vm.warp(3_000);
        vm.expectRevert(ComputeMarket.MarketExpired.selector);
        mint(1);
        vm.prank(ALICE);
        market.mergePairs(100, ALICE);
        require(market.collateralLocked() == 0);
    }

    function testRejectsEarlyAndUnauthorizedSettlement() public {
        ComputeMarket.Report memory r = report(200);
        vm.expectRevert(ComputeMarket.BeforeExpiry.selector);
        market.settle(r);
        vm.warp(3_000);
        r = report(200);
        vm.prank(BOB);
        vm.expectRevert(ComputeMarket.Unauthorized.selector);
        market.settle(r);
    }

    function testRejectsWrongMarketChainIndexAndPeriod() public {
        vm.warp(3_000);
        ComputeMarket.Report memory r = report(200);
        r.market = address(0x123);
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
        r = report(200);
        r.chainId++;
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
        r = report(200);
        r.indexId = bytes32(uint256(1));
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
        r = report(200);
        r.periodStart++;
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
        r = report(200);
        r.periodEnd++;
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
        r = report(200);
        r.evidenceHash = bytes32(0);
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
    }

    function testRejectsOldFutureAndPreExpiryReports() public {
        vm.warp(3_101);
        ComputeMarket.Report memory r = report(200);
        r.publishedAt = 3_000;
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
        r.publishedAt = 3_102;
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
        vm.warp(3_000);
        r.publishedAt = 2_999;
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
    }

    function testAcceptsReportAtMaximumAgeAndRejectsReplay() public {
        vm.warp(3_100);
        ComputeMarket.Report memory r = report(200);
        r.publishedAt = 3_000;
        market.settle(r);
        require(market.settled() && market.settlementPrice() == 200);
        vm.expectRevert(ComputeMarket.AlreadySettled.selector);
        market.settle(r);
    }

    function testNoRedemptionBeforeSettlementOrTwice() public {
        mint(100);
        vm.prank(ALICE);
        vm.expectRevert(ComputeMarket.NotSettled.selector);
        market.redeem(100, 0, ALICE, 0);
        vm.warp(3_000);
        market.settle(report(300));
        vm.prank(ALICE);
        market.redeem(100, 0, ALICE, 0);
        vm.prank(ALICE);
        vm.expectRevert();
        market.redeem(100, 0, ALICE, 0);
    }

    function testFeeOnDepositRollsBackIssuance() public {
        usd.setFee(true);
        vm.expectRevert(ComputeMarket.UnsupportedCollateral.selector);
        mint(100);
        require(market.collateralLocked() == 0 && longClaim.totalSupply() == 0);
        require(usd.balanceOf(ALICE) == 10_000_000);
    }

    function testFeeOnWithdrawalRollsBackBurn() public {
        mint(100);
        usd.setFee(true);
        vm.prank(ALICE);
        vm.expectRevert(ComputeMarket.UnsupportedCollateral.selector);
        market.mergePairs(100, ALICE);
        require(longClaim.balanceOf(ALICE) == 100 && market.collateralLocked() == 100);
    }

    function testDonationCannotMintClaims() public {
        usd.mint(address(market), 123);
        mint(100);
        vm.prank(ALICE);
        market.mergePairs(100, ALICE);
        require(usd.balanceOf(address(market)) == 123 && market.collateralLocked() == 0);
    }

    function testZeroAmountAndInvalidRecipient() public {
        vm.expectRevert(ComputeMarket.ZeroAmount.selector);
        mint(0);
        mint(100);
        vm.prank(ALICE);
        vm.expectRevert(ComputeMarket.InvalidRecipient.selector);
        market.mergePairs(100, address(0));
        vm.prank(ALICE);
        vm.expectRevert(ComputeMarket.InvalidRecipient.selector);
        market.mergePairs(100, address(market));
    }

    function testFuzzMixedRedemptionAndMergeNeverExceedDeposit(uint64 rawQuantity, uint64 rawPart, uint64 rawPrice)
        public
    {
        uint256 quantity = uint256(rawQuantity) % 10_000_000 + 1;
        uint256 part = uint256(rawPart) % (quantity + 1);
        mint(quantity);
        vm.warp(3_000);
        market.settle(report(rawPrice % 401));
        vm.startPrank(ALICE);
        if (part > 0) market.redeem(part, part, ALICE, 0);
        if (part < quantity) market.mergePairs(quantity - part, ALICE);
        vm.stopPrank();
        require(usd.balanceOf(ALICE) <= 10_000_000);
        require(longClaim.totalSupply() == 0 && shortClaim.totalSupply() == 0);
        require(usd.balanceOf(address(market)) == market.collateralLocked());
        require(market.collateralLocked() <= 1);
    }

    function testSpecificationAndPriceScaleAreBound() public {
        vm.warp(3_000);
        ComputeMarket.Report memory r = report(200);
        r.specHash = keccak256("different specification");
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
        r = report(200);
        r.priceDecimals = 18;
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
    }

    function testMinimumPayoutProtectsAgainstRoundingLoss() public {
        mint(2);
        vm.warp(3_000);
        market.settle(report(200));
        require(market.previewRedeem(1, 0) == 0);
        vm.prank(ALICE);
        vm.expectRevert(ComputeMarket.MinimumPayoutNotMet.selector);
        market.redeem(1, 0, ALICE, 1);
        require(longClaim.balanceOf(ALICE) == 2);
        vm.prank(ALICE);
        market.mergePairs(2, ALICE);
        require(usd.balanceOf(ALICE) == 10_000_000);
    }

    function testFragmentedZeroMinimumRedemptionsRetainDust() public {
        mint(3);
        vm.warp(3_000);
        market.settle(report(200));
        vm.startPrank(ALICE);
        for (uint256 i; i < 3; ++i) {
            market.redeem(1, 1, ALICE, 0);
        }
        vm.stopPrank();
        require(longClaim.totalSupply() == 0 && shortClaim.totalSupply() == 0);
        require(market.collateralLocked() == 3 && usd.balanceOf(address(market)) == 3);
    }

    function testLateSettlementStillWorksWithoutTimeoutOverride() public {
        mint(1_000_000);
        vm.warp(30_000);
        vm.prank(ALICE);
        vm.expectRevert(ComputeMarket.NotSettled.selector);
        market.redeem(1_000_000, 0, ALICE, 1);
        market.settle(report(250));
        vm.prank(ALICE);
        market.redeem(1_000_000, 1_000_000, ALICE, 1_000_000);
        require(market.collateralLocked() == 0);
    }

    function testFuzzAsymmetricMultiHolderRedemptionsRemainSolvent(uint64 seed) public {
        mint(1_000_000);
        vm.prank(ALICE);
        require(longClaim.transfer(BOB, 400_000));
        vm.prank(ALICE);
        require(shortClaim.transfer(BOB, 700_000));
        vm.warp(3_000);
        market.settle(report(100 + seed % 201));
        for (uint256 i; i < 32; ++i) {
            seed = uint64(uint256(keccak256(abi.encode(seed, i))));
            address holder = seed % 2 == 0 ? ALICE : BOB;
            bool isLong = (seed >> 1) % 2 == 0;
            uint256 available = isLong ? longClaim.balanceOf(holder) : shortClaim.balanceOf(holder);
            uint256 quantity = available == 0 ? 0 : 1 + uint256(seed) % available;
            if (quantity > 0) {
                vm.prank(holder);
                market.redeem(isLong ? quantity : 0, isLong ? 0 : quantity, holder, 0);
            }
            uint256 numerator = (market.settlementPrice() - 100);
            uint256 weightedLiabilities =
                longClaim.totalSupply() * numerator + shortClaim.totalSupply() * (200 - numerator);
            require(usd.balanceOf(address(market)) >= (weightedLiabilities + 199) / 200);
            require(usd.balanceOf(address(market)) == market.collateralLocked());
        }
    }

    function testClaimCanTransferAfterSettlementAndOnlyHolderCanRedeem() public {
        mint(1_000_000);
        vm.warp(3_000);
        market.settle(report(200));
        vm.prank(ALICE);
        require(longClaim.transfer(BOB, 1_000_000));
        vm.prank(ALICE);
        vm.expectRevert();
        market.redeem(1_000_000, 0, ALICE, 1);
        vm.prank(BOB);
        market.redeem(1_000_000, 0, BOB, 500_000);
        require(usd.balanceOf(BOB) == 500_000);
    }

    function testInsufficientSecondLegRollsBackFirstBurn() public {
        mint(100);
        vm.prank(ALICE);
        require(shortClaim.transfer(BOB, 100));
        vm.prank(ALICE);
        vm.expectRevert();
        market.mergePairs(100, ALICE);
        require(longClaim.balanceOf(ALICE) == 100 && market.collateralLocked() == 100);
    }

    function testSenderSurchargeDepositMustRevertWithoutIssuance() public {
        SenderFeeCollateral token = new SenderFeeCollateral();
        ComputeMarket feeMarket = new ComputeMarket(
            ComputeMarket.Config({
                collateral: address(token),
                settlementAuthority: address(this),
                indexId: INDEX,
                specHash: keccak256("test-spec"),
                priceDecimals: 2,
                lower: 100,
                upper: 300,
                periodStart: 2_000,
                periodEnd: 3_000,
                maxReportAge: 100
            })
        );
        token.mint(ALICE, 1_000);
        vm.prank(ALICE);
        token.approve(address(feeMarket), 100);
        vm.prank(ALICE);
        vm.expectRevert(ComputeMarket.UnsupportedCollateral.selector);
        feeMarket.mintPairs(100);
        require(token.balanceOf(ALICE) == 1_000 && token.balanceOf(address(feeMarket)) == 0);
        require(feeMarket.longClaim().totalSupply() == 0 && feeMarket.shortClaim().totalSupply() == 0);
    }

    function testAsymmetricRedemptionThenMergeKeepsReserves() public {
        mint(100);
        vm.warp(3_000);
        market.settle(report(250));
        vm.startPrank(ALICE);
        market.redeem(30, 0, ALICE, 22);
        market.mergePairs(40, ALICE);
        market.redeem(30, 60, ALICE, 37);
        vm.stopPrank();
        require(usd.balanceOf(ALICE) == 9_999_999 && market.collateralLocked() == 1);
        require(longClaim.totalSupply() == 0 && shortClaim.totalSupply() == 0);
    }
}
