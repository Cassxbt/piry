// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {AggregatorV3Interface} from "./PiryMarkFeed.sol";

/// @title PiryShortFeed
/// @notice AggregatorV3-compatible price of one whole short claim, derived from the long claim's feed: a long and a
/// short always redeem for exactly one collateral unit together, so short = 1 - long. Round metadata and freshness
/// pass through unchanged. Floored at 1 (1e-8 USD) so an exchange never sees a non-positive price.
contract PiryShortFeed is AggregatorV3Interface {
    error InvalidConfig();
    error InvalidLongAnswer();

    int256 private constant ONE = 1e8;

    AggregatorV3Interface public immutable longFeed;

    constructor(AggregatorV3Interface longFeed_) {
        if (address(longFeed_).code.length == 0) revert InvalidConfig();
        longFeed = longFeed_;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "PIRY-S / USD";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) = longFeed.latestRoundData();
        return (id, _short(answer), startedAt, updatedAt, answeredIn);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) = longFeed.getRoundData(roundId);
        return (id, _short(answer), startedAt, updatedAt, answeredIn);
    }

    function _short(int256 longAnswer) private pure returns (int256) {
        if (longAnswer < 1 || longAnswer > ONE) revert InvalidLongAnswer();
        return longAnswer == ONE ? int256(1) : ONE - longAnswer;
    }
}
