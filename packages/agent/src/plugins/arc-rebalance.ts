import { ethers } from "ethers";
import axios from "axios";
import { Plugin, PluginContext, YieldOpportunity, RebalanceAction } from "../types.js";
import { TREASURY_VAULT_ABI } from "../abi/TreasuryVault.js";

// Cache for Stork oracle responses
let cachedYield: { value: number; timestamp: number } | null = null;
const CACHE_TTL = 60_000; // 1 minute

async function fetchStorkYield(apiKey: string): Promise<number> {
  // Return cache if fresh
  if (cachedYield && Date.now() - cachedYield.timestamp < CACHE_TTL) {
    console.log("[Stork] Using cached yield:", cachedYield.value);
    return cachedYield.value;
  }

  if (!apiKey || apiKey === "your_stork_api_key_here") {
    // Mock fallback when no API key
    console.log("[Stork] No API key — using mock yield (6.5%)");
    const mockYield = 6.5;
    cachedYield = { value: mockYield, timestamp: Date.now() };
    return mockYield;
  }

  try {
    // Stork REST API for price feeds
    const res = await axios.get("https://rest.jp.stork-oracle.network/v1/prices/latest", {
      headers: { Authorization: `Basic ${apiKey}` },
      params: { assets: "USDCUSD" },
    });

    const price = res.data?.data?.USDCUSD?.price ?? 1.0;
    // Derive implied yield from price deviation (simplified model)
    // In production, you'd query specific yield feed IDs
    const impliedYield = Math.abs(1.0 - price) * 100 + 5.0;

    cachedYield = { value: impliedYield, timestamp: Date.now() };
    console.log("[Stork] Fetched yield:", impliedYield);
    return impliedYield;
  } catch (error) {
    console.error("[Stork] API error, using fallback:", error);
    // Fallback to cached or mock
    return cachedYield?.value ?? 6.5;
  }
}

function getVaultContract(ctx: PluginContext): {
  vault: ethers.Contract;
  signer: ethers.Wallet;
} {
  const provider = new ethers.JsonRpcProvider(ctx.arcRpcUrl);
  const signer = new ethers.Wallet(ctx.privateKey, provider);
  const vault = new ethers.Contract(ctx.vaultAddress, TREASURY_VAULT_ABI, signer);
  return { vault, signer };
}

export const arcRebalancePlugin: Plugin = {
  name: "arc-rebalance",

  async monitor(ctx: PluginContext): Promise<YieldOpportunity[]> {
    const currentYield = await fetchStorkYield(ctx.storkApiKey);

    return [
      {
        front: "arc",
        yield: currentYield,
        confidence: ctx.storkApiKey ? 0.95 : 0.5, // lower confidence for mock
        source: "stork",
      },
    ];
  },

  async evaluate(opportunities: YieldOpportunity[], ctx: PluginContext): Promise<boolean> {
    const { vault } = getVaultContract(ctx);

    // Get vault stats
    const [tvl, totalBorrows] = await vault.getVaultStats();
    console.log(`[Arc] Vault TVL: ${ethers.formatUnits(tvl, 6)} USDC, Borrows: ${ethers.formatUnits(totalBorrows, 6)}`);

    const arcOpp = opportunities.find((o) => o.front === "arc");
    if (!arcOpp) return false;

    // Simple threshold check — is yield above minimum?
    const yieldThresholdBps = 500; // 5% default, will read from user policies
    const thresholdPct = yieldThresholdBps / 100;

    const shouldAct = arcOpp.yield >= thresholdPct;
    console.log(
      `[Arc] Yield ${arcOpp.yield.toFixed(2)}% vs threshold ${thresholdPct}% → ${shouldAct ? "REBALANCE" : "HOLD"}`
    );

    return shouldAct;
  },

  async execute(ctx: PluginContext): Promise<RebalanceAction[]> {
    const { vault, signer } = getVaultContract(ctx);
    const actions: RebalanceAction[] = [];
    const agentAddress = await signer.getAddress();

    // Check who has active deposits + policies
    // For MVP, we check the agent's own knowledge of depositors via events
    const depositFilter = vault.filters.Deposited();

    // Arc RPC limits eth_getLogs to 10,000 block range
    // Query last 5000 blocks to be safe
    const provider = signer.provider!;
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 5000);
    const events = await vault.queryFilter(depositFilter, fromBlock, currentBlock);

    // Deduplicate depositors
    const depositors = [...new Set(
      events
        .filter((e): e is ethers.EventLog => "args" in e)
        .map((e) => e.args[0] as string)
    )];
    console.log(`[Arc] Found ${depositors.length} depositor(s)`);

    for (const user of depositors) {
      try {
        console.log(`[Arc] Checking depositor: ${user}`);

        // Check if user has active deposit
        const [amount, , active] = await vault.userDeposits(user);
        console.log(`[Arc]   Deposit: ${ethers.formatUnits(amount, 6)} USDC, active: ${active}`);
        if (!active) {
          console.log(`[Arc]   Skipping: deposit not active`);
          continue;
        }

        // Check user's policy
        const policy = await vault.getPolicy(user);
        console.log(`[Arc]   Policy: enabled=${policy.enabled}, threshold=${policy.yieldThreshold}, maxBorrow=${ethers.formatUnits(policy.maxBorrowAmount, 6)}`);
        if (!policy.enabled) {
          console.log(`[Arc]   Skipping: policy not enabled (set policy in frontend)`);
          continue;
        }

        // Check if already borrowed
        const borrowed = await vault.getBorrowedRWA(user);
        console.log(`[Arc]   Borrowed: ${ethers.formatUnits(borrowed.amount, 6)} USDC`);
        if (borrowed.amount > 0n) {
          console.log(`[Arc]   Skipping: already has active borrow`);
          continue;
        }

        // Calculate borrow amount (up to maxBorrowAmount or 50% of deposit)
        const maxBorrow = policy.maxBorrowAmount;
        const halfDeposit = amount / 2n;
        const borrowAmount = maxBorrow < halfDeposit ? maxBorrow : halfDeposit;
        console.log(`[Arc]   Calculated borrow: ${ethers.formatUnits(borrowAmount, 6)} USDC`);

        if (borrowAmount === 0n) {
          console.log(`[Arc]   Skipping: borrow amount is 0`);
          continue;
        }

        console.log(
          `[Arc] Borrowing ${ethers.formatUnits(borrowAmount, 6)} USDC for user ${user}`
        );

        // Execute borrow (agent-gated on-chain)
        const tx = await vault.borrowRWA(user, borrowAmount, ctx.usdcAddress);
        const receipt = await tx.wait();

        actions.push({
          type: "borrow",
          chain: "arc",
          amount: borrowAmount,
          details: { user, rwaToken: ctx.usdcAddress, strategy: policy.strategy },
          txHash: receipt.hash,
        });

        console.log(`[Arc] Borrow tx: ${receipt.hash}`);
      } catch (error) {
        console.error(`[Arc] Error processing user ${user}:`, error);
      }
    }

    return actions;
  },
};
