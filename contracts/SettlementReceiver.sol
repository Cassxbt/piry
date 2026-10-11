// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ComputeMarket} from "./ComputeMarket.sol";

interface ICREReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract SettlementReceiver is ICREReceiver {
    error InvalidConfig();
    error UntrustedForwarder();
    error InvalidMetadata();
    error UntrustedWorkflow();
    error InvalidPayload();

    event ReportAccepted(address indexed market, bytes32 indexed evidenceHash, bytes2 reportId);

    address public immutable forwarder;
    bytes32 public immutable workflowId;

    constructor(address forwarder_, bytes32 workflowId_) {
        if (forwarder_.code.length == 0 || workflowId_ == bytes32(0)) revert InvalidConfig();
        forwarder = forwarder_;
        workflowId = workflowId_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(ICREReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function onReport(bytes calldata metadata, bytes calldata payload) external {
        if (msg.sender != forwarder) revert UntrustedForwarder();
        // KeystoneForwarder: workflow ID (32), name (10), owner (20), report ID (2).
        if (metadata.length != 64) revert InvalidMetadata();
        if (bytes32(metadata[:32]) != workflowId) revert UntrustedWorkflow();
        if (payload.length != 320) revert InvalidPayload();
        ComputeMarket.Report memory report = abi.decode(payload, (ComputeMarket.Report));
        // The market checks authority, destination chain, series binding, freshness and replay.
        ComputeMarket(report.market).settle(report);
        emit ReportAccepted(report.market, report.evidenceHash, bytes2(metadata[62:64]));
    }
}
