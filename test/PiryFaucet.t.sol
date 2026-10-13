// SPDX-License-Identifier: MIT
pragma solidity 0.8.31;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PiryFaucet} from "../contracts/PiryFaucet.sol";
import {PiryTestUSD} from "../contracts/PiryTestUSD.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert() external;
}

contract PiryFaucetTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PiryTestUSD internal usd;
    PiryFaucet internal faucet;

    function setUp() public {
        usd = new PiryTestUSD();
        faucet = new PiryFaucet(IERC20(address(usd)), 100e6);
        usd.mint(address(faucet), 250e6);
    }

    function testDripsOncePerAddress() public {
        vm.prank(address(0xA1));
        faucet.drip();
        require(usd.balanceOf(address(0xA1)) == 100e6 && faucet.claimed(address(0xA1)));
        vm.prank(address(0xA1));
        vm.expectRevert(PiryFaucet.AlreadyClaimed.selector);
        faucet.drip();
    }

    function testRevertsWhenEmptyWithoutMarkingClaimed() public {
        vm.prank(address(0xA1));
        faucet.drip();
        vm.prank(address(0xA2));
        faucet.drip();
        vm.prank(address(0xA3));
        vm.expectRevert();
        faucet.drip();
        require(!faucet.claimed(address(0xA3)));
    }

    function testOnlyOwnerReclaims() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(PiryFaucet.OnlyOwner.selector);
        faucet.reclaim(address(0xBAD));
        faucet.reclaim(address(0xB0B));
        require(usd.balanceOf(address(0xB0B)) == 250e6 && usd.balanceOf(address(faucet)) == 0);
    }

    function testRejectsInvalidConfig() public {
        vm.expectRevert(PiryFaucet.InvalidConfig.selector);
        new PiryFaucet(IERC20(address(0x1234)), 100e6);
        vm.expectRevert(PiryFaucet.InvalidConfig.selector);
        new PiryFaucet(IERC20(address(usd)), 0);
    }
}
