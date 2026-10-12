// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ComputeMarket} from "../contracts/ComputeMarket.sol";
import {TestCollateral, Vm} from "./ComputeMarket.t.sol";

interface AdversarialVm is Vm {
    function expectRevert(bytes calldata) external;
}

contract CallbackCollateral is TestCollateral {
    ComputeMarket public target;
    bytes public callbackData;
    uint256 public attempts;
    bool public callbackSucceeded;
    bytes public callbackResult;
    bool private armed;

    function arm(ComputeMarket market, bytes memory data) external {
        target = market;
        callbackData = data;
        attempts = 0;
        callbackSucceeded = false;
        delete callbackResult;
        armed = true;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (armed && msg.sender == address(target) && from != address(0) && to != address(0)) {
            armed = false;
            attempts++;
            (callbackSucceeded, callbackResult) = address(target).call(callbackData);
        }
    }
}

contract FalseReturnCollateral is TestCollateral {
    bool public failInbound;
    bool public failOutbound;

    function setFailures(bool inbound, bool outbound) external {
        failInbound = inbound;
        failOutbound = outbound;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        super.transferFrom(from, to, amount);
        return !failInbound;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        return !failOutbound;
    }
}

contract ExcessDecimalsCollateral is ERC20 {
    constructor() ERC20("Invalid Decimals", "BAD") {}

    function decimals() public pure override returns (uint8) {
        return 19;
    }
}

contract SenderSurchargeCollateral is TestCollateral {
    bool private surcharge;

    function setSurcharge(bool enabled) external {
        surcharge = enabled;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (surcharge && from != address(0) && to != address(0) && amount > 0) {
            super._update(from, address(0), 1);
        }
        super._update(from, to, amount);
    }
}

