import { ethers } from "ethers";
import axios from "axios";
import { Plugin, PluginContext, YieldOpportunity, RebalanceAction } from "../types.js";
import { TREASURY_VAULT_ABI } from "../abi/TreasuryVault.js";
import { USYC_TOKEN_ABI, USYC_TELLER_ABI, USYC_ENTITLEMENTS_ABI } from "../abi/USYC.js";

// ============================================================
// State tracking for USYC positions (in-memory for MVP)
// In production, this would be persisted to a database
// ============================================================
interface USYCPosition {
  user: string;
  usycShares: bigint;
  usdcDeposited: bigint;
  depositTime: number;
}

const usycPositions: Map<string, USYCPosition> = new Map();

// Minimum time to hold USYC before redeeming (demo: 2 minutes)
const MIN_HOLD_TIME_MS = 2 * 60 * 1000;

// ============================================================
// Stork Oracle
// ============================================================
let cachedYield: { value: number; timestamp: number } | null = null;
const CACHE_TTL = 60_000;

async function fetchStorkYield(apiKey: string): Promise<number> {
  if (cachedYield && Date.now() - cachedYield.timestamp < CACHE_TTL) {
    console.log("[Stork] Using cached yield:", cachedYield.value);
    return cachedYield.value;
  }

  if (!apiKey || apiKey === "your_stork_api_key_here") {
    console.log("[Stork] No API key — using mock yield (6.5%)");
    const mockYield = 6.5;
    cachedYield = { value: mockYield, timestamp: Date.now() };
    return mockYield;
  }

  try {
    const res = await axios.get("https://rest.jp.stork-oracle.network/v1/prices/latest", {
      headers: { Authorization: `Basic ${apiKey}` },
      params: { assets: "USDCUSD" },
    });

    const price = res.data?.data?.USDCUSD?.price ?? 1.0;
    const impliedYield = Math.abs(1.0 - price) * 100 + 5.0;

    cachedYield = { value: impliedYield, timestamp: Date.now() };
    console.log("[Stork] Fetched yield:", impliedYield);
    return impliedYield;
  } catch (error) {
    console.error("[Stork] API error, using fallback:", error);
    return cachedYield?.value ?? 6.5;
  }
}

// ============================================================
// Contract Helpers
// ============================================================
function getContracts(ctx: PluginContext) {
  const provider = new ethers.JsonRpcProvider(ctx.arcRpcUrl);
  const signer = new ethers.Wallet(ctx.privateKey, provider);

  const vault = new ethers.Contract(ctx.vaultAddress, TREASURY_VAULT_ABI, signer);
  const usyc = new ethers.Contract(ctx.usycAddress, USYC_TOKEN_ABI, signer);
  const usycTeller = new ethers.Contract(ctx.usycTellerAddress, USYC_TELLER_ABI, signer);
  const usycEntitlements = new ethers.Contract(ctx.usycEntitlementsAddress, USYC_ENTITLEMENTS_ABI, signer);

  return { provider, signer, vault, usyc, usycTeller, usycEntitlements };
}

async function checkUSYCAllowlisted(ctx: PluginContext, address: string): Promise<boolean> {
  try {
    const { usycEntitlements } = getContracts(ctx);
    const isAllowed = await usycEntitlements.isAllowed(address);
    return isAllowed;
  } catch (error) {
    console.log("[USYC] Could not check entitlements, assuming not allowlisted");
    return false;
  }
}

// ============================================================
// USYC Operations
// ============================================================
async function depositToUSYC(
  ctx: PluginContext,
  amount: bigint,
  forUser: string
): Promise<{ success: boolean; shares: bigint; txHash?: string; mocked?: boolean }> {
  const { signer, usycTeller } = getContracts(ctx);
  const agentAddress = await signer.getAddress();

  // Check if agent is allowlisted for USYC
  const isAllowlisted = await checkUSYCAllowlisted(ctx, agentAddress);

  if (!isAllowlisted) {
    // Mock the USYC deposit for demo purposes
    console.log("[USYC] Agent not allowlisted — simulating USYC deposit");
    const mockShares = amount; // 1:1 for simplicity in mock

    usycPositions.set(forUser, {
      user: forUser,
      usycShares: mockShares,
      usdcDeposited: amount,
      depositTime: Date.now(),
    });

    return { success: true, shares: mockShares, mocked: true };
  }

  try {
    // Real USYC deposit
    console.log(`[USYC] Depositing ${ethers.formatUnits(amount, 6)} USDC to USYC Teller`);

    // First approve USDC spending by Teller
    const usdc = new ethers.Contract(
      ctx.usdcAddress,
      ["function approve(address spender, uint256 amount) returns (bool)"],
      signer
    );
    const approveTx = await usdc.approve(ctx.usycTellerAddress, amount);
    await approveTx.wait();

    // Deposit to get USYC shares
    const depositTx = await usycTeller.deposit(amount, agentAddress);
    const receipt = await depositTx.wait();

    // Get shares received (from events or query balance diff)
    const { usyc } = getContracts(ctx);
    const shares = await usyc.balanceOf(agentAddress);

    usycPositions.set(forUser, {
      user: forUser,
      usycShares: shares,
      usdcDeposited: amount,
      depositTime: Date.now(),
    });

    console.log(`[USYC] Received ${ethers.formatUnits(shares, 6)} USYC shares`);
    return { success: true, shares, txHash: receipt.hash };
  } catch (error) {
    console.error("[USYC] Deposit failed:", error);
    return { success: false, shares: 0n };
  }
}

