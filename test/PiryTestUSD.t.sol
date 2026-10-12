// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {PiryTestUSD} from "../contracts/PiryTestUSD.sol";
import {VmExt} from "./VmExt.sol";

contract PiryTestUSDTest {
    VmExt internal constant vm = VmExt(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant ALICE = address(0xA11CE);
    PiryTestUSD internal usd;

    function setUp() public {
        usd = new PiryTestUSD();
    }

    function testHasSixDecimalsAndNoInitialSupply() public view {
        require(usd.decimals() == 6 && usd.totalSupply() == 0 && usd.deployer() == address(this));
    }

    function testOnlyDeployerMints() public {
        usd.mint(ALICE, 5_000_000);
        require(usd.balanceOf(ALICE) == 5_000_000);
        vm.prank(ALICE);
        vm.expectRevert(PiryTestUSD.OnlyDeployer.selector);
        usd.mint(ALICE, 1);
        require(usd.totalSupply() == 5_000_000);
    }

    function testHolderCanTransferFreely() public {
        usd.mint(ALICE, 10);
        vm.prank(ALICE);
        require(usd.transfer(address(this), 4));
        require(usd.balanceOf(address(this)) == 4);
    }
}
