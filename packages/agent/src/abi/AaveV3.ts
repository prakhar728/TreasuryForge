export const AAVE_V3_POOL_ABI = [
  // Supply assets to Aave V3
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external",
  // Withdraw assets from Aave V3
  "function withdraw(address asset, uint256 amount, address to) external returns (uint256)",
];

export const AAVE_V3_DATA_PROVIDER_ABI = [
  // Reserve data for an asset (liquidityRate is in ray: 1e27)
  "function getReserveData(address asset) external view returns (uint256 unbacked,uint256 accruedToTreasuryScaled,uint256 totalAToken,uint256 totalStableDebt,uint256 totalVariableDebt,uint256 liquidityRate,uint256 variableBorrowRate,uint256 stableBorrowRate,uint256 averageStableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex,uint40 lastUpdateTimestamp)",
];
