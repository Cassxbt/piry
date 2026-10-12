// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ClaimToken} from "../contracts/ClaimToken.sol";
import {ComputeMarket} from "../contracts/ComputeMarket.sol";
import {PiryMarkFeed} from "../contracts/PiryMarkFeed.sol";
import {TestCollateral} from "./ComputeMarket.t.sol";
import {GenericForwarder} from "./SimulationSettlementReceiver.t.sol";
import {VmExt} from "./VmExt.sol";

contract SettlementFallbackTest {
    VmExt internal constant vm = VmExt(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant INDEX = keccak256("DEMO-GPU-USD-PER-HOUR-V1");
    bytes32 internal constant SPEC = keccak256("demo-spec-v1");
    TestCollateral internal usd;
    ComputeMarket internal market;
    ClaimToken internal longClaim;
    ClaimToken internal shortClaim;

    function setUp() public {
        vm.warp(1_000);
        usd = new TestCollateral();
        market = newMarket(address(this), 1_000);
        longClaim = market.longClaim();
        shortClaim = market.shortClaim();
        usd.mint(ALICE, 10_000_000);
        vm.prank(ALICE);
        usd.approve(address(market), type(uint256).max);
    }

    function newMarket(address authority, uint64 fallbackDelay) internal returns (ComputeMarket) {
        return new ComputeMarket(
            ComputeMarket.Config({
                collateral: address(usd),
                settlementAuthority: authority,
                indexId: INDEX,
                specHash: SPEC,
                priceDecimals: 2,
                lower: 100,
                upper: 300,
                periodStart: 2_000,
                periodEnd: 3_000,
                maxReportAge: 100,
                fallbackDelay: fallbackDelay
            })
        );
    }

    function report(uint256 price) internal view returns (ComputeMarket.Report memory) {
        return ComputeMarket.Report({
            market: address(market),
            chainId: block.chainid,
            indexId: INDEX,
            specHash: SPEC,
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

    function testRejectsZeroFallbackDelay() public {
        vm.expectRevert(ComputeMarket.InvalidConfig.selector);
        newMarket(address(this), 0);
    }

    function testFallbackDelayIsStoredAndDefaultsToNotSettledByFallback() public view {
        require(market.fallbackDelay() == 1_000);
        require(!market.settledByFallback() && !market.settled());
    }

    function testFallbackRejectedBeforeDelay() public {
        vm.warp(3_000);
        vm.expectRevert(ComputeMarket.FallbackNotReady.selector);
        market.settleFallback();
        vm.warp(3_999);
        vm.expectRevert(ComputeMarket.FallbackNotReady.selector);
        market.settleFallback();
        vm.warp(999);
        vm.expectRevert(ComputeMarket.FallbackNotReady.selector);
        market.settleFallback();
        require(!market.settled());
    }

    function testFallbackAtDelayBoundarySettlesAtMidpointWithConsistentState() public {
        vm.warp(4_000);
        vm.prank(BOB);
        market.settleFallback();
        require(market.settled() && market.settledByFallback());
        require(market.settlementPrice() == 200);
        require(market.reportPublishedAt() == 4_000);
        require(market.settlementEvidenceHash() == keccak256("PIRY_FALLBACK_MIDPOINT_V1"));
    }

    function testFallbackEmitsDistinctEventOnly() public {
        vm.warp(4_000);
        vm.recordLogs();
        market.settleFallback();
        VmExt.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1);
        require(logs[0].emitter == address(market));
        require(logs[0].topics.length == 1 && logs[0].topics[0] == keccak256("SettledByFallback(uint256)"));
        require(abi.decode(logs[0].data, (uint256)) == 200);
    }

    function testFallbackMidpointRoundsDownForOddWidth() public {
        ComputeMarket odd = new ComputeMarket(
            ComputeMarket.Config({
                collateral: address(usd),
                settlementAuthority: address(this),
                indexId: INDEX,
                specHash: SPEC,
                priceDecimals: 2,
                lower: 100,
                upper: 104,
                periodStart: 2_000,
                periodEnd: 3_000,
                maxReportAge: 100,
                fallbackDelay: 1
            })
        );
        vm.warp(3_001);
        odd.settleFallback();
        require(odd.settlementPrice() == 102);
    }

    function testFallbackAfterOracleSettlementReverts() public {
        vm.warp(3_000);
        market.settle(report(250));
        vm.warp(4_000);
        vm.expectRevert(ComputeMarket.AlreadySettled.selector);
        market.settleFallback();
        require(!market.settledByFallback() && market.settlementPrice() == 250);
    }

    function testOracleReportAfterFallbackReverts() public {
        vm.warp(4_000);
        market.settleFallback();
        vm.expectRevert(ComputeMarket.AlreadySettled.selector);
        market.settle(report(250));
        require(market.settlementPrice() == 200 && market.settledByFallback());
    }

    function testFallbackCannotRunTwice() public {
        vm.warp(4_000);
        market.settleFallback();
        vm.expectRevert(ComputeMarket.AlreadySettled.selector);
        market.settleFallback();
    }

    function testOracleStillSettlesAfterDelayIfNoOneCalledFallback() public {
        vm.warp(4_500);
        ComputeMarket.Report memory r = report(250);
        market.settle(r);
        require(market.settled() && !market.settledByFallback() && market.settlementPrice() == 250);
    }

    // Reproduces the liveness lock: the only report ages past maxReportAge, so settle reverts forever
    // and a single-leg holder can neither redeem nor merge.
    function testRegressionStaleReportLocksLongHolderUntilFallback() public {
        mint(1_000_000);
        vm.prank(ALICE);
        require(longClaim.transfer(BOB, 1_000_000));
        vm.warp(3_000);
        ComputeMarket.Report memory r = report(250);
        vm.warp(3_000 + market.maxReportAge() + 1);
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        market.settle(r);
        vm.prank(BOB);
        vm.expectRevert(ComputeMarket.NotSettled.selector);
        market.redeem(1_000_000, 0, BOB, 0);
        vm.prank(BOB);
        vm.expectRevert();
        market.mergePairs(1_000_000, BOB);

        vm.warp(3_000 + market.fallbackDelay());
        market.settleFallback();
        require(market.previewRedeem(1_000_000, 0) == 500_000);
        vm.prank(BOB);
        uint256 payout = market.redeem(1_000_000, 0, BOB, 500_000);
        require(payout == 500_000 && usd.balanceOf(BOB) == 500_000);
        vm.prank(ALICE);
        market.redeem(0, 1_000_000, ALICE, 500_000);
        require(usd.balanceOf(ALICE) == 9_500_000);
        require(market.collateralLocked() == 0 && usd.balanceOf(address(market)) == 0);
    }

    function testFuzzFallbackRedemptionsAreSolventAndRetainOnlyRoundingDust(uint64 rawQuantity, uint64 rawPart)
        public
    {
        uint256 quantity = uint256(rawQuantity) % 10_000_000 + 1;
        uint256 part = uint256(rawPart) % (quantity + 1);
        mint(quantity);
        vm.warp(4_000);
        market.settleFallback();
        vm.startPrank(ALICE);
        if (part > 0) market.redeem(part, part, ALICE, 0);
        if (part < quantity) market.redeem(quantity - part, quantity - part, ALICE, 0);
        vm.stopPrank();
        require(usd.balanceOf(ALICE) <= 10_000_000);
        require(longClaim.totalSupply() == 0 && shortClaim.totalSupply() == 0);
        require(market.collateralLocked() == usd.balanceOf(address(market)));
        require(market.collateralLocked() <= 2);
    }

    function testFuzzFallbackTimingGate(uint64 elapsed) public {
        vm.warp(3_000 + uint256(elapsed) % 10_000);
        if (block.timestamp < 4_000) vm.expectRevert(ComputeMarket.FallbackNotReady.selector);
        market.settleFallback();
        require(market.settled() == (block.timestamp >= 4_000));
    }

    function testMarkFeedReportsFallbackMidpointAsFinalValue() public {
        GenericForwarder forwarder = new GenericForwarder();
        PiryMarkFeed feed = new PiryMarkFeed(address(forwarder), bytes32(0), address(0xBEEF), market);
        vm.warp(4_000);
        market.settleFallback();
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        require(roundId == 1 && answer == 50_000_000 && updatedAt == block.timestamp);
        PiryMarkFeed.Mark memory m = PiryMarkFeed.Mark({
            feed: address(feed),
            chainId: block.chainid,
            indexId: INDEX,
            indexPrice: 250,
            observedAt: 4_000,
            evidenceHash: keccak256("late mark")
        });
        vm.prank(address(this), address(0xBEEF));
        vm.expectRevert(PiryMarkFeed.MarketSettled.selector);
        forwarder.deliver(address(feed), "", abi.encode(m));
    }
}