contract AdversarialMarketTest {
    AdversarialVm private constant vm = AdversarialVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    uint256 private constant PAIR = 1_000_000;
    CallbackCollateral private callbackToken;
    TestCollateral private collateral;
    ComputeMarket private market;

    function setUp() public {
        vm.warp(1_000);
        callbackToken = new CallbackCollateral();
        _deployAndFund(callbackToken, address(this));
    }

    function testMintCallbackCannotReenterMint() public {
        _attack(0, 0);
    }

    function testMintCallbackCannotReenterMerge() public {
        _attack(0, 1);
    }

    function testMergeCallbackCannotReenterMint() public {
        _attack(1, 0);
    }

    function testMergeCallbackCannotReenterMerge() public {
        _attack(1, 1);
    }

    function testMergeCallbackCannotReenterRedeem() public {
        _attack(1, 2);
    }

    function testRedeemCallbackCannotReenterMerge() public {
        _attack(2, 1);
    }

    function testRedeemCallbackCannotReenterRedeem() public {
        _attack(2, 2);
    }

    function testAuthorizedCollateralCallbackCannotReenterSettlement() public {
        callbackToken = new CallbackCollateral();
        _deployAndFund(callbackToken, address(callbackToken));
        vm.warp(3_000);
        ComputeMarket.Report memory r = _report(250);
        callbackToken.arm(market, abi.encodeCall(ComputeMarket.settle, (r)));
        vm.prank(ALICE);
        market.mergePairs(PAIR / 2, BOB);
        _assertCallbackBlocked();
        _assertUnsettled();
        _assertBacking(1_500_000, 1_500_000, 1_500_000);
        _assertClaims(ALICE, PAIR / 2, PAIR / 2);
        _assertClaims(address(collateral), PAIR, PAIR);
        require(collateral.balanceOf(ALICE) == 9_000_000, "callback settlement changed holder collateral");
        require(collateral.balanceOf(BOB) == PAIR / 2, "outer merge paid incorrect collateral");
        require(collateral.balanceOf(address(collateral)) == 2_000_000, "callback settlement paid attacker");

        vm.prank(address(callbackToken));
        market.settle(r);
        require(market.settled() && market.settlementPrice() == 250, "authorized report failed outside callback");
    }

    function testUnauthorizedSettlementCannotChangeFundedMarketOrOverwriteReport() public {
        vm.warp(3_000);
        ComputeMarket.Report memory r = _report(250);
        address[3] memory attackers = [ALICE, BOB, address(collateral)];
        for (uint256 i; i < attackers.length; ++i) {
            vm.expectRevert(ComputeMarket.Unauthorized.selector);
            vm.prank(attackers[i]);
            market.settle(r);
            _assertUnsettled();
            _assertInitialPosition();
        }
        market.settle(r);
        r.price = 300;
        r.evidenceHash = keccak256("attacker evidence");
        for (uint256 i; i < attackers.length; ++i) {
            vm.expectRevert(ComputeMarket.Unauthorized.selector);
            vm.prank(attackers[i]);
            market.settle(r);
            require(market.settled() && market.settlementPrice() == 250, "unauthorized overwrite changed price");
            require(market.reportPublishedAt() == 3_000, "unauthorized overwrite changed publication time");
            require(
                market.settlementEvidenceHash() == keccak256("adversarial report"),
                "unauthorized overwrite changed evidence"
            );
            _assertInitialPosition();
        }
    }

    function testFalseReturnDepositRollsBackTransferAllowanceAndIssuance() public {
        FalseReturnCollateral token = new FalseReturnCollateral();
        _deployAndFund(token, address(this));
        token.setFailures(true, false);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token)));
        vm.prank(ALICE);
        market.mintPairs(PAIR / 2);
        _assertInitialPosition();
        _assertUnsettled();

        token.setFailures(false, false);
        vm.prank(ALICE);
        market.mintPairs(PAIR / 2);
        _assertBacking(2_500_000, 2_500_000, 2_500_000);
        _assertClaims(ALICE, 1_500_000, 1_500_000);
        require(token.balanceOf(ALICE) == 8_500_000, "deposit retry paid incorrect collateral");
        require(token.allowance(ALICE, address(market)) == 1_500_000, "deposit retry spent incorrect allowance");
    }

    function testFalseReturnMergeRollsBackTransferAndBothBurns() public {
        FalseReturnCollateral token = new FalseReturnCollateral();
        _deployAndFund(token, address(this));
        token.setFailures(false, true);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token)));
        vm.prank(ALICE);
        market.mergePairs(PAIR / 2, BOB);
        _assertInitialPosition();
        _assertUnsettled();

        token.setFailures(false, false);
        vm.prank(ALICE);
        market.mergePairs(PAIR / 2, BOB);
        _assertBacking(1_500_000, 1_500_000, 1_500_000);
        _assertClaims(ALICE, PAIR / 2, PAIR / 2);
        require(token.balanceOf(BOB) == PAIR / 2, "merge retry paid incorrect recipient balance");
    }

    function testFalseReturnRedeemRollsBackTransferAndAsymmetricBurns() public {
        FalseReturnCollateral token = new FalseReturnCollateral();
        _deployAndFund(token, address(this));
        vm.warp(3_000);
        market.settle(_report(250));
        token.setFailures(false, true);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(token)));
        vm.prank(ALICE);
        market.redeem(500_000, 200_000, BOB, 0);
        _assertInitialPosition();
        require(market.settled() && market.settlementPrice() == 250, "failed redeem changed settlement");
        require(market.reportPublishedAt() == 3_000, "failed redeem changed publication time");
        require(market.settlementEvidenceHash() == keccak256("adversarial report"), "failed redeem changed evidence");

        token.setFailures(false, false);
        vm.prank(ALICE);
        uint256 payout = market.redeem(500_000, 200_000, BOB, 0);
        require(payout == 425_000, "redeem retry returned incorrect payout");
        _assertBacking(1_575_000, 1_500_000, 1_800_000);
        _assertClaims(ALICE, 500_000, 800_000);
        require(token.balanceOf(BOB) == payout, "redeem retry paid incorrect recipient balance");
    }

    function testRejectsInvalidDeploymentParameters() public {
        for (uint256 i; i < 9; ++i) {
            ComputeMarket.Config memory config = _config(address(collateral), address(this));
            if (i == 0) config.collateral = address(0);
            else if (i == 1) config.collateral = BOB;
            else if (i == 2) config.settlementAuthority = address(0);
            else if (i == 3) config.upper = config.lower;
            else if (i == 4) config.upper = config.lower - 1;
            else if (i == 5) config.periodStart = uint64(block.timestamp - 1);
            else if (i == 6) config.periodEnd = config.periodStart;
            else if (i == 7) config.periodEnd = config.periodStart - 1;
            else config.maxReportAge = 0;
            vm.expectRevert(ComputeMarket.InvalidConfig.selector);
            new ComputeMarket(config);
        }
    }

    function testSenderSurchargeMergeRollsBackDebitBurnsAndCollateralSupply() public {
        SenderSurchargeCollateral token = new SenderSurchargeCollateral();
        _deployAndFund(token, address(this));
        token.setSurcharge(true);
        vm.expectRevert(ComputeMarket.UnsupportedCollateral.selector);
        vm.prank(ALICE);
        market.mergePairs(PAIR / 2, BOB);
        _assertInitialPosition();
        _assertUnsettled();
    }

    function testSenderSurchargeRedeemRollsBackDebitBurnsAndCollateralSupply() public {
        SenderSurchargeCollateral token = new SenderSurchargeCollateral();
        _deployAndFund(token, address(this));
        vm.warp(3_000);
        market.settle(_report(250));
        token.setSurcharge(true);
        vm.expectRevert(ComputeMarket.UnsupportedCollateral.selector);
        vm.prank(ALICE);
        market.redeem(500_000, 200_000, BOB, 0);
        _assertInitialPosition();
        require(market.settled() && market.settlementPrice() == 250, "surcharge redeem changed settlement");
        require(market.reportPublishedAt() == 3_000, "surcharge redeem changed publication time");
        require(market.settlementEvidenceHash() == keccak256("adversarial report"), "surcharge redeem changed evidence");
    }

    function testRejectsCollateralWithExcessDecimals() public {
        ExcessDecimalsCollateral token = new ExcessDecimalsCollateral();
        ComputeMarket.Config memory config = _config(address(token), address(this));
        vm.expectRevert(ComputeMarket.InvalidConfig.selector);
        new ComputeMarket(config);
    }

    function _attack(uint8 outerOperation, uint8 nestedOperation) private {
        if (outerOperation == 2 || (outerOperation == 1 && nestedOperation == 2)) {
            vm.warp(3_000);
            market.settle(_report(250));
        }
        bytes memory payload;
        if (nestedOperation == 0) {
            payload = abi.encodeCall(ComputeMarket.mintPairs, (PAIR / 4));
        } else if (nestedOperation == 1) {
            payload = abi.encodeCall(ComputeMarket.mergePairs, (PAIR / 4, address(callbackToken)));
        } else {
            payload = abi.encodeCall(ComputeMarket.redeem, (PAIR / 4, PAIR / 4, address(callbackToken), 0));
        }
        callbackToken.arm(market, payload);
        vm.prank(ALICE);
        if (outerOperation == 0) market.mintPairs(PAIR / 2);
        else if (outerOperation == 1) market.mergePairs(PAIR / 2, BOB);
        else require(market.redeem(500_000, 200_000, BOB, 0) == 425_000, "outer redeem payout incorrect");
        _assertCallbackBlocked();
        _assertClaims(address(callbackToken), PAIR, PAIR);
        require(collateral.balanceOf(address(callbackToken)) == 2_000_000, "callback changed attacker collateral");
        require(collateral.allowance(address(callbackToken), address(market)) == 2_000_000, "callback spent allowance");

        if (outerOperation == 0) {
            _assertClaims(ALICE, 1_500_000, 1_500_000);
            _assertBacking(2_500_000, 2_500_000, 2_500_000);
            require(collateral.balanceOf(ALICE) == 8_500_000, "outer mint collateral incorrect");
            require(collateral.balanceOf(BOB) == 0, "mint callback paid recipient");
        } else if (outerOperation == 1) {
            _assertClaims(ALICE, 500_000, 500_000);
            _assertBacking(1_500_000, 1_500_000, 1_500_000);
            require(collateral.balanceOf(ALICE) == 9_000_000, "merge callback changed holder collateral");
            require(collateral.balanceOf(BOB) == 500_000, "outer merge collateral incorrect");
        } else {
            _assertClaims(ALICE, 500_000, 800_000);
            _assertBacking(1_575_000, 1_500_000, 1_800_000);
            require(collateral.balanceOf(ALICE) == 9_000_000, "redeem callback changed holder collateral");
            require(collateral.balanceOf(BOB) == 425_000, "outer redeem collateral incorrect");
        }
        if (market.settled()) {
            require(market.settlementPrice() == 250, "callback changed settlement price");
            require(market.reportPublishedAt() == 3_000, "callback changed publication time");
            require(market.settlementEvidenceHash() == keccak256("adversarial report"), "callback changed evidence");
        } else {
            _assertUnsettled();
        }
    }

    function _assertCallbackBlocked() private view {
        require(callbackToken.attempts() == 1, "collateral callback was not attempted exactly once");
        require(!callbackToken.callbackSucceeded(), "reentrant call unexpectedly succeeded");
        require(
            keccak256(callbackToken.callbackResult())
                == keccak256(abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)),
            "callback failed for a reason other than the reentrancy guard"
        );
    }

    function _deployAndFund(TestCollateral token, address authority) private {
        collateral = token;
        market = new ComputeMarket(_config(address(token), authority));
        token.mint(ALICE, 10_000_000);
        token.mint(address(token), 3_000_000);
        vm.startPrank(ALICE);
        token.approve(address(market), 3_000_000);
        market.mintPairs(PAIR);
        vm.stopPrank();
        vm.startPrank(address(token));
        token.approve(address(market), 3_000_000);
        market.mintPairs(PAIR);
        vm.stopPrank();
    }

    function _config(address token, address authority) private pure returns (ComputeMarket.Config memory) {
        return ComputeMarket.Config({
            collateral: token,
            settlementAuthority: authority,
            indexId: keccak256("DEMO-GPU-USD-PER-HOUR-V1"),
            specHash: keccak256("demo-spec-v1"),
            priceDecimals: 2,
            lower: 100,
            upper: 300,
            periodStart: 2_000,
            periodEnd: 3_000,
            maxReportAge: 100,
            fallbackDelay: 1_000
        });
    }

    function _report(uint256 price) private view returns (ComputeMarket.Report memory) {
        return ComputeMarket.Report({
            market: address(market),
            chainId: block.chainid,
            indexId: market.indexId(),
            specHash: market.specHash(),
            priceDecimals: market.priceDecimals(),
            periodStart: market.periodStart(),
            periodEnd: market.periodEnd(),
            price: price,
            publishedAt: uint64(block.timestamp),
            evidenceHash: keccak256("adversarial report")
        });
    }

    function _assertInitialPosition() private view {
        _assertBacking(2_000_000, 2_000_000, 2_000_000);
        _assertClaims(ALICE, PAIR, PAIR);
        _assertClaims(address(collateral), PAIR, PAIR);
        require(collateral.balanceOf(ALICE) == 9_000_000, "rollback changed holder collateral");
        require(collateral.balanceOf(BOB) == 0, "rollback left collateral at recipient");
        require(collateral.balanceOf(address(collateral)) == 2_000_000, "rollback changed attacker collateral");
        require(collateral.totalSupply() == 13_000_000, "rollback changed collateral supply");
        require(collateral.allowance(ALICE, address(market)) == 2_000_000, "rollback consumed holder allowance");
        require(
            collateral.allowance(address(collateral), address(market)) == 2_000_000,
            "rollback changed attacker allowance"
        );
    }

    function _assertBacking(uint256 vault, uint256 longSupply, uint256 shortSupply) private view {
        require(collateral.balanceOf(address(market)) == vault, "vault collateral mismatch");
        require(market.collateralLocked() == vault, "locked collateral mismatch");
        require(market.longClaim().totalSupply() == longSupply, "long supply mismatch");
        require(market.shortClaim().totalSupply() == shortSupply, "short supply mismatch");
    }

    function _assertClaims(address holder, uint256 longBalance, uint256 shortBalance) private view {
        require(market.longClaim().balanceOf(holder) == longBalance, "holder long balance mismatch");
        require(market.shortClaim().balanceOf(holder) == shortBalance, "holder short balance mismatch");
    }

    function _assertUnsettled() private view {
        require(!market.settled(), "unauthorized call settled market");
        require(market.settlementPrice() == 0, "unsettled price changed");
        require(market.reportPublishedAt() == 0, "unsettled publication time changed");
        require(market.settlementEvidenceHash() == bytes32(0), "unsettled evidence changed");
    }
}
