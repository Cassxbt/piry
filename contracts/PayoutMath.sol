// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

library PayoutMath {
    error InvalidBounds();

    function payouts(uint256 quantity, uint256 price, uint256 lower, uint256 upper)
        internal
        pure
        returns (uint256 longPayout, uint256 shortPayout)
    {
        if (lower >= upper) revert InvalidBounds();
        if (price <= lower) return (0, quantity);
        if (price >= upper) return (quantity, 0);
        uint256 width = upper - lower;
        longPayout = Math.mulDiv(quantity, price - lower, width);
        shortPayout = Math.mulDiv(quantity, upper - price, width);
    }
}
