export interface PluginContext {
  arcRpcUrl: string;
  vaultAddress: string;
  usdcAddress: string;
  privateKey: string;
  storkApiKey: string;
  pollInterval: number;
}

export interface YieldOpportunity {
  front: string; // "arc", "sui", etc.
  yield: number; // percentage
  confidence: number; // 0-1
  source: string; // "stork", "deepbook", etc.
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
