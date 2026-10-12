// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICREReceiver} from "../contracts/SettlementReceiver.sol";
import {AggregatorV3Interface, PiryMarkFeed} from "../contracts/PiryMarkFeed.sol";
import {ComputeMarket} from "../contracts/ComputeMarket.sol";
import {TestCollateral} from "./ComputeMarket.t.sol";
import {GenericForwarder} from "./SimulationSettlementReceiver.t.sol";
import {VmExt} from "./VmExt.sol";

contract PiryMarkFeedTest {
    VmExt internal constant vm = VmExt(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant OPERATOR = address(0x0BE7A);
    address internal constant STRANGER = address(0x57A4);
    bytes32 internal constant WORKFLOW = keccak256("piry-mark-workflow-v1");
    bytes32 internal constant INDEX = keccak256("demo-index");
    int256 internal constant ONE = 1e8;
    GenericForwarder internal forwarder;
    TestCollateral internal usd;
    ComputeMarket internal market;
    PiryMarkFeed internal sim;
    PiryMarkFeed internal strict;

    function setUp() public {
        vm.warp(1_000);
        forwarder = new GenericForwarder();
        usd = new TestCollateral();
        market = newMarket(100, 300);
        sim = new PiryMarkFeed(address(forwarder), bytes32(0), OPERATOR, market);
        strict = new PiryMarkFeed(address(forwarder), WORKFLOW, address(0), market);
    }

    function newMarket(uint256 lower, uint256 upper) internal returns (ComputeMarket) {
        return new ComputeMarket(
            ComputeMarket.Config({
                collateral: address(usd),
                settlementAuthority: address(this),
                indexId: INDEX,
                specHash: keccak256("demo-spec"),
                priceDecimals: 2,
                lower: lower,
                upper: upper,
                periodStart: 2_000,
                periodEnd: 3_000,
                maxReportAge: 100,
                fallbackDelay: 1_000
            })
        );
    }

    function mark(PiryMarkFeed feed, uint256 indexPrice, uint64 observedAt)
        internal
        view
        returns (PiryMarkFeed.Mark memory)
    {
        return PiryMarkFeed.Mark({
            feed: address(feed),
            chainId: block.chainid,
            indexId: INDEX,
            indexPrice: indexPrice,
            observedAt: observedAt,
            evidenceHash: keccak256("mark-evidence")
        });
    }

    function strictMetadata(bytes32 workflow) internal pure returns (bytes memory) {
        return abi.encodePacked(workflow, bytes10("piry"), address(0x1234), bytes2(0x0001));
    }

    function pushSim(uint256 indexPrice, uint64 observedAt) internal {
        vm.prank(address(this), OPERATOR);
        forwarder.deliver(address(sim), "", abi.encode(mark(sim, indexPrice, observedAt)));
    }

    function pushStrict(uint256 indexPrice, uint64 observedAt) internal {
        forwarder.deliver(address(strict), strictMetadata(WORKFLOW), abi.encode(mark(strict, indexPrice, observedAt)));
    }

    function settleMarket(uint256 price) internal {
        vm.warp(3_000);
        market.settle(
            ComputeMarket.Report({
                market: address(market),
                chainId: block.chainid,
                indexId: INDEX,
                specHash: keccak256("demo-spec"),
                priceDecimals: 2,
                periodStart: 2_000,
                periodEnd: 3_000,
                price: price,
                publishedAt: 3_000,
                evidenceHash: keccak256("settlement-evidence")
            })
        );
    }

    function expectInvalidMark(PiryMarkFeed.Mark memory m) internal {
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(PiryMarkFeed.InvalidMark.selector);
        forwarder.deliver(address(sim), "", abi.encode(m));
    }

    function latest(PiryMarkFeed feed)
        internal
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        return feed.latestRoundData();
    }

    function testConfigurationAndMetadata() public view {
        require(sim.isSimulation() && !strict.isSimulation());
        require(sim.forwarder() == address(forwarder) && address(sim.market()) == address(market));
        require(sim.operator() == OPERATOR && sim.workflowId() == bytes32(0));
        require(strict.operator() == address(0) && strict.workflowId() == WORKFLOW);
        require(sim.lower() == 100 && sim.upper() == 300 && sim.indexId() == INDEX);
        require(sim.decimals() == 8 && sim.version() == 1);
        require(bytes(sim.description()).length > 0);
    }

    function testRejectsInvalidConfiguration() public {
        vm.expectRevert(PiryMarkFeed.InvalidConfig.selector);
        new PiryMarkFeed(address(forwarder), bytes32(0), address(0), market);
        vm.expectRevert(PiryMarkFeed.InvalidConfig.selector);
        new PiryMarkFeed(address(forwarder), WORKFLOW, OPERATOR, market);
        vm.expectRevert(PiryMarkFeed.InvalidConfig.selector);
        new PiryMarkFeed(address(0), WORKFLOW, address(0), market);
        vm.expectRevert(PiryMarkFeed.InvalidConfig.selector);
        new PiryMarkFeed(address(0x123), bytes32(0), OPERATOR, market);
        vm.expectRevert(PiryMarkFeed.InvalidConfig.selector);
        new PiryMarkFeed(address(forwarder), bytes32(0), OPERATOR, ComputeMarket(address(0)));
        vm.expectRevert(PiryMarkFeed.InvalidConfig.selector);
        new PiryMarkFeed(address(forwarder), bytes32(0), OPERATOR, ComputeMarket(address(0x123)));
    }

    function testERC165ForBothModes() public view {
        PiryMarkFeed[2] memory feeds = [sim, strict];
        for (uint256 i; i < 2; ++i) {
            require(feeds[i].supportsInterface(type(IERC165).interfaceId));
            require(feeds[i].supportsInterface(type(ICREReceiver).interfaceId));
            require(feeds[i].supportsInterface(0x805f2132));
            require(!feeds[i].supportsInterface(0xffffffff));
        }
    }

    function testLatestRoundDataRevertsBeforeAnyUpdate() public {
        vm.expectRevert(PiryMarkFeed.NoData.selector);
        sim.latestRoundData();
        vm.expectRevert(PiryMarkFeed.NoData.selector);
        sim.getRoundData(0);
        vm.expectRevert(PiryMarkFeed.NoData.selector);
        sim.getRoundData(1);
    }

    function testSimulationUpdateStoresRound() public {
        pushSim(250, 1_000);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = latest(sim);
        require(roundId == 1 && answeredInRound == 1);
        require(answer == 75_000_000);
        require(startedAt == 1_000 && updatedAt == 1_000);
        (int256 storedAnswer, uint256 indexPrice, uint64 observedAt, bytes32 evidence) = sim.rounds(1);
        require(storedAnswer == answer && indexPrice == 250 && observedAt == 1_000 && evidence == keccak256("mark-evidence"));
        require(sim.latestRound() == 1);
    }

    function testStrictUpdateStoresRound() public {
        pushStrict(200, 1_000);
        (, int256 answer,,,) = latest(strict);
        require(answer == 50_000_000);
    }

    function testEmitsMarkUpdated() public {
        vm.recordLogs();
        pushSim(250, 1_000);
        VmExt.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(sim));
        require(logs[0].topics.length == 2);
        require(logs[0].topics[0] == keccak256("MarkUpdated(uint80,int256,uint256,uint64,bytes32)"));
        require(logs[0].topics[1] == bytes32(uint256(1)));
        (int256 answer, uint256 indexPrice, uint64 observedAt, bytes32 evidence) =
            abi.decode(logs[0].data, (int256, uint256, uint64, bytes32));
        require(answer == 75_000_000 && indexPrice == 250 && observedAt == 1_000);
        require(evidence == keccak256("mark-evidence"));
    }

    function testHistoryIsKeptAcrossRounds() public {
        pushSim(100, 1_000);
        vm.warp(1_010);
        pushSim(200, 1_005);
        vm.warp(1_020);
        pushSim(300, 1_020);
        require(sim.latestRound() == 3);
        (uint80 id, int256 answer,, uint256 updatedAt,) = sim.getRoundData(1);
        require(id == 1 && answer == 1 && updatedAt == 1_000);
        (id, answer,, updatedAt,) = sim.getRoundData(2);
        require(id == 2 && answer == 50_000_000 && updatedAt == 1_005);
        (id, answer,, updatedAt,) = sim.getRoundData(3);
        require(id == 3 && answer == ONE && updatedAt == 1_020);
        (id, answer,,,) = sim.latestRoundData();
        require(id == 3 && answer == ONE);
        vm.expectRevert(PiryMarkFeed.NoData.selector);
        sim.getRoundData(4);
    }

    function testUntrustedCallerRejectedInBothModes() public {
        bytes memory payload = abi.encode(mark(sim, 250, 1_000));
        vm.prank(OPERATOR, OPERATOR);
        vm.expectRevert(PiryMarkFeed.UntrustedForwarder.selector);
        sim.onReport("", payload);
        vm.prank(STRANGER, STRANGER);
        vm.expectRevert(PiryMarkFeed.UntrustedForwarder.selector);
        strict.onReport(strictMetadata(WORKFLOW), abi.encode(mark(strict, 250, 1_000)));
        require(sim.latestRound() == 0 && strict.latestRound() == 0);
    }

    function testSimulationRejectsOriginThatIsNotOperator() public {
        vm.prank(STRANGER, STRANGER);
        vm.expectRevert(PiryMarkFeed.UntrustedOperator.selector);
        forwarder.deliver(address(sim), "", abi.encode(mark(sim, 250, 1_000)));
        vm.expectRevert(PiryMarkFeed.UntrustedOperator.selector);
        forwarder.deliver(address(sim), strictMetadata(WORKFLOW), abi.encode(mark(sim, 250, 1_000)));
        require(sim.latestRound() == 0);
    }

    function testFuzzSimulationIgnoresMetadataLength(uint8 length) public {
        vm.prank(address(this), OPERATOR);
        forwarder.deliver(address(sim), new bytes(length), abi.encode(mark(sim, 250, 1_000)));
        require(sim.latestRound() == 1);
    }

    function testStrictRejectsWrongWorkflow() public {
        vm.expectRevert(PiryMarkFeed.UntrustedWorkflow.selector);
        forwarder.deliver(address(strict), strictMetadata(keccak256("other")), abi.encode(mark(strict, 250, 1_000)));
        require(strict.latestRound() == 0);
    }

    function testStrictIgnoresTransactionOrigin() public {
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(PiryMarkFeed.InvalidMetadata.selector);
        forwarder.deliver(address(strict), "", abi.encode(mark(strict, 250, 1_000)));
    }

    function testFuzzStrictRejectsNonstandardMetadataLength(uint8 length) public {
        if (length == 64) return;
        vm.expectRevert(PiryMarkFeed.InvalidMetadata.selector);
        forwarder.deliver(address(strict), new bytes(length), abi.encode(mark(strict, 250, 1_000)));
        require(strict.latestRound() == 0);
    }

    function testRejectsWrongFeedChainAndIndex() public {
        PiryMarkFeed.Mark memory m = mark(sim, 250, 1_000);
        m.feed = address(strict);
        expectInvalidMark(m);
        m = mark(sim, 250, 1_000);
        m.chainId += 1;
        expectInvalidMark(m);
        m = mark(sim, 250, 1_000);
        m.indexId = keccak256("other-index");
        expectInvalidMark(m);
        require(sim.latestRound() == 0);
    }

    function testRejectsStaleReplayedAndFutureObservations() public {
        PiryMarkFeed.Mark memory m = mark(sim, 250, 0);
        expectInvalidMark(m);
        m.observedAt = 1_001;
        expectInvalidMark(m);
        pushSim(250, 1_000);
        m.observedAt = 1_000;
        expectInvalidMark(m);
        m.observedAt = 999;
        expectInvalidMark(m);
        vm.warp(1_500);
        m.observedAt = 1_500;
        vm.prank(address(this), OPERATOR);
        forwarder.deliver(address(sim), "", abi.encode(m));
        require(sim.latestRound() == 2);
    }

    function testRejectsMalformedPayloads() public {
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(PiryMarkFeed.InvalidPayload.selector);
        forwarder.deliver(address(sim), "", hex"00");
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(PiryMarkFeed.InvalidPayload.selector);
        forwarder.deliver(address(sim), "", bytes.concat(abi.encode(mark(sim, 250, 1_000)), hex"00"));
        bytes memory dirty = abi.encode(mark(sim, 250, 1_000));
        // The first word is an address; nonzero high bits are invalid ABI.
        assembly { mstore(add(dirty, 32), not(0)) }
        vm.prank(address(this), OPERATOR);
        vm.expectRevert();
        forwarder.deliver(address(sim), "", dirty);
        require(sim.latestRound() == 0);
    }

    function testRejectsZeroEvidenceHash() public {
        PiryMarkFeed.Mark memory m = mark(sim, 250, 1_000);
        m.evidenceHash = bytes32(0);
        expectInvalidMark(m);
        require(sim.latestRound() == 0);
    }

    function testWorthlessClaimStillHasPositivePrice() public {
        pushSim(50, 1_000);
        (, int256 live,,,) = latest(sim);
        settleMarket(0);
        (, int256 settledAnswer,,,) = latest(sim);
        require(live == 1 && settledAnswer == 1 && market.previewRedeem(1_000_000, 0) == 0);
    }

    function testPayloadIsSixStaticWords() public view {
        require(abi.encode(mark(sim, 250, 1_000)).length == 192);
    }

    function testAnswerBoundaries() public {
        uint256[6] memory prices = [uint256(0), 99, 100, 300, 301, type(uint256).max];
        int256[6] memory expected = [int256(1), 1, 1, ONE, ONE, ONE];
        uint64 at = 1_000;
        for (uint256 i; i < prices.length; ++i) {
            vm.warp(at);
            pushSim(prices[i], at);
            (, int256 answer,,,) = latest(sim);
            require(answer == expected[i]);
            ++at;
        }
        vm.warp(at);
        pushSim(101, at);
        (, int256 oneTick,,,) = latest(sim);
        require(oneTick == 500_000);
    }

    function testFuzzAnswerWithinBoundsAndMonotonic(uint256 low, uint256 high) public {
        vm.warp(1_100);
        pushSim(low, 1_001);
        pushSim(high, 1_002);
        (, int256 lowAnswer,,,) = sim.getRoundData(1);
        (, int256 highAnswer,,,) = sim.getRoundData(2);
        require(lowAnswer >= 1 && lowAnswer <= ONE && highAnswer >= 1 && highAnswer <= ONE);
        if (low <= high) require(lowAnswer <= highAnswer);
        else require(lowAnswer >= highAnswer);
    }

    function testFuzzAnswerMatchesReferenceForArbitraryBounds(uint128 rawLower, uint128 rawWidth, uint256 price) public {
        uint256 lower = uint256(rawLower);
        uint256 width = uint256(rawWidth) % type(uint128).max + 1;
        ComputeMarket other = newMarket(lower, lower + width);
        PiryMarkFeed feed = new PiryMarkFeed(address(forwarder), bytes32(0), OPERATOR, other);
        PiryMarkFeed.Mark memory m = PiryMarkFeed.Mark({
            feed: address(feed),
            chainId: block.chainid,
            indexId: INDEX,
            indexPrice: price,
            observedAt: 1_000,
            evidenceHash: keccak256("fuzz")
        });
        vm.prank(address(this), OPERATOR);
        forwarder.deliver(address(feed), "", abi.encode(m));
        (, int256 answer,,,) = feed.latestRoundData();
        uint256 clamped = price <= lower ? 0 : price - lower > width ? width : price - lower;
        uint256 expectedValue = clamped * 1e8 / width;
        require(answer >= 1 && answer <= ONE);
        require(uint256(answer) == (expectedValue == 0 ? 1 : expectedValue));
    }

    function testSettlementReturnsFinalLongValueWithFreshTimestamp() public {
        pushSim(150, 1_000);
        settleMarket(250);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = latest(sim);
        require(roundId == 2 && answeredInRound == 2);
        require(answer == 75_000_000);
        require(startedAt == 3_000 && updatedAt == block.timestamp && updatedAt == 3_000);
        vm.warp(3_000 + 30 days);
        (,,, updatedAt,) = latest(sim);
        require(updatedAt == block.timestamp);
        (uint80 pastId, int256 pastAnswer,,,) = sim.getRoundData(1);
        require(pastId == 1 && pastAnswer == 25_000_000);
        (pastId, pastAnswer,, updatedAt,) = sim.getRoundData(2);
        require(pastId == 2 && pastAnswer == 75_000_000 && updatedAt == block.timestamp);
        vm.expectRevert(PiryMarkFeed.NoData.selector);
        sim.getRoundData(3);
    }

    function testSettlementWithoutAnyMarkStillReturnsFinalValue() public {
        vm.expectRevert(PiryMarkFeed.NoData.selector);
        sim.latestRoundData();
        settleMarket(100);
        (uint80 roundId, int256 answer,, uint256 updatedAt,) = latest(sim);
        require(roundId == 1 && answer == 1 && updatedAt == block.timestamp);
    }

    function testFinalRoundIsNotVisibleBeforeSettlement() public {
        pushSim(250, 1_000);
        vm.expectRevert(PiryMarkFeed.NoData.selector);
        sim.getRoundData(2);
    }

    function testUpdatesAfterSettlementRevertInBothModes() public {
        pushSim(250, 1_000);
        settleMarket(250);
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(PiryMarkFeed.MarketSettled.selector);
        forwarder.deliver(address(sim), "", abi.encode(mark(sim, 100, 3_000)));
        vm.expectRevert(PiryMarkFeed.MarketSettled.selector);
        forwarder.deliver(address(strict), strictMetadata(WORKFLOW), abi.encode(mark(strict, 100, 3_000)));
        require(sim.latestRound() == 1 && strict.latestRound() == 0);
        (, int256 answer,,,) = latest(sim);
        require(answer == 75_000_000);
    }

    function testFuzzFinalValueMatchesMarketLongPayout(uint64 rawPrice) public {
        uint256 price = rawPrice % 500;
        settleMarket(price);
        (, int256 answer,,,) = latest(sim);
        require(answer >= 1 && answer <= ONE);
        uint256 payout = market.previewRedeem(1_000_000, 0);
        require(uint256(answer) / 100 == payout || (payout == 0 && answer == 1));
    }

    function testImplementsAggregatorInterface() public view {
        AggregatorV3Interface feed = AggregatorV3Interface(address(sim));
        require(feed.decimals() == 8 && feed.version() == 1);
    }
}
