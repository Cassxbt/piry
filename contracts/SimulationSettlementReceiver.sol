// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ICREReceiver} from "./SettlementReceiver.sol";
import {ComputeMarket} from "./ComputeMarket.sol";

/// @title SimulationSettlementReceiver
/// @notice DEMO ONLY. Operator-gated settlement receiver for `cre workflow simulate --broadcast`.
/// @dev Chainlink's MockKeystoneForwarder does not verify DON signatures and does not supply workflow
/// identity metadata, so any caller could push a report through it. This contract therefore trusts a
/// single operator EOA instead: a report is accepted only when the forwarder calls and `tx.origin` is
/// that operator. There is no workflow, DON or signature authentication, and `tx.origin` can be abused
/// by a contract the operator is tricked into calling. Production markets must use `SettlementReceiver`.
contract SimulationSettlementReceiver is ICREReceiver {
    error InvalidConfig();
    error UntrustedForwarder();
    error UntrustedOperator();
    error InvalidPayload();

    event DemoReportAccepted(address indexed market, bytes32 indexed evidenceHash, address indexed operator);

    address public immutable forwarder;
    address public immutable operator;

    constructor(address forwarder_, address operator_) {
        if (forwarder_.code.length == 0 || operator_ == address(0)) revert InvalidConfig();
        forwarder = forwarder_;
        operator = operator_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(ICREReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function onReport(bytes calldata, bytes calldata payload) external {
        if (msg.sender != forwarder) revert UntrustedForwarder();
        // The mock forwarder omits workflow metadata, so the operator's transaction is the only identity.
        if (tx.origin != operator) revert UntrustedOperator();
        if (payload.length != 320) revert InvalidPayload();
        ComputeMarket.Report memory report = abi.decode(payload, (ComputeMarket.Report));
        // The market checks authority, destination chain, series binding, freshness and replay.
        ComputeMarket(report.market).settle(report);
        emit DemoReportAccepted(report.market, report.evidenceHash, operator);
    }
}
