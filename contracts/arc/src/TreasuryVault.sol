// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title TreasuryVault
 * @notice Arc-based RWA-backed treasury vault with policy-driven rebalancing
 * @dev Stores USDC, manages deposits/withdrawals, and tracks treasury policies
 */
contract TreasuryVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================================================
    // State Variables
    // ============================================================================

    IERC20 public usdc;
    address public agent;

    // Total deposit tracking
    uint256 public totalDeposited;

    // Policy struct: yield threshold, borrowing limit, strategy
    struct Policy {
        uint256 yieldThreshold; // in basis points (e.g., 500 = 5%)
        uint256 maxBorrowAmount;
        bool enabled;
        string strategy; // "DeFi_Yield", "RWA_Loan", "Stablecoin_Carry"
    }

    // User deposit tracking
    struct UserDeposit {
        uint256 amount;
        uint256 timestamp;
        bool active;
    }

    mapping(address => UserDeposit) public userDeposits;
    mapping(address => Policy) public userPolicies;

    // Borrowed RWA tracking
    struct BorrowedRWA {
        uint256 amount;
        uint256 borrowTime;
        address rwaToken;
    }

    mapping(address => BorrowedRWA) public borrowedRWAs;
    uint256 public totalBorrowed;

    // Event logging
    event Deposited(address indexed user, uint256 amount, uint256 timestamp);
    event Withdrawn(address indexed user, uint256 amount, uint256 timestamp);
    event PolicySet(address indexed user, uint256 yieldThreshold, uint256 maxBorrow, string strategy);
    event RWABorrowed(address indexed user, uint256 amount, address rwaToken);
    event RWARepaid(address indexed user, uint256 amount);
    event AgentUpdated(address indexed newAgent);
    event Rebalanced(address indexed user, uint256 amount, string action);

    // ============================================================================
    // Constructor & Initialization
    // ============================================================================

    constructor(address _usdc, address _agent) Ownable(msg.sender) {
        require(_usdc != address(0), "Invalid USDC address");
        usdc = IERC20(_usdc);
        agent = _agent;
    }

    // ============================================================================
    // User Deposit/Withdrawal
    // ============================================================================

    /**
     * @notice Deposit USDC to the vault
     * @param amount Amount of USDC to deposit
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "Deposit amount must be > 0");
        require(usdc.balanceOf(msg.sender) >= amount, "Insufficient USDC balance");

        // Transfer USDC from user to vault
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Update user deposit record
        UserDeposit storage userDeposit = userDeposits[msg.sender];
        userDeposit.amount += amount;
        userDeposit.timestamp = block.timestamp;
        userDeposit.active = true;

        totalDeposited += amount;

        emit Deposited(msg.sender, amount, block.timestamp);
    }

    /**
     * @notice Withdraw USDC from the vault
     * @param amount Amount of USDC to withdraw
     */
    function withdraw(uint256 amount) external nonReentrant {
        UserDeposit storage userDeposit = userDeposits[msg.sender];
        require(userDeposit.active, "No active deposit");
        require(userDeposit.amount >= amount, "Insufficient balance to withdraw");

        // Repay borrowed RWA if any
        if (borrowedRWAs[msg.sender].amount > 0) {
            require(false, "Cannot withdraw while RWA borrowed - repay first");
        }

        userDeposit.amount -= amount;
        totalDeposited -= amount;

        if (userDeposit.amount == 0) {
            userDeposit.active = false;
        }

        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, block.timestamp);
    }

    /**
     * @notice Check user's USDC balance in the vault
     */
    function balanceOf(address user) external view returns (uint256) {
        return userDeposits[user].amount;
    }

    // ============================================================================
    // Policy Management
    // ============================================================================

    /**
     * @notice Set yield policy for user
     * @param yieldThreshold Minimum yield required (basis points)
     * @param maxBorrowAmount Max RWA to borrow
     * @param strategy Strategy name
     */
    function setPolicy(
        uint256 yieldThreshold,
        uint256 maxBorrowAmount,
        string calldata strategy
    ) external {
        require(userDeposits[msg.sender].active, "No active deposit");
        require(yieldThreshold > 0, "Yield threshold must be > 0");

        userPolicies[msg.sender] = Policy({
            yieldThreshold: yieldThreshold,
            maxBorrowAmount: maxBorrowAmount,
            enabled: true,
            strategy: strategy
        });

        emit PolicySet(msg.sender, yieldThreshold, maxBorrowAmount, strategy);
    }

    /**
     * @notice Get user's policy
     */
    function getPolicy(address user) external view returns (Policy memory) {
        return userPolicies[user];
    }

    // ============================================================================
    // RWA Borrowing (Agent-Controlled)
    // ============================================================================

    /**
     * @notice Borrow RWA tokens (only by agent)
     * @param user User address
     * @param amount Amount of RWA to borrow
     * @param rwaToken RWA token address
     */
    function borrowRWA(address user, uint256 amount, address rwaToken) external {
        require(msg.sender == agent, "Only agent can borrow");
        require(userDeposits[user].active, "User has no active deposit");

        Policy memory policy = userPolicies[user];
        require(policy.enabled, "User policy disabled");
        require(amount <= policy.maxBorrowAmount, "Borrow exceeds policy limit");
        require(borrowedRWAs[user].amount == 0, "User already has borrowed RWA");

        borrowedRWAs[user] = BorrowedRWA({
            amount: amount,
            borrowTime: block.timestamp,
            rwaToken: rwaToken
        });

        totalBorrowed += amount;

        emit RWABorrowed(user, amount, rwaToken);
    }

    /**
     * @notice Repay borrowed RWA
     * @param amount Amount to repay
     */
    function repayRWA(uint256 amount) external {
        BorrowedRWA storage borrowedRWA = borrowedRWAs[msg.sender];
        require(borrowedRWA.amount > 0, "No borrowed RWA");
        require(amount <= borrowedRWA.amount, "Repay amount exceeds borrowed");

        borrowedRWA.amount -= amount;
        totalBorrowed -= amount;

        if (borrowedRWA.amount == 0) {
            borrowedRWA.rwaToken = address(0);
            borrowedRWA.borrowTime = 0;
        }

        emit RWARepaid(msg.sender, amount);
    }

    /**
     * @notice Get borrowed RWA info
     */
    function getBorrowedRWA(address user) external view returns (BorrowedRWA memory) {
        return borrowedRWAs[user];
    }

    // ============================================================================
    // Agent & Admin Functions
    // ============================================================================

    /**
     * @notice Update agent address
     */
    function setAgent(address _agent) external onlyOwner {
        require(_agent != address(0), "Invalid agent address");
        agent = _agent;
        emit AgentUpdated(_agent);
    }

    /**
     * @notice Get vault statistics
     */
    function getVaultStats() external view returns (
        uint256 tvl,
        uint256 totalBorrows,
        uint256 numUsers
    ) {
        return (
            usdc.balanceOf(address(this)),
            totalBorrowed,
            0 // Note: tracking num users would require additional storage
        );
    }

    // ============================================================================
    // Emergency Functions
    // ============================================================================

    /**
     * @notice Emergency withdrawal (owner only)
     */
    function emergencyWithdraw() external onlyOwner {
        uint256 balance = usdc.balanceOf(address(this));
        usdc.safeTransfer(owner(), balance);
    }
}