async function redeemFromUSYC(
  ctx: PluginContext,
  forUser: string
): Promise<{ success: boolean; usdcReturned: bigint; profit: bigint; txHash?: string; mocked?: boolean }> {
  const position = usycPositions.get(forUser);
  if (!position) {
    return { success: false, usdcReturned: 0n, profit: 0n };
  }

  const { signer, usycTeller, usyc } = getContracts(ctx);
  const agentAddress = await signer.getAddress();

  const isAllowlisted = await checkUSYCAllowlisted(ctx, agentAddress);

  if (!isAllowlisted || position.usycShares === 0n) {
    // Mock the USYC redemption
    console.log("[USYC] Simulating USYC redemption with yield");

    // Simulate ~5% APY prorated to hold time
    const holdTimeMs = Date.now() - position.depositTime;
    const holdTimeYears = holdTimeMs / (365 * 24 * 60 * 60 * 1000);
    const yieldRate = 0.05; // 5% APY

    // For demo, give at least 0.1% profit so it's visible
    const minProfit = position.usdcDeposited / 1000n; // 0.1%
    const calculatedProfit = BigInt(Math.floor(Number(position.usdcDeposited) * yieldRate * holdTimeYears));
    const profit = calculatedProfit > minProfit ? calculatedProfit : minProfit;

    const usdcReturned = position.usdcDeposited + profit;

    usycPositions.delete(forUser);

    return { success: true, usdcReturned, profit, mocked: true };
  }

  try {
    // Real USYC redemption
    console.log(`[USYC] Redeeming ${ethers.formatUnits(position.usycShares, 6)} USYC shares`);

    // Approve USYC spending by Teller (if needed)
    const approveTx = await usyc.approve(ctx.usycTellerAddress, position.usycShares);
    await approveTx.wait();

    // Redeem USYC for USDC
    const redeemTx = await usycTeller.redeem(position.usycShares, agentAddress, agentAddress);
    const receipt = await redeemTx.wait();

    // Calculate profit
    const usdcReturned = await usycTeller.previewRedeem(position.usycShares);
    const profit = usdcReturned - position.usdcDeposited;

    usycPositions.delete(forUser);

    console.log(`[USYC] Redeemed ${ethers.formatUnits(usdcReturned, 6)} USDC (profit: ${ethers.formatUnits(profit, 6)})`);
    return { success: true, usdcReturned, profit, txHash: receipt.hash };
  } catch (error) {
    console.error("[USYC] Redemption failed:", error);
    return { success: false, usdcReturned: 0n, profit: 0n };
  }
}

