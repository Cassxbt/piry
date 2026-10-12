// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {AggregatorV3Interface} from "../contracts/PiryMarkFeed.sol";
import {PiryShortFeed} from "../contracts/PiryShortFeed.sol";

interface Vm {
    function expectRevert(bytes4) external;
}

contract StubLongFeed {
    int256 public answer;
    uint80 public round = 7;
    bool public empty;

    function set(int256 answer_) external {
        answer = answer_;
    }

    function clear() external {
        empty = true;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!empty, "NoData");
        return (round, answer, 100, 200, round);
    }

    function getRoundData(uint80 id) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (id, answer, 100, 200, id);
    }
}

contract PiryShortFeedTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    StubLongFeed internal stub;
    PiryShortFeed internal feed;

    function setUp() public {
        stub = new StubLongFeed();
        feed = new PiryShortFeed(AggregatorV3Interface(address(stub)));
    }

    function testComplementsLongAndKeepsRoundMetadata() public {
        stub.set(44_425_000);
        (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) = feed.latestRoundData();
        require(id == 7 && answer == 55_575_000 && startedAt == 100 && updatedAt == 200 && answeredIn == 7);
        (, int256 past,,,) = feed.getRoundData(3);
        require(past == 55_575_000);
    }

    function testNeverReportsZeroOrNegative() public {
        stub.set(1e8);
        (, int256 full,,,) = feed.latestRoundData();
        require(full == 1);
        stub.set(1);
        (, int256 floor,,,) = feed.latestRoundData();
        require(floor == 1e8 - 1);
    }

    function testFuzzStaysWithinOneToOne(int256 longAnswer) public {
        if (longAnswer < 1 || longAnswer > 1e8) return;
        stub.set(longAnswer);
        (, int256 answer,,,) = feed.latestRoundData();
        require(answer >= 1 && answer <= 1e8);
        require(longAnswer == 1e8 ? answer == 1 : answer == 1e8 - longAnswer);
    }

    function testRejectsOutOfRangeLongAnswer() public {
        stub.set(1e8 + 1);
        vm.expectRevert(PiryShortFeed.InvalidLongAnswer.selector);
        feed.latestRoundData();
    }

    function testMetadataAndConfig() public {
        require(feed.decimals() == 8 && feed.version() == 1);
        require(keccak256(bytes(feed.description())) == keccak256("PIRY-S / USD"));
        vm.expectRevert(PiryShortFeed.InvalidConfig.selector);
        new PiryShortFeed(AggregatorV3Interface(address(0x1234)));
    }
}
