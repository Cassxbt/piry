// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TESTNET ONLY. A worthless 6-decimal dollar stand-in that only its deployer can mint.
contract PiryTestUSD is ERC20 {
    error OnlyDeployer();

    address public immutable deployer;

    constructor() ERC20("Piry Test USD", "PTUSD") {
        deployer = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        _mint(to, amount);
    }
}