// ============================================================
// Plugin Implementation
// ============================================================
export const arcRebalancePlugin: Plugin = {
  name: "arc-rebalance",

  async monitor(ctx: PluginContext): Promise<YieldOpportunity[]> {
    const currentYield = await fetchStorkYield(ctx.storkApiKey);

    // Also check for positions ready to be redeemed
    const readyToRedeem = Array.from(usycPositions.values()).filter(
      (p) => Date.now() - p.depositTime >= MIN_HOLD_TIME_MS
    );
    if (readyToRedeem.length > 0) {
      console.log(`[Arc] ${readyToRedeem.length} position(s) ready for redemption`);
    }

    return [
      {
        front: "arc",
        yield: currentYield,
        confidence: ctx.storkApiKey && ctx.storkApiKey !== "your_stork_api_key_here" ? 0.95 : 0.5,
        source: "stork",
      },
    ];
  },

  async evaluate(opportunities: YieldOpportunity[], ctx: PluginContext): Promise<boolean> {
    const { vault } = getContracts(ctx);

    const [tvl, totalBorrows] = await vault.getVaultStats();
    console.log(`[Arc] Vault TVL: ${ethers.formatUnits(tvl, 6)} USDC, Borrows: ${ethers.formatUnits(totalBorrows, 6)}`);

    const arcOpp = opportunities.find((o) => o.front === "arc");
    if (!arcOpp) return false;

    const yieldThresholdBps = 500;
    const thresholdPct = yieldThresholdBps / 100;

    // Check if there are positions to redeem
    const hasRedeemablePositions = Array.from(usycPositions.values()).some(
      (p) => Date.now() - p.depositTime >= MIN_HOLD_TIME_MS
    );

    const shouldAct = arcOpp.yield >= thresholdPct || hasRedeemablePositions;
    console.log(
      `[Arc] Yield ${arcOpp.yield.toFixed(2)}% vs threshold ${thresholdPct}% → ${shouldAct ? "REBALANCE" : "HOLD"}` +
      (hasRedeemablePositions ? " (has redeemable positions)" : "")
    );

    return shouldAct;
  },

  async execute(ctx: PluginContext): Promise<RebalanceAction[]> {
    const { vault, signer } = getContracts(ctx);
    const actions: RebalanceAction[] = [];

    // ============================================================
    // Phase 1: Redeem mature USYC positions and repay vault
    // ============================================================
    for (const [user, position] of usycPositions.entries()) {
      if (Date.now() - position.depositTime < MIN_HOLD_TIME_MS) {
        const remainingSecs = Math.ceil((MIN_HOLD_TIME_MS - (Date.now() - position.depositTime)) / 1000);
        console.log(`[Arc] Position for ${user.slice(0, 10)}... needs ${remainingSecs}s more to mature`);
        continue;
      }

      console.log(`[Arc] Redeeming USYC position for ${user.slice(0, 10)}...`);

      // Redeem USYC
      const redeemResult = await redeemFromUSYC(ctx, user);
      if (!redeemResult.success) {
        console.error(`[Arc] Failed to redeem USYC for ${user}`);
        continue;
      }

      console.log(
        `[Arc] Redeemed: ${ethers.formatUnits(redeemResult.usdcReturned, 6)} USDC ` +
        `(profit: ${ethers.formatUnits(redeemResult.profit, 6)} USDC)` +
        (redeemResult.mocked ? " [SIMULATED]" : "")
      );

      // Repay vault
      try {
        console.log(`[Arc] Repaying vault for ${user.slice(0, 10)}...`);
        const repayTx = await vault.repayRWA(redeemResult.usdcReturned);
        const repayReceipt = await repayTx.wait();

        actions.push({
          type: "repay",
          chain: "arc",
          amount: redeemResult.usdcReturned,
          details: {
            user,
            profit: redeemResult.profit.toString(),
            mocked: redeemResult.mocked,
          },
          txHash: repayReceipt.hash,
        });

        console.log(`[Arc] Repay tx: ${repayReceipt.hash}`);
      } catch (error) {
        console.error(`[Arc] Repay failed for ${user}:`, error);
      }
    }

    // ============================================================
    // Phase 2: Process new borrows for eligible depositors
    // ============================================================
    const depositFilter = vault.filters.Deposited();
    const provider = signer.provider!;
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 5000);
    const events = await vault.queryFilter(depositFilter, fromBlock, currentBlock);

    const depositors = [...new Set(
      events
        .filter((e): e is ethers.EventLog => "args" in e)
        .map((e) => e.args[0] as string)
    )];
    console.log(`[Arc] Found ${depositors.length} depositor(s)`);

    for (const user of depositors) {
      try {
        // Skip if already has a USYC position being managed
        if (usycPositions.has(user)) {
          console.log(`[Arc] ${user.slice(0, 10)}... already has active USYC position`);
          continue;
        }

        const [amount, , active] = await vault.userDeposits(user);
        if (!active) continue;

        const policy = await vault.getPolicy(user);
        if (!policy.enabled) {
          console.log(`[Arc] ${user.slice(0, 10)}... policy not enabled`);
          continue;
        }

        const borrowed = await vault.getBorrowedRWA(user);
        if (borrowed.amount > 0n) {
          console.log(`[Arc] ${user.slice(0, 10)}... already has vault borrow`);
          continue;
        }

        // Calculate borrow amount
        const maxBorrow = policy.maxBorrowAmount;
        const halfDeposit = amount / 2n;
        const borrowAmount = maxBorrow < halfDeposit ? maxBorrow : halfDeposit;

        if (borrowAmount === 0n) continue;

        console.log(`[Arc] Processing ${user.slice(0, 10)}... for ${ethers.formatUnits(borrowAmount, 6)} USDC`);

        // Step 1: Borrow from vault
        const borrowTx = await vault.borrowRWA(user, borrowAmount, ctx.usdcAddress);
        const borrowReceipt = await borrowTx.wait();
        console.log(`[Arc] Borrow tx: ${borrowReceipt.hash}`);

        actions.push({
          type: "borrow",
          chain: "arc",
          amount: borrowAmount,
          details: { user, strategy: policy.strategy },
          txHash: borrowReceipt.hash,
        });

        // Step 2: Deposit borrowed USDC to USYC (RWA yield)
        const usycResult = await depositToUSYC(ctx, borrowAmount, user);
        if (usycResult.success) {
          console.log(
            `[Arc] Deposited to USYC: ${ethers.formatUnits(usycResult.shares, 6)} shares` +
            (usycResult.mocked ? " [SIMULATED]" : "")
          );

          actions.push({
            type: "deposit",
            chain: "arc",
            amount: usycResult.shares,
            details: {
              user,
              asset: "USYC",
              mocked: usycResult.mocked,
            },
            txHash: usycResult.txHash,
          });
        }
      } catch (error) {
        console.error(`[Arc] Error processing ${user}:`, error);
      }
    }

    return actions;
  },
};
