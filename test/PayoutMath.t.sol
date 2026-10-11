// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {PayoutMath} from "../contracts/PayoutMath.sol";

contract PayoutMathTest {
    function testBelowFloorPaysOnlyShort() public pure {
        (uint256 longPayout, uint256 shortPayout) = PayoutMath.payouts(1_000_000, 99, 100, 300);
        require(longPayout == 0 && shortPayout == 1_000_000);
    }

    function testAtFloorAndCap() public pure {
        (uint256 a, uint256 b) = PayoutMath.payouts(1_000_000, 100, 100, 300);
        require(a == 0 && b == 1_000_000);
        (a, b) = PayoutMath.payouts(1_000_000, 300, 100, 300);
        require(a == 1_000_000 && b == 0);
    }

    function testMidpointAndAboveCap() public pure {
        (uint256 a, uint256 b) = PayoutMath.payouts(1_000_000, 200, 100, 300);
        require(a == 500_000 && b == 500_000);
        (a, b) = PayoutMath.payouts(1_000_000, type(uint256).max, 100, 300);
        require(a == 1_000_000 && b == 0);
    }

    function testRoundingNeverOverpays() public pure {
        (uint256 a, uint256 b) = PayoutMath.payouts(2, 1, 0, 3);
        require(a == 0 && b == 1);
    }

    function testFullPrecisionMultiplication() public pure {
        (uint256 a, uint256 b) = PayoutMath.payouts(type(uint256).max, 2, 0, 3);
        require(a == type(uint256).max / 3 * 2 && b == type(uint256).max / 3);
    }

    function invalidBounds(uint256 lower, uint256 upper) external pure {
        PayoutMath.payouts(1, 1, lower, upper);
    }

    function testRejectsInvalidBounds() public {
        (bool equal,) = address(this).call(abi.encodeCall(this.invalidBounds, (1, 1)));
        (bool reversed,) = address(this).call(abi.encodeCall(this.invalidBounds, (2, 1)));
        require(!equal && !reversed);
    }

    function testFuzzConservationAndMonotonicity(uint128 quantity, uint128 price, uint128 width) public pure {
        uint256 upper = uint256(width) + 1;
        (uint256 a, uint256 b) = PayoutMath.payouts(quantity, price, 0, upper);
        require(a + b <= quantity && quantity - (a + b) <= 1);
        (uint256 next,) = PayoutMath.payouts(quantity, uint256(price) + 1, 0, upper);
        require(next >= a);
    }

    function testFuzzSplittingCannotIncreasePayout(uint128 x, uint128 y, uint128 price, uint128 width) public pure {
        uint256 upper = uint256(width) + 1;
        (uint256 a, uint256 b) = PayoutMath.payouts(x, price, 0, upper);
        (uint256 c, uint256 d) = PayoutMath.payouts(y, price, 0, upper);
        (uint256 togetherLong, uint256 togetherShort) = PayoutMath.payouts(uint256(x) + y, price, 0, upper);
        require(a + c <= togetherLong && b + d <= togetherShort);
    }

    function testZeroQuantityAndNarrowMaximumBounds() public pure {
        (uint256 a, uint256 b) = PayoutMath.payouts(0, 11, 10, 12);
        require(a == 0 && b == 0);
        (a, b) = PayoutMath.payouts(9, type(uint256).max - 1, type(uint256).max - 1, type(uint256).max);
        require(a == 0 && b == 9);
        (a, b) = PayoutMath.payouts(9, type(uint256).max, type(uint256).max - 1, type(uint256).max);
        require(a == 9 && b == 0);
    }

    function testTranslatedBounds() public pure {
        (uint256 a, uint256 b) = PayoutMath.payouts(1_000_000, 175, 100, 300);
        require(a == 375_000 && b == 625_000);
    }

    function testFuzzFullWidthConservation(uint256 quantity, uint256 price, uint256 lower, uint256 upper) public pure {
        if (lower == upper) return;
        if (lower > upper) (lower, upper) = (upper, lower);
        (uint256 a, uint256 b) = PayoutMath.payouts(quantity, price, lower, upper);
        require(a <= quantity && b <= quantity - a && quantity - a - b <= 1);
        if (price != type(uint256).max) {
            (uint256 nextLong, uint256 nextShort) = PayoutMath.payouts(quantity, price + 1, lower, upper);
            require(nextLong >= a && nextShort <= b);
        }
    }
}
