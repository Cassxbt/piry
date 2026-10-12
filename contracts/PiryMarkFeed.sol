// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICREReceiver} from "./SettlementReceiver.sol";
import {ComputeMarket} from "./ComputeMarket.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title PiryMarkFeed
/// @notice Chainlink AggregatorV3-compatible mark price for the long claim of one `ComputeMarket`, so an
/// exchange that needs a price source can list it. The answer is the USD value of one whole long claim
/// with 8 decimals, from 1 to 1e8 (a claim redeems between 0 and 1 unit of a USD-pegged collateral).
/// The floor is 1, not 0: exchanges reject non-positive prices, and a worthless claim must stay withdrawable.
/// Updates arrive as CRE reports. Strict mode pins a workflow ID. Simulation mode is DEMO ONLY: the
/// mock forwarder of `cre workflow simulate --broadcast` carries only placeholder workflow identity, so the operator
/// EOA that signs the broadcast is trusted via `tx.origin` instead.
/// Once the market settles the answer is final and `latestRoundData` reports it as updated now, so the
/// price never goes stale for holders who still need to withdraw.
contract PiryMarkFeed is AggregatorV3Interface, ICREReceiver {
    struct Mark {
        address feed;
        uint256 chainId;
        bytes32 indexId;
        uint256 indexPrice;
        uint64 observedAt;
        bytes32 evidenceHash;
    }

    struct Round {
        int256 answer;
        uint256 indexPrice;
        uint64 observedAt;
        bytes32 evidenceHash;
    }

    error InvalidConfig();
    error UntrustedForwarder();
    error InvalidMetadata();
    error UntrustedWorkflow();
    error UntrustedOperator();
    error InvalidPayload();
    error InvalidMark();
    error MarketSettled();
    error NoData();

    event MarkUpdated(
        uint80 indexed roundId, int256 answer, uint256 indexPrice, uint64 observedAt, bytes32 evidenceHash
    );

    uint256 private constant SCALE = 1e8;

    address public immutable forwarder;
    bytes32 public immutable workflowId;
    address public immutable operator;
    ComputeMarket public immutable market;
    bytes32 public immutable indexId;
    uint256 public immutable lower;
    uint256 public immutable upper;

    uint80 public latestRound;
    mapping(uint80 => Round) public rounds;

    constructor(address forwarder_, bytes32 workflowId_, address operator_, ComputeMarket market_) {
        // Exactly one of workflow ID (strict) or operator (simulation).
        if (
            forwarder_.code.length == 0 || address(market_).code.length == 0
                || (workflowId_ == bytes32(0)) == (operator_ == address(0))
        ) revert InvalidConfig();
        forwarder = forwarder_;
        workflowId = workflowId_;
        operator = operator_;
        market = market_;
        indexId = market_.indexId();
        lower = market_.lower();
        upper = market_.upper();
    }

    function isSimulation() public view returns (bool) {
        return operator != address(0);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(ICREReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function onReport(bytes calldata metadata, bytes calldata payload) external {
        if (msg.sender != forwarder) revert UntrustedForwarder();
        if (isSimulation()) {
            if (tx.origin != operator) revert UntrustedOperator();
        } else {
            // KeystoneForwarder: workflow ID (32), name (10), owner (20), report ID (2).
            if (metadata.length != 64) revert InvalidMetadata();
            if (bytes32(metadata[:32]) != workflowId) revert UntrustedWorkflow();
        }
        if (payload.length != 192) revert InvalidPayload();
        Mark memory mark = abi.decode(payload, (Mark));
        if (market.settled()) revert MarketSettled();
        if (
            mark.feed != address(this) || mark.chainId != block.chainid || mark.indexId != indexId
                || mark.evidenceHash == bytes32(0) || mark.observedAt <= rounds[latestRound].observedAt
                || mark.observedAt > block.timestamp
        ) revert InvalidMark();
        int256 answer = _longValue(mark.indexPrice);
        uint80 roundId = ++latestRound;
        rounds[roundId] = Round(answer, mark.indexPrice, mark.observedAt, mark.evidenceHash);
        emit MarkUpdated(roundId, answer, mark.indexPrice, mark.observedAt, mark.evidenceHash);
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "PIRY-L / USD";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return _roundData(market.settled() ? latestRound + 1 : latestRound);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        return _roundData(roundId);
    }

    function _roundData(uint80 roundId) private view returns (uint80, int256, uint256, uint256, uint80) {
        if (roundId == 0 || roundId > latestRound + 1) revert NoData();
        if (roundId <= latestRound) {
            Round storage round = rounds[roundId];
            return (roundId, round.answer, round.observedAt, round.observedAt, roundId);
        }
        // The final round exists only once the market has settled; its value cannot change.
        if (!market.settled()) revert NoData();
        return (roundId, _longValue(market.settlementPrice()), market.reportPublishedAt(), block.timestamp, roundId);
    }

    function _longValue(uint256 indexPrice) private view returns (int256) {
        uint256 width = upper - lower;
        uint256 above = indexPrice <= lower ? 0 : Math.min(indexPrice - lower, width);
        return SafeCast.toInt256(Math.max(Math.mulDiv(above, SCALE, width), 1));
    }
}
