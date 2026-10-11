// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ClaimToken is ERC20 {
    error OnlyMarket();

    address public immutable market;
    uint8 private immutable claimDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        market = msg.sender;
        claimDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return claimDecimals;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != market) revert OnlyMarket();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != market) revert OnlyMarket();
        _burn(from, amount);
    }
}
