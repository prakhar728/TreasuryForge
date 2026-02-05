// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {TreasuryVault} from "../src/TreasuryVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/**
 * @title TreasuryVaultTest
 * @notice Tests for TreasuryVault deposit, withdrawal, and policy management
 * @dev Run: forge test
 */
contract TreasuryVaultTest is Test {
    TreasuryVault vault;
    MockERC20 usdc;

    address admin = address(0x1);
    address agent = address(0x2);
    address user1 = address(0x3);
    address user2 = address(0x4);

    uint256 INITIAL_USDC = 10000 * 1e6; // 10,000 USDC

    function setUp() public {
        // Deploy mock USDC
        usdc = new MockERC20("USDC", "USDC", 6);

        // Deploy vault
        vm.prank(admin);
        vault = new TreasuryVault(address(usdc), agent);

        // Mint USDC to test users
        usdc.mint(user1, INITIAL_USDC);
        usdc.mint(user2, INITIAL_USDC);
        usdc.mint(agent, INITIAL_USDC);
    }

    // ============================================================================
    // Deposit Tests
    // ============================================================================

    function testDeposit() public {
        uint256 depositAmount = 1000 * 1e6; // 1,000 USDC

        vm.startPrank(user1);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        vm.stopPrank();

        assertEq(vault.balanceOf(user1), depositAmount);
        assertEq(vault.totalDeposited(), depositAmount);
    }

    function testDepositMultiple() public {
        uint256 amount1 = 500 * 1e6;
        uint256 amount2 = 750 * 1e6;

        vm.startPrank(user1);
        usdc.approve(address(vault), INITIAL_USDC);
        vault.deposit(amount1);
        vault.deposit(amount2);
        vm.stopPrank();

        assertEq(vault.balanceOf(user1), amount1 + amount2);
        assertEq(vault.totalDeposited(), amount1 + amount2);
    }

    function testDepositFailsWithZeroAmount() public {
        vm.startPrank(user1);
        usdc.approve(address(vault), INITIAL_USDC);
        vm.expectRevert("Deposit amount must be > 0");
        vault.deposit(0);
        vm.stopPrank();
    }

    function testDepositFailsWithInsufficientBalance() public {
        uint256 excessiveAmount = INITIAL_USDC + 1e6;

        vm.startPrank(user1);
        usdc.approve(address(vault), excessiveAmount);
        vm.expectRevert("Insufficient USDC balance");
        vault.deposit(excessiveAmount);
        vm.stopPrank();
    }

    // ============================================================================
    // Withdrawal Tests
    // ============================================================================

    function testWithdraw() public {
        uint256 depositAmount = 1000 * 1e6;
        uint256 withdrawAmount = 500 * 1e6;

        vm.startPrank(user1);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        vault.withdraw(withdrawAmount);
        vm.stopPrank();

        assertEq(vault.balanceOf(user1), depositAmount - withdrawAmount);
        assertEq(vault.totalDeposited(), depositAmount - withdrawAmount);
    }

    function testWithdrawFailsWithoutDeposit() public {
        vm.startPrank(user1);
        vm.expectRevert("No active deposit");
        vault.withdraw(100 * 1e6);
        vm.stopPrank();
    }

    function testWithdrawAllDeactivatesDeposit() public {
        uint256 depositAmount = 1000 * 1e6;

        vm.startPrank(user1);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        vault.withdraw(depositAmount);
        vm.stopPrank();

        assertEq(vault.balanceOf(user1), 0);
        assertEq(vault.totalDeposited(), 0);
    }

    // ============================================================================
    // Policy Tests
    // ============================================================================

    function testSetPolicy() public {
        uint256 depositAmount = 1000 * 1e6;
        uint256 yieldThreshold = 500; // 5%
        uint256 maxBorrow = 500 * 1e6;

        vm.startPrank(user1);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        vault.setPolicy(yieldThreshold, maxBorrow, "DeFi_Yield");
        vm.stopPrank();

        TreasuryVault.Policy memory policy = vault.getPolicy(user1);
        assertEq(policy.yieldThreshold, yieldThreshold);
        assertEq(policy.maxBorrowAmount, maxBorrow);
        assertEq(policy.enabled, true);
    }

    function testSetPolicyFailsWithoutDeposit() public {
        vm.startPrank(user1);
        vm.expectRevert("No active deposit");
        vault.setPolicy(500, 500 * 1e6, "DeFi_Yield");
        vm.stopPrank();
    }

    // ============================================================================
    // RWA Borrowing Tests
    // ============================================================================

    function testBorrowRWA() public {
        uint256 depositAmount = 1000 * 1e6;
        uint256 borrowAmount = 250 * 1e6;

        // Setup user deposit and policy
        vm.startPrank(user1);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        vault.setPolicy(500, borrowAmount, "DeFi_Yield");
        vm.stopPrank();

        // Agent borrows RWA
        address mockRWA = address(0x99);
        vm.prank(agent);
        vault.borrowRWA(user1, borrowAmount, mockRWA);

        TreasuryVault.BorrowedRWA memory borrowed = vault.getBorrowedRWA(user1);
        assertEq(borrowed.amount, borrowAmount);
        assertEq(borrowed.rwaToken, mockRWA);
        assertEq(vault.totalBorrowed(), borrowAmount);
    }

    function testBorrowRWAFailsWithoutPermission() public {
        uint256 depositAmount = 1000 * 1e6;
        uint256 borrowAmount = 250 * 1e6;

        vm.startPrank(user1);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        vault.setPolicy(500, borrowAmount, "DeFi_Yield");
        vm.stopPrank();

        vm.startPrank(user2);
        vm.expectRevert("Only agent can borrow");
        vault.borrowRWA(user1, borrowAmount, address(0x99));
        vm.stopPrank();
    }

    function testRepayRWA() public {
        uint256 depositAmount = 1000 * 1e6;
        uint256 borrowAmount = 250 * 1e6;
        uint256 repayAmount = 100 * 1e6;

        // Setup and borrow
        vm.startPrank(user1);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        vault.setPolicy(500, borrowAmount, "DeFi_Yield");
        vm.stopPrank();

        vm.prank(agent);
        vault.borrowRWA(user1, borrowAmount, address(0x99));

        // Repay
        vm.prank(user1);
        vault.repayRWA(repayAmount);

        TreasuryVault.BorrowedRWA memory borrowed = vault.getBorrowedRWA(user1);
        assertEq(borrowed.amount, borrowAmount - repayAmount);
        assertEq(vault.totalBorrowed(), borrowAmount - repayAmount);
    }

    // ============================================================================
    // Agent & Admin Tests
    // ============================================================================

    function testSetAgent() public {
        address newAgent = address(0x5);
        vm.prank(admin);
        vault.setAgent(newAgent);

        assertEq(vault.agent(), newAgent);
    }

    function testGetVaultStats() public {
        uint256 depositAmount = 1000 * 1e6;

        vm.startPrank(user1);
        usdc.approve(address(vault), depositAmount);
        vault.deposit(depositAmount);
        vm.stopPrank();

        (uint256 tvl, uint256 totalBorrows, ) = vault.getVaultStats();
        assertEq(tvl, depositAmount);
        assertEq(totalBorrows, 0);
    }
}
