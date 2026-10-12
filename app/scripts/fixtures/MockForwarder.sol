// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

// Local stand-in for Chainlink's MockKeystoneForwarder, used only by the app's development harness.
// Like the real mock it is permissionless, checks no signatures, swallows a reverting receiver and still
// succeeds, reporting the outcome only through ReportProcessed(result).
contract MockForwarder {
    event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result);

    function report(address receiver, bytes calldata rawReport, bytes calldata, bytes[] calldata) external {
        bytes32 executionId = bytes32(rawReport[1:33]);
        bytes2 reportId = bytes2(rawReport[107:109]);
        (bool ok,) = receiver.call(abi.encodeCall(IReceiver.onReport, (rawReport[45:109], rawReport[109:])));
        emit ReportProcessed(receiver, executionId, reportId, ok);
    }
}
