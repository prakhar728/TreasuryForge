export const TREASURY_VAULT_ABI = [
  // User functions
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount) external",
  "function balanceOf(address user) external view returns (uint256)",
  "function setPolicy(uint256 yieldThreshold, uint256 maxBorrowAmount, string calldata strategy) external",
  "function getPolicy(address user) external view returns (tuple(uint256 yieldThreshold, uint256 maxBorrowAmount, bool enabled, string strategy))",
  "function repayRWA(uint256 amount) external",
  "function getBorrowedRWA(address user) external view returns (tuple(uint256 amount, uint256 borrowTime, address rwaToken))",

  // Agent functions
  "function borrowRWA(address user, uint256 amount, address rwaToken) external",

  // Admin functions
  "function setAgent(address _agent) external",
  "function emergencyWithdraw() external",

  // View functions
  "function getVaultStats() external view returns (uint256 tvl, uint256 totalBorrows, uint256 numUsers)",
  "function usdc() external view returns (address)",
  "function agent() external view returns (address)",
  "function totalDeposited() external view returns (uint256)",
  "function totalBorrowed() external view returns (uint256)",
  "function userDeposits(address) external view returns (uint256 amount, uint256 timestamp, bool active)",

  // Events
  "event Deposited(address indexed user, uint256 amount, uint256 timestamp)",
  "event Withdrawn(address indexed user, uint256 amount, uint256 timestamp)",
  "event PolicySet(address indexed user, uint256 yieldThreshold, uint256 maxBorrow, string strategy)",
  "event RWABorrowed(address indexed user, uint256 amount, address rwaToken)",
  "event RWARepaid(address indexed user, uint256 amount)",
  "event AgentUpdated(address indexed newAgent)",
  "event Rebalanced(address indexed user, uint256 amount, string action)",
] as const;
