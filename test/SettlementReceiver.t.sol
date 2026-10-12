// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SettlementReceiver, ICREReceiver} from "../contracts/SettlementReceiver.sol";
import {ComputeMarket} from "../contracts/ComputeMarket.sol";
import {Vm, TestCollateral} from "./ComputeMarket.t.sol";

// Local transport fixture; it does not verify DON signatures.
contract TestForwarder {
    function deliver(SettlementReceiver receiver, bytes memory metadata, bytes memory payload) external {
        receiver.onReport(metadata, payload);
    }

    function deliverCatching(SettlementReceiver receiver, bytes memory metadata, bytes memory payload)
        external
        returns (bool success)
    {
        (success,) = address(receiver).call(abi.encodeCall(receiver.onReport, (metadata, payload)));
    }
}

contract SettlementReceiverTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 internal constant WORKFLOW = keccak256("piry-workflow-v1");
    TestForwarder internal forwarder;
    SettlementReceiver internal receiver;
    ComputeMarket internal market;
    TestCollateral internal usd;

    function setUp() public {
        vm.warp(1_000);
        forwarder = new TestForwarder();
        receiver = new SettlementReceiver(address(forwarder), WORKFLOW);
        usd = new TestCollateral();
        market = new ComputeMarket(
            ComputeMarket.Config({
                collateral: address(usd),
                settlementAuthority: address(receiver),
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

    function metadata(bytes32 workflow) internal pure returns (bytes memory) {
        return abi.encodePacked(workflow, bytes10("piry"), address(0x1234), bytes2(0x0001));
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

    function deliver(ComputeMarket.Report memory r) internal {
        forwarder.deliver(receiver, metadata(WORKFLOW), abi.encode(r));
    }

    function testAuthenticatedSettlementAndRedemption() public {
        usd.mint(address(this), 1_000_000);
        usd.approve(address(market), 1_000_000);
        market.mintPairs(1_000_000);
        vm.warp(3_000);
        deliver(report());
        require(market.settled() && market.settlementPrice() == 250);
        require(market.settlementEvidenceHash() == report().evidenceHash);
        market.redeem(1_000_000, 1_000_000, address(this), 1_000_000);
        require(usd.balanceOf(address(this)) == 1_000_000 && market.collateralLocked() == 0);
    }

    function testERC165() public view {
        require(receiver.supportsInterface(type(IERC165).interfaceId));
        require(receiver.supportsInterface(type(ICREReceiver).interfaceId));
        require(receiver.supportsInterface(0x805f2132));
        require(!receiver.supportsInterface(0xffffffff));
    }

    function testRejectsUntrustedCallerEvenWithValidMetadata() public {
        vm.warp(3_000);
        vm.expectRevert(SettlementReceiver.UntrustedForwarder.selector);
        receiver.onReport(metadata(WORKFLOW), abi.encode(report()));
        require(!market.settled());
    }

    function testRejectsWrongWorkflow() public {
        vm.warp(3_000);
        vm.expectRevert(SettlementReceiver.UntrustedWorkflow.selector);
        forwarder.deliver(receiver, metadata(keccak256("other")), abi.encode(report()));
    }

    function testRejectsEmptyAndLegacyMetadata() public {
        vm.warp(3_000);
        vm.expectRevert(SettlementReceiver.InvalidMetadata.selector);
        forwarder.deliver(receiver, "", abi.encode(report()));
        vm.expectRevert(SettlementReceiver.InvalidMetadata.selector);
        forwarder.deliver(receiver, abi.encodePacked(WORKFLOW, bytes10("piry"), address(0x1234)), abi.encode(report()));
    }

    function testRejectsTruncatedAndTrailingPayload() public {
        vm.warp(3_000);
        vm.expectRevert(SettlementReceiver.InvalidPayload.selector);
        forwarder.deliver(receiver, metadata(WORKFLOW), hex"00");
        vm.expectRevert(SettlementReceiver.InvalidPayload.selector);
        forwarder.deliver(receiver, metadata(WORKFLOW), bytes.concat(abi.encode(report()), hex"00"));
    }

    function testReplayCannotSettleTwice() public {
        vm.warp(3_000);
        deliver(report());
        vm.expectRevert(ComputeMarket.AlreadySettled.selector);
        deliver(report());
    }

    function testWrongChainDoesNotConsumeSettlement() public {
        vm.warp(3_000);
        ComputeMarket.Report memory r = report();
        r.chainId += 1;
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        deliver(r);
        require(!market.settled());
        deliver(report());
        require(market.settled());
    }

    function testRejectsUnrelatedMarketAuthority() public {
        ComputeMarket other = new ComputeMarket(
            ComputeMarket.Config({
                collateral: address(usd),
                settlementAuthority: address(this),
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
        vm.warp(3_000);
        ComputeMarket.Report memory r = report();
        r.market = address(other);
        vm.expectRevert(ComputeMarket.Unauthorized.selector);
        deliver(r);
        require(!market.settled() && !other.settled());
    }

    function testRejectsFutureStaleAndEarlyReports() public {
        vm.warp(2_999);
        vm.expectRevert(ComputeMarket.BeforeExpiry.selector);
        deliver(report());
        vm.warp(3_000);
        ComputeMarket.Report memory r = report();
        r.publishedAt = 3_001;
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        deliver(r);
        vm.warp(3_101);
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        deliver(report());
        require(!market.settled());
    }

    function testFuzzRejectsNonstandardMetadataLength(uint8 length) public {
        if (length == 64) return;
        vm.warp(3_000);
        bytes memory malformed = new bytes(length);
        bytes memory payload = abi.encode(report());
        vm.expectRevert(SettlementReceiver.InvalidMetadata.selector);
        forwarder.deliver(receiver, malformed, payload);
        require(!market.settled());
    }

    function testRejectsNonCanonicalABIValues() public {
        vm.warp(3_000);
        bytes memory payload = abi.encode(report());
        // The fifth word is uint8 priceDecimals; nonzero high bits are invalid ABI.
        assembly { mstore(add(payload, 160), 258) }
        vm.expectRevert();
        forwarder.deliver(receiver, metadata(WORKFLOW), payload);
        require(!market.settled());
        deliver(report());
    }

    function testRejectsMarketWithoutCode() public {
        vm.warp(3_000);
        ComputeMarket.Report memory r = report();
        r.market = address(0x1234);
        vm.expectRevert();
        deliver(r);
        require(!market.settled());
    }

    function testOuterCallSuccessDoesNotProveSettlement() public {
        vm.warp(3_000);
        bool delivered =
            forwarder.deliverCatching(receiver, metadata(keccak256("wrong-workflow")), abi.encode(report()));
        require(!delivered && !market.settled());
        delivered = forwarder.deliverCatching(receiver, metadata(WORKFLOW), abi.encode(report()));
        require(delivered && market.settled());
    }

    function testIndependentSeriesAndImmutableSettlement() public {
        bytes32 secondSpec = keccak256("second-spec");
        ComputeMarket second = new ComputeMarket(
            ComputeMarket.Config({
                collateral: address(usd),
                settlementAuthority: address(receiver),
                indexId: keccak256("demo-index"),
                specHash: secondSpec,
                priceDecimals: 2,
                lower: 100,
                upper: 300,
                periodStart: 2_000,
                periodEnd: 3_000,
                maxReportAge: 100,
                fallbackDelay: 1_000
            })
        );
        vm.warp(3_000);
        ComputeMarket.Report memory r = report();
        r.market = address(second);
        vm.expectRevert(ComputeMarket.InvalidReport.selector);
        deliver(r);
        require(!market.settled() && !second.settled());
        deliver(report());
        r.specHash = secondSpec;
        r.price = 150;
        deliver(r);
        require(market.settlementPrice() == 250 && second.settlementPrice() == 150);
        bytes32 originalEvidence = second.settlementEvidenceHash();
        r.price = 300;
        r.evidenceHash = keccak256("replacement");
        vm.expectRevert(ComputeMarket.AlreadySettled.selector);
        deliver(r);
        require(second.settlementPrice() == 150 && second.settlementEvidenceHash() == originalEvidence);
    }

    function testRejectsInvalidConfiguration() public {
        vm.expectRevert(SettlementReceiver.InvalidConfig.selector);
        new SettlementReceiver(address(0), WORKFLOW);
        vm.expectRevert(SettlementReceiver.InvalidConfig.selector);
        new SettlementReceiver(address(0x123), WORKFLOW);
        vm.expectRevert(SettlementReceiver.InvalidConfig.selector);
        new SettlementReceiver(address(forwarder), bytes32(0));
    }
}
