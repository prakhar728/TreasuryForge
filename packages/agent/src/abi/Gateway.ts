// Circle Gateway ABIs
// https://developers.circle.com/circle-research/docs/gateway-unified-balance

export const GATEWAY_WALLET_ABI = [
  // Deposit USDC to burn it and add to unified balance
  "function deposit(address token, uint256 value) external",
  // Events
  "event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain)",
];

export const GATEWAY_MINTER_ABI = [
  // Mint USDC from unified balance
  "function gatewayMint(bytes attestationPayload, bytes signature) external",
  // Check available unified balance
  "function unifiedBalance(address account) external view returns (uint256)",
  // Events
  "event Mint(address indexed recipient, uint256 amount)",
];

export const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

// Chain domain IDs for Circle CCTP
export const CHAIN_DOMAINS: Record<string, number> = {
  "arc": 26,         // Arc testnet domain
  "ethereum": 0,     // Ethereum Sepolia
  "base": 6,         // Base Sepolia
  "avalanche": 1,    // Avalanche Fuji
};
