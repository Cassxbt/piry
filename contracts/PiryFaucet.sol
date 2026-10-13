// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title PiryFaucet
/// @notice TESTNET ONLY. Gives each address one fixed drip of test collateral so outside testers and judges can
/// mint and trade Piry claims. The owner can reclaim the unused balance.
contract PiryFaucet {
    using SafeERC20 for IERC20;

    error InvalidConfig();
    error AlreadyClaimed();
    error OnlyOwner();

    event Dripped(address indexed account, uint256 amount);
    event Reclaimed(address indexed to, uint256 amount);

    IERC20 public immutable token;
    uint256 public immutable amount;
    address public immutable owner;
    mapping(address => bool) public claimed;

    constructor(IERC20 token_, uint256 amount_) {
        if (address(token_).code.length == 0 || amount_ == 0) revert InvalidConfig();
        token = token_;
        amount = amount_;
        owner = msg.sender;
    }

    function drip() external {
        if (claimed[msg.sender]) revert AlreadyClaimed();
        claimed[msg.sender] = true;
        token.safeTransfer(msg.sender, amount);
        emit Dripped(msg.sender, amount);
    }

    function reclaim(address to) external {
        if (msg.sender != owner) revert OnlyOwner();
        uint256 balance = token.balanceOf(address(this));
        token.safeTransfer(to, balance);
        emit Reclaimed(to, balance);
    }
}
