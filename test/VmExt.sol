// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {Vm} from "./ComputeMarket.t.sol";

interface VmExt is Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address sender, address origin) external;
    function startPrank(address sender, address origin) external;
    function expectRevert(bytes calldata) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}
