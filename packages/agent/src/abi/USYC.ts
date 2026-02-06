// USYC Token and Teller ABIs for Arc testnet
// USYC is a tokenized money market fund (RWA) backed by US Treasuries

export const USYC_TOKEN_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  // USYC specific - share price for yield calculation
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
];

export const USYC_TELLER_ABI = [
  // Deposit USDC to get USYC
  "function deposit(uint256 assets, address receiver) returns (uint256 shares)",
  // Redeem USYC to get USDC back
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  // Preview functions
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  // Check if address is allowed (entitlements)
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
];

export const USYC_ENTITLEMENTS_ABI = [
  "function isAllowed(address account) view returns (bool)",
];

// Contract addresses on Arc testnet
export const USYC_ADDRESSES = {
  token: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
  teller: "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
  entitlements: "0xcc205224862c7641930c87679e98999d23c26113",
};
