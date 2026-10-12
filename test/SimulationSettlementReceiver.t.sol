// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICREReceiver} from "../contracts/SettlementReceiver.sol";
import {SimulationSettlementReceiver} from "../contracts/SimulationSettlementReceiver.sol";
import {ComputeMarket} from "../contracts/ComputeMarket.sol";
import {TestCollateral} from "./ComputeMarket.t.sol";
import {VmExt} from "./VmExt.sol";

// Local transport fixture; it does not verify DON signatures.
contract GenericForwarder {
    function deliver(address receiver, bytes memory metadata, bytes memory payload) external {
        ICREReceiver(receiver).onReport(metadata, payload);
    }
}

contract SimulationSettlementReceiverTest {
    VmExt internal constant vm = VmExt(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant OPERATOR = address(0x0BE7A);
    address internal constant STRANGER = address(0x57A4);
    GenericForwarder internal forwarder;
    SimulationSettlementReceiver internal receiver;
    ComputeMarket internal market;
    TestCollateral internal usd;

    function setUp() public {
        vm.warp(1_000);
        forwarder = new GenericForwarder();
        receiver = new SimulationSettlementReceiver(address(forwarder), OPERATOR);
        usd = new TestCollateral();
        market = newMarket(address(receiver));
    }

    function newMarket(address authority) internal returns (ComputeMarket) {
        return new ComputeMarket(
            ComputeMarket.Config({
                collateral: address(usd),
                settlementAuthority: authority,
                indexId: keccak256("demo-index"),
                specHash: keccak256("demo-spec"),
                priceDecimals: 2,
                lower: 100,
                upper: 300,
                periodStart: 2_000,
                periodEnd: 3_000,
                maxReportAge: 100,
                fallbackDelay: 1_000
            })
        );
    }

    function report() internal view returns (ComputeMarket.Report memory) {
        return ComputeMarket.Report({
            market: address(market),
            chainId: block.chainid,
            indexId: keccak256("demo-index"),
            specHash: keccak256("demo-spec"),
            priceDecimals: 2,
            periodStart: 2_000,
            periodEnd: 3_000,
            price: 250,
            publishedAt: 3_000,
            evidenceHash: keccak256("demo-evidence")
        });
    }

    function deliverAsOperator(bytes memory metadata, bytes memory payload) internal {
        vm.prank(address(this), OPERATOR);
        forwarder.deliver(address(receiver), metadata, payload);
    }

    function testOperatorDeliveryThroughForwarderSettlesAndRedeems() public {
        usd.mint(address(this), 1_000_000);
        usd.approve(address(market), 1_000_000);
        market.mintPairs(1_000_000);
        vm.warp(3_000);
        deliverAsOperator("", abi.encode(report()));
        require(market.settled() && !market.settledByFallback() && market.settlementPrice() == 250);
        require(market.settlementEvidenceHash() == report().evidenceHash);
        market.redeem(1_000_000, 1_000_000, address(this), 1_000_000);
        require(usd.balanceOf(address(this)) == 1_000_000 && market.collateralLocked() == 0);
    }

    function testFuzzAcceptsAnyMetadataLength(uint8 length) public {
        vm.warp(3_000);
        deliverAsOperator(new bytes(length), abi.encode(report()));
        require(market.settled());
    }

    function testAcceptsProductionLengthMetadata() public {
        vm.warp(3_000);
        deliverAsOperator(abi.encodePacked(bytes32(uint256(1)), bytes10("piry"), address(0x1234), bytes2(0x0001)), abi.encode(report()));
        require(market.settled());
    }

    function testRejectsCallerThatIsNotTheForwarderEvenIfOperator() public {
        vm.warp(3_000);
        vm.prank(OPERATOR, OPERATOR);
        vm.expectRevert(SimulationSettlementReceiver.UntrustedForwarder.selector);
        receiver.onReport("", abi.encode(report()));
        vm.prank(STRANGER, OPERATOR);
        vm.expectRevert(SimulationSettlementReceiver.UntrustedForwarder.selector);
        receiver.onReport("", abi.encode(report()));
        require(!market.settled());
    }

    function testRejectsForwarderCallWhoseOriginIsNotTheOperator() public {
        vm.warp(3_000);
        vm.prank(STRANGER, STRANGER);
        vm.expectRevert(SimulationSettlementReceiver.UntrustedOperator.selector);
        forwarder.deliver(address(receiver), "", abi.encode(report()));
        require(!market.settled());
    }

    function testForwarderCheckPrecedesOriginCheck() public {
        vm.warp(3_000);
        vm.prank(STRANGER, STRANGER);
        vm.expectRevert(SimulationSettlementReceiver.UntrustedForwarder.selector);
        receiver.onReport("", abi.encode(report()));
    }

    function testRejectsTruncatedAndTrailingPayload() public {
        vm.warp(3_000);
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(SimulationSettlementReceiver.InvalidPayload.selector);
        forwarder.deliver(address(receiver), "", hex"00");
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(SimulationSettlementReceiver.InvalidPayload.selector);
        forwarder.deliver(address(receiver), "", bytes.concat(abi.encode(report()), hex"00"));
        require(!market.settled());
    }

    function testRejectsNonCanonicalABIValues() public {
        vm.warp(3_000);
        bytes memory payload = abi.encode(report());
        // The fifth word is uint8 priceDecimals; nonzero high bits are invalid ABI.
        assembly { mstore(add(payload, 160), 258) }
        vm.prank(address(this), OPERATOR);
        vm.expectRevert();
        forwarder.deliver(address(receiver), "", payload);
        require(!market.settled());
        deliverAsOperator("", abi.encode(report()));
        require(market.settled());
    }

    function testReplayCannotSettleTwice() public {
        vm.warp(3_000);
        deliverAsOperator("", abi.encode(report()));
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(ComputeMarket.AlreadySettled.selector);
        forwarder.deliver(address(receiver), "", abi.encode(report()));
        ComputeMarket.Report memory r = report();
        r.price = 300;
        r.evidenceHash = keccak256("replacement");
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(ComputeMarket.AlreadySettled.selector);
        forwarder.deliver(address(receiver), "", abi.encode(r));
        require(market.settlementPrice() == 250 && market.settlementEvidenceHash() == report().evidenceHash);
    }

    function testWrongChainDoesNotConsumeSettlement() public {
        vm.warp(3_000);
        ComputeMarket.Report memory r = report();
        r.chainId += 1;
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        forwarder.deliver(address(receiver), "", abi.encode(r));
        require(!market.settled());
        deliverAsOperator("", abi.encode(report()));
        require(market.settled());
    }

    function testMarketStillRejectsMarketsWithAnotherAuthority() public {
        ComputeMarket other = newMarket(address(this));
        vm.warp(3_000);
        ComputeMarket.Report memory r = report();
        r.market = address(other);
        vm.prank(address(this), OPERATOR);
        vm.expectRevert(ComputeMarket.Unauthorized.selector);
        forwarder.deliver(address(receiver), "", abi.encode(r));
        require(!other.settled());
    }

    function testEmitsOperatorGatedDemoEvent() public {
        vm.warp(3_000);
        vm.recordLogs();
        deliverAsOperator("", abi.encode(report()));
        VmExt.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 2);
        require(logs[0].emitter == address(market));
        require(logs[1].emitter == address(receiver));
        require(logs[1].topics.length == 4);
        require(logs[1].topics[0] == keccak256("DemoReportAccepted(address,bytes32,address)"));
        require(logs[1].topics[1] == bytes32(uint256(uint160(address(market)))));
        require(logs[1].topics[2] == report().evidenceHash);
        require(logs[1].topics[3] == bytes32(uint256(uint160(OPERATOR))));
    }

    function testERC165() public view {
        require(receiver.supportsInterface(type(IERC165).interfaceId));
        require(receiver.supportsInterface(type(ICREReceiver).interfaceId));
        require(receiver.supportsInterface(0x805f2132));
        require(!receiver.supportsInterface(0xffffffff));
    }

    function testExposesImmutableConfiguration() public view {
        require(receiver.forwarder() == address(forwarder) && receiver.operator() == OPERATOR);
    }

    function testRejectsInvalidConfiguration() public {
        vm.expectRevert(SimulationSettlementReceiver.InvalidConfig.selector);
        new SimulationSettlementReceiver(address(0), OPERATOR);
        vm.expectRevert(SimulationSettlementReceiver.InvalidConfig.selector);
        new SimulationSettlementReceiver(address(0x123), OPERATOR);
        vm.expectRevert(SimulationSettlementReceiver.InvalidConfig.selector);
        new SimulationSettlementReceiver(address(forwarder), address(0));
    }
}
