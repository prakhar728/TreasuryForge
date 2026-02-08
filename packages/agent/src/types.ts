export interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  usdcAddress: string;
  gatewayWallet: string;
  gatewayMinter: string;
}

export interface SuiConfig {
  rpcUrl: string;
  address?: string; // Sui wallet address (derived from suiPrivateKey)
  usdcPackageId: string;
  usdcTreasuryId: string;
  deepbookPackageId: string;
  poolId: string; // USDC/SUI pool
}

export interface PluginContext {
  arcRpcUrl: string;
  vaultAddress: string;
  usdcAddress: string;
  baseVaultAddress: string;
  privateKey: string;
  storkApiKey: string;
  pollInterval: number;
  // USYC (RWA) addresses
  usycAddress: string;
  usycTellerAddress: string;
  usycEntitlementsAddress: string;
  // Circle Gateway (cross-chain)
  gatewayChains: ChainConfig[];
  // Sui integration
  suiConfig: SuiConfig;
  suiPrivateKey?: string; // Optional separate Sui key
}

export interface YieldOpportunity {
  front: string; // "arc", "sui", etc.
  yield: number; // percentage
  confidence: number; // 0-1
  source: string; // "stork", "deepbook", etc.
  strategy?: string; // "RWA_Loan", "DeFi_Yield", "Stablecoin_Carry"
}

export interface RebalanceAction {
  type: "borrow" | "bridge" | "deposit" | "order" | "withdraw" | "repay";
  chain: string;
  amount: bigint;
  details: Record<string, unknown>;
  txHash?: string;
}

export interface Plugin {
  name: string;
  /** Check yields and return opportunities for this front */
  monitor(ctx: PluginContext): Promise<YieldOpportunity[]>;
  /** Decide if we should act on the given opportunities */
  evaluate(opportunities: YieldOpportunity[], ctx: PluginContext): Promise<boolean>;
  /** Execute the rebalancing actions */
  execute(ctx: PluginContext): Promise<RebalanceAction[]>;
}
