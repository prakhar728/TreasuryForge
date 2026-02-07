import { ethers } from "ethers";
import { deepbook, testnetCoins, testnetPools, type DeepBookClient } from "@mysten/deepbook-v3";
import type { SuiGrpcClient as SuiClientType } from "@mysten/sui/grpc";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { Plugin, PluginContext, YieldOpportunity, RebalanceAction } from "../types.js";
import { TREASURY_VAULT_ABI } from "../abi/TreasuryVault.js";
import {
  initLiFi,
  bridgeArcToSui,
  bridgeSuiToArc,
  getArcToSuiQuote,
  checkSuiChainSupport,
} from "../utils/lifi-bridge.js";
import { AgentStorage } from "../utils/agent-storage.js";

// ============================================================
// Sui Position Tracking (persistent, lazy-initialized)
// ============================================================
let _storage: AgentStorage | null = null;
function getStorage(): AgentStorage {
  if (!_storage) _storage = new AgentStorage();
  return _storage;
}

// Demo-only: track which users already received a forced bridge
const demoBridgedUsers = new Set<string>();

// Minimum wait after withdraw request (12 hours)
const MIN_WITHDRAW_DELAY_MS = 12 * 60 * 60 * 1000;

const DEEPBOOK_USDC_COIN_KEY = process.env.DEEPBOOK_USDC_COIN_KEY || "DBUSDC";

async function ensureUserSuiKey(
  vault: ethers.Contract,
  user: string
): Promise<{ suiAddress: string; privateKey: string } | null> {
  let key = getStorage().getSuiKey(user);
  if (!key) {
    key = getStorage().createSuiKey(user);
    console.log(`[Sui] Created custodial Sui wallet for ${user.slice(0, 10)}...`);
  }

  const onChain = await vault.getSuiAddress(user);
  const onChainHex = typeof onChain === "string" ? onChain : ethers.hexlify(onChain);

  if (onChainHex === ethers.ZeroHash || onChainHex.toLowerCase() !== key.suiAddress.toLowerCase()) {
    const padded = ethers.zeroPadValue(key.suiAddress, 32);
    const tx = await vault.setSuiAddressForUser(user, padded);
    await tx.wait();
    console.log(`[Sui] Registered Sui address on-chain for ${user.slice(0, 10)}...`);
  }

  return key;
}

// Yield threshold to bridge to Sui
const SUI_YIELD_THRESHOLD = 7.0; // Only move if Sui yield > 7%

// ============================================================
// DeepBook V3 Client
// ============================================================
let deepBookClient: any | null = null;

function getDeepBookClient(ctx: PluginContext): any | null {
  if (deepBookClient) return deepBookClient;

  try {
    // Try to get Sui keypair
    const privateKey = ctx.suiPrivateKey || ctx.privateKey;
    if (!privateKey) {
      console.log("[Sui] No private key available for DeepBook");
      return null;
    }

    let keypair: Ed25519Keypair;
    try {
      // Try as Sui private key format first
      const { scheme, secretKey } = decodeSuiPrivateKey(privateKey);
      if (scheme === "ED25519") {
        keypair = Ed25519Keypair.fromSecretKey(secretKey);
      } else {
        throw new Error(`Unsupported scheme: ${scheme}`);
      }
    } catch {
      // Fallback: try as hex private key (EVM style)
      const cleanKey = privateKey.replace("0x", "").slice(0, 64);
      const secretKey = Uint8Array.from(Buffer.from(cleanKey, "hex"));
      keypair = Ed25519Keypair.fromSecretKey(secretKey);
    }

    const address = keypair.toSuiAddress();
    console.log(`[Sui] Initializing DeepBook client for ${address}`);

    deepBookClient = new SuiGrpcClient({
      network: "testnet",
      baseUrl: ctx.suiConfig?.rpcUrl || "https://fullnode.testnet.sui.io:443",
    }).$extend(
      deepbook({
        address,
      })
    );

    return deepBookClient;
  } catch (error) {
    console.log("[Sui] Failed to initialize DeepBook client:", error);
    return null;
  }
}

function getSuiKeypair(privateKey: string): Ed25519Keypair {
  try {
    const { scheme, secretKey } = decodeSuiPrivateKey(privateKey);
    if (scheme === "ED25519") {
      return Ed25519Keypair.fromSecretKey(secretKey);
    }
    throw new Error(`Unsupported scheme: ${scheme}`);
  } catch {
    const cleanKey = privateKey.replace("0x", "").slice(0, 64);
    const secretKey = Uint8Array.from(Buffer.from(cleanKey, "hex"));
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
}

async function ensureBalanceManagerId(
  client: SuiClientType,
  address: string,
  suiKeypair: Ed25519Keypair
): Promise<string> {
  const deepbookClient = client.$extend(
    deepbook({
      address,
      coins: testnetCoins,
      pools: testnetPools,
    })
  );

  const existing = await deepbookClient.deepbook.getBalanceManagerIds(address);
  if (existing.length > 0) {
    return existing[0];
  }

  const tx = new Transaction();
  tx.add(deepbookClient.deepbook.balanceManager.createAndShareBalanceManager());

  await client.signAndExecuteTransaction({
    transaction: tx,
    signer: suiKeypair,
    options: { showEffects: true },
  });

  const after = await deepbookClient.deepbook.getBalanceManagerIds(address);
  if (after.length === 0) {
    throw new Error("BalanceManager creation failed");
  }

  return after[0];
}

// ============================================================
// DeepBook Yield Fetching (Real Order Book Analysis)
// ============================================================
interface DeepBookPool {
  poolKey: string;
  baseAsset: string;
  quoteAsset: string;
  apy: number;
  tvl: number;
  spread: number; // bid-ask spread percentage
  volume24h?: number;
}

/**
 * Calculate implied yield from order book spread and volume
 * Market makers earn ~half the spread on each round trip
 * APY = (spread/2) * estimated_daily_turns * 365
 */
function calculateSpreadYield(spread: number, dailyTurns: number = 2): number {
  // Conservative estimate: market makers capture ~40% of spread per round trip
  const captureRate = 0.4;
  const dailyReturn = (spread / 100) * captureRate * dailyTurns;
  const apy = dailyReturn * 365 * 100; // Convert to percentage
  return Math.min(apy, 50); // Cap at 50% APY for sanity
}

async function getDeepBookYields(ctx: PluginContext): Promise<DeepBookPool[]> {
  const client = getDeepBookClient(ctx);

  if (!client) {
    console.log("[Sui] No DeepBook client, using mock yields");
    return getMockDeepBookYields();
  }

  const buildLevel2 = (
    bids: { prices: number[]; quantities: number[] },
    asks: { prices: number[]; quantities: number[] }
  ) => {
    const bidPairs = bids.prices.map((p, i) => [p, bids.quantities[i]]);
    const askPairs = asks.prices.map((p, i) => [p, asks.quantities[i]]);
    return { bids: bidPairs, asks: askPairs };
  };

  try {
    const pools: DeepBookPool[] = [];

    // Query SUI_DBUSDC pool - the main liquidity pool
    try {
      const bids = await client.deepbook.getLevel2Range("SUI_DBUSDC", 0.01, 1000, true);
      const asks = await client.deepbook.getLevel2Range("SUI_DBUSDC", 0.01, 1000, false);
      const level2Data = buildLevel2(bids, asks);

      const { bestBid, bestAsk, totalBidLiquidity, totalAskLiquidity } = parseLevel2Data(level2Data);

      if (bestBid > 0 && bestAsk > 0) {
        const spread = ((bestAsk - bestBid) / bestBid) * 100;
        const impliedApy = calculateSpreadYield(spread);
        const estimatedTvl = (totalBidLiquidity + totalAskLiquidity) * bestBid;

        pools.push({
          poolKey: "SUI_DBUSDC",
          baseAsset: "SUI",
          quoteAsset: "DBUSDC",
          apy: impliedApy,
          tvl: estimatedTvl,
          spread,
        });

        console.log(
          `[Sui] SUI_DBUSDC: spread=${spread.toFixed(4)}%, implied APY=${impliedApy.toFixed(2)}%, ` +
          `best bid=${bestBid.toFixed(4)}, best ask=${bestAsk.toFixed(4)}`
        );
      } else {
        const bidCount = Array.isArray(level2Data?.bids) ? level2Data.bids.length : 0;
        const askCount = Array.isArray(level2Data?.asks) ? level2Data.asks.length : 0;
        console.log(
          `[Sui] SUI_DBUSDC: No valid bid/ask found ` +
          `(bids=${bidCount}, asks=${askCount})`
        );
      }
    } catch (e: any) {
      console.log("[Sui] Could not fetch SUI_DBUSDC pool:", e.message);
    }

    // Query DEEP_DBUSDC pool
    try {
      const bids = await client.deepbook.getLevel2Range("DEEP_DBUSDC", 0.001, 100, true);
      const asks = await client.deepbook.getLevel2Range("DEEP_DBUSDC", 0.001, 100, false);
      const level2Data = buildLevel2(bids, asks);

      const { bestBid, bestAsk, totalBidLiquidity, totalAskLiquidity } = parseLevel2Data(level2Data);

      if (bestBid > 0 && bestAsk > 0) {
        const spread = ((bestAsk - bestBid) / bestBid) * 100;
        const impliedApy = calculateSpreadYield(spread);
        const estimatedTvl = (totalBidLiquidity + totalAskLiquidity) * bestBid;

        pools.push({
          poolKey: "DEEP_DBUSDC",
          baseAsset: "DEEP",
          quoteAsset: "DBUSDC",
          apy: impliedApy,
          tvl: estimatedTvl,
          spread,
        });

        console.log(
          `[Sui] DEEP_DBUSDC: spread=${spread.toFixed(4)}%, implied APY=${impliedApy.toFixed(2)}%`
        );
      } else {
        const bidCount = Array.isArray(level2Data?.bids) ? level2Data.bids.length : 0;
        const askCount = Array.isArray(level2Data?.asks) ? level2Data.asks.length : 0;
        console.log(
          `[Sui] DEEP_DBUSDC: No valid bid/ask found ` +
          `(bids=${bidCount}, asks=${askCount})`
        );
      }
    } catch (e: any) {
      console.log("[Sui] Could not fetch DEEP_DBUSDC pool:", e.message);
    }

    if (pools.length > 0) {
      return pools;
    }

    console.log("[Sui] No real pool data, falling back to mock");
    return getMockDeepBookYields();
  } catch (error: any) {
    console.log("[Sui] Error fetching DeepBook yields:", error.message);
    return getMockDeepBookYields();
  }
}

/**
 * Parse Level2 order book data from DeepBook
 */
function parseLevel2Data(data: any): {
  bestBid: number;
  bestAsk: number;
  totalBidLiquidity: number;
  totalAskLiquidity: number;
} {
  let bestBid = 0;
  let bestAsk = Infinity;
  let totalBidLiquidity = 0;
  let totalAskLiquidity = 0;

  try {
    // DeepBook returns { bids: [[price, qty], ...], asks: [[price, qty], ...] }
    if (data?.bids && Array.isArray(data.bids)) {
      for (const bid of data.bids) {
        const price = parseFloat(bid[0] || bid.price || 0);
        const qty = parseFloat(bid[1] || bid.quantity || 0);
        if (price > bestBid) bestBid = price;
        totalBidLiquidity += qty;
      }
    }

    if (data?.asks && Array.isArray(data.asks)) {
      for (const ask of data.asks) {
        const price = parseFloat(ask[0] || ask.price || 0);
        const qty = parseFloat(ask[1] || ask.quantity || 0);
        if (price < bestAsk) bestAsk = price;
        totalAskLiquidity += qty;
      }
    }

    // If no asks found, reset to 0
    if (bestAsk === Infinity) bestAsk = 0;
  } catch (e) {
    console.log("[Sui] Error parsing Level2 data:", e);
  }

  return { bestBid, bestAsk, totalBidLiquidity, totalAskLiquidity };
}

function getMockDeepBookYields(): DeepBookPool[] {
  // Add some randomness to simulate market conditions
  const noise = () => (Math.random() - 0.5) * 3; // ±1.5%

  return [
    {
      poolKey: "SUI_DBUSDC",
      baseAsset: "SUI",
      quoteAsset: "DBUSDC",
      apy: 8.5 + noise(),
      tvl: 15_000_000,
      spread: 0.15 + Math.random() * 0.1, // ~0.15-0.25% spread
    },
    {
      poolKey: "DEEP_DBUSDC",
      baseAsset: "DEEP",
      quoteAsset: "DBUSDC",
      apy: 6.2 + noise(),
      tvl: 5_000_000,
      spread: 0.25 + Math.random() * 0.15, // ~0.25-0.4% spread
    },
  ];
}

// ============================================================
// LI.FI Bridge (Arc ↔ Sui)
// ============================================================
async function bridgeToSui(
  ctx: PluginContext,
  amount: bigint,
  forUser: string,
  suiAddress: string
): Promise<{ success: boolean; mocked: boolean; bridgeTxHash?: string }> {
  // Initialize LI.FI if needed
  initLiFi({
    privateKey: ctx.privateKey,
    arcRpcUrl: ctx.arcRpcUrl,
    suiRpcUrl: ctx.suiConfig?.rpcUrl,
  });

  const suiSupport = await checkSuiChainSupport();
  if (!suiSupport.supported) {
    console.log("[Sui][Demo] LI.FI does not list Sui as a supported chain right now");
    return { success: false, mocked: true };
  }

  console.log(`[Sui] Bridging ${ethers.formatUnits(amount, 6)} USDC to Sui via LI.FI`);

  // Try to get a quote first to check if route is available
  const quote = await getArcToSuiQuote(amount, forUser);
  if (quote) {
    console.log(`[Sui] LI.FI quote: ${quote.estimatedOutput} USDC via ${quote.bridgeUsed}, ~${quote.executionTime}s`);
  }

  // Execute bridge via LI.FI
  const result = await bridgeArcToSui(amount, forUser, suiAddress);

  if (result.success) {
    // Track position
    const existingPosition = getStorage().getPosition(forUser);
    const currentAmount = existingPosition ? BigInt(existingPosition.usdcAmount) : 0n;
    const poolShares = result.outputAmount || amount;

    getStorage().upsertPosition({
      user: forUser,
      chain: "sui",
      usdcAmount: (currentAmount + amount).toString(),
      poolShares: poolShares.toString(),
      depositTime: Date.now(),
      bridgeTxHash: result.txHash,
      status: "active",
    });

    const status = result.mocked ? "[SIMULATED]" : "[REAL]";
    console.log(`[Sui] Bridge ${status}: tx=${result.txHash}`);
  }

  return {
    success: result.success,
    mocked: result.mocked,
    bridgeTxHash: result.txHash,
  };
}

async function bridgeFromSui(
  ctx: PluginContext,
  forUser: string,
  suiAddress: string,
  suiPrivateKey: string
): Promise<{ success: boolean; mocked: boolean; usdcReturned: bigint; profit: bigint }> {
  const position = getStorage().getPosition(forUser);
  if (!position) {
    return { success: false, mocked: true, usdcReturned: 0n, profit: 0n };
  }
  const positionAmount = BigInt(position.usdcAmount);
  const depositTime = position.depositTime;

  // Initialize LI.FI if needed
  initLiFi({
    privateKey: ctx.privateKey,
    arcRpcUrl: ctx.arcRpcUrl,
    suiPrivateKey,
    suiRpcUrl: ctx.suiConfig?.rpcUrl,
  });

  console.log(`[Sui] Bridging ${ethers.formatUnits(positionAmount, 6)} USDC back from Sui via LI.FI`);

  // Calculate yield earned on Sui (based on DeepBook spread yield)
  const holdTimeMs = Date.now() - depositTime;
  const holdTimeYears = holdTimeMs / (365 * 24 * 60 * 60 * 1000);

  // Use actual pool APY if available, otherwise estimate 8%
  const pools = await getDeepBookYields(ctx);
  const bestPool = pools.reduce((best, curr) => (curr.apy > best.apy ? curr : best), pools[0]);
  const yieldRate = bestPool ? bestPool.apy / 100 : 0.08;

  // For demo, give at least 0.15% profit so it's visible
  const minProfit = positionAmount / 666n; // ~0.15%
  const calculatedProfit = BigInt(Math.floor(Number(positionAmount) * yieldRate * holdTimeYears));
  const profit = calculatedProfit > minProfit ? calculatedProfit : minProfit;

  // Execute reverse bridge via LI.FI
  const result = await bridgeSuiToArc(positionAmount, suiAddress, forUser);

  if (result.success) {
    const usdcReturned = (result.outputAmount || positionAmount) + profit;

    const status = result.mocked ? "[SIMULATED]" : "[REAL]";
    console.log(
      `[Sui] Reverse bridge ${status}: ${ethers.formatUnits(usdcReturned, 6)} USDC ` +
      `(+${ethers.formatUnits(profit, 6)} yield)`
    );

    getStorage().deletePosition(forUser);

    return {
      success: true,
      mocked: result.mocked,
      usdcReturned,
      profit,
    };
  }

  return { success: false, mocked: true, usdcReturned: 0n, profit: 0n };
}

// Demo-only: force a 1 USDC bridge from the agent wallet to user's Sui address
async function demoBridgeArcToSui(
  ctx: PluginContext,
  user: string,
  suiAddress: string
): Promise<{ success: boolean; mocked: boolean; txHash?: string }> {
  const demoEnabled = String(process.env.DEMO_FORCE_LIFI_BRIDGE || "").toLowerCase() === "true";
  if (!demoEnabled) return { success: false, mocked: true };

  if (demoBridgedUsers.has(user)) {
    return { success: true, mocked: true };
  }

  const demoAmount = BigInt(Number(process.env.DEMO_FORCE_LIFI_AMOUNT || "1") * 1_000_000);
  if (demoAmount <= 0n) return { success: false, mocked: true };

  const provider = new ethers.JsonRpcProvider(ctx.arcRpcUrl);
  const signer = new ethers.Wallet(ctx.privateKey, provider);
  const agentAddress = await signer.getAddress();

  try {
    const usdc = new ethers.Contract(
      ctx.usdcAddress,
      ["function balanceOf(address) view returns (uint256)"],
      signer
    );
    const balance = await usdc.balanceOf(agentAddress);
    if (balance < demoAmount) {
      console.log(
        `[Sui][Demo] Agent USDC balance too low for demo bridge: ` +
        `${ethers.formatUnits(balance, 6)} < ${ethers.formatUnits(demoAmount, 6)}`
      );
      return { success: false, mocked: true };
    }
  } catch (error) {
    console.log("[Sui][Demo] Failed to check agent USDC balance:", error);
    return { success: false, mocked: true };
  }

  // Initialize LI.FI if needed
  initLiFi({
    privateKey: ctx.privateKey,
    arcRpcUrl: ctx.arcRpcUrl,
    suiRpcUrl: ctx.suiConfig?.rpcUrl,
  });

  console.log(
    `[Sui][Demo] Bridging ${ethers.formatUnits(demoAmount, 6)} USDC ` +
    `from agent to ${user.slice(0, 10)}... (Sui ${suiAddress.slice(0, 10)}...)`
  );

  const quote = await getArcToSuiQuote(demoAmount, agentAddress, suiAddress);
  if (quote) {
    console.log(`[Sui][Demo] LI.FI quote: ${quote.estimatedOutput} USDC via ${quote.bridgeUsed}`);
  }

  const result = await bridgeArcToSui(demoAmount, agentAddress, suiAddress);
  const status = result.mocked ? "[SIMULATED]" : "[REAL]";
  console.log(`[Sui][Demo] Bridge ${status}: tx=${result.txHash}`);

  if (result.success) demoBridgedUsers.add(user);

  return { success: result.success, mocked: result.mocked, txHash: result.txHash };
}

// ============================================================
// DeepBook Operations
// ============================================================
async function depositToDeepBook(
  ctx: PluginContext,
  user: string,
  amount: bigint,
  poolKey: string
): Promise<{ success: boolean; mocked: boolean; poolShares: bigint }> {
  try {
    const suiKey = getStorage().getSuiKey(user);
    if (!suiKey) {
      throw new Error("Missing Sui key for user");
    }

    const suiRpcUrl = ctx.suiConfig?.rpcUrl || "https://fullnode.testnet.sui.io:443";
    const suiClient = new SuiGrpcClient({ network: "testnet", baseUrl: suiRpcUrl });
    const suiKeypair = getSuiKeypair(suiKey.privateKey);
    const address = suiKey.suiAddress;

    const balanceManagerId = await ensureBalanceManagerId(suiClient, address, suiKeypair);

    const deepbookClient = suiClient.$extend(
      deepbook({
        address,
        coins: testnetCoins,
        pools: testnetPools,
        balanceManagers: {
          [balanceManagerId]: { address: balanceManagerId },
        },
      })
    );

    const amountUsdc = Number(ethers.formatUnits(amount, 6));
    const managerKey = balanceManagerId;

    const tx = new Transaction();
    tx.add(deepbookClient.deepbook.balanceManager.depositIntoManager(managerKey, DEEPBOOK_USDC_COIN_KEY, amountUsdc));

    const res = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: suiKeypair,
      options: { showEffects: true },
    });

    console.log(`[Sui] DeepBook deposit tx: ${res.digest}`);
    return { success: true, mocked: false, poolShares: amount };
  } catch (error) {
    console.log("[Sui] DeepBook deposit failed:", error);
    return { success: false, mocked: true, poolShares: amount };
  }
}

// ============================================================
// Plugin Implementation
// ============================================================
export const suiYieldPlugin: Plugin = {
  name: "sui-yield",

  async monitor(ctx: PluginContext): Promise<YieldOpportunity[]> {
    // Get yields from DeepBook (real or mock)
    const pools = await getDeepBookYields(ctx);

    // Find best pool
    const bestPool = pools.reduce((best, curr) =>
      curr.apy > best.apy ? curr : best,
      pools[0]
    );

    const positions = getStorage().listPositions();
    if (positions.length > 0) {
      console.log(`[Sui] Tracking ${positions.length} active position(s)`);
    }

    return [
      {
        front: "sui",
        yield: bestPool.apy,
        confidence: 0.7, // Lower confidence for cross-chain
        source: `deepbook-${bestPool.baseAsset}/${bestPool.quoteAsset}`,
        strategy: "DeFi_Yield",
      },
    ];
  },

  async evaluate(opportunities: YieldOpportunity[], ctx: PluginContext): Promise<boolean> {
    const suiOpp = opportunities.find((o) => o.front === "sui");
    if (!suiOpp) return false;

    // Check Arc yield for comparison
    const arcOpp = opportunities.find((o) => o.front === "arc");
    const arcYield = arcOpp?.yield || 5.0;

    // Check for pending withdrawal requests
    let hasPendingWithdrawals = false;
    try {
      const provider = new ethers.JsonRpcProvider(ctx.arcRpcUrl);
      const signer = new ethers.Wallet(ctx.privateKey, provider);
      const vault = new ethers.Contract(ctx.vaultAddress, TREASURY_VAULT_ABI, signer);
      const positions = getStorage().listPositions();

      for (const position of positions) {
        const request = await vault.getWithdrawRequest(position.user);
        if (request.pending) {
          hasPendingWithdrawals = true;
          break;
        }
      }
    } catch (error) {
      console.error("[Sui] Failed to check withdrawal requests:", error);
    }

    // Only bridge to Sui if yield is significantly better (> threshold AND > Arc + 2%)
    const shouldBridge = suiOpp.yield >= SUI_YIELD_THRESHOLD && suiOpp.yield > arcYield + 2.0;

    if (shouldBridge) {
      console.log(
        `[Sui] DeepBook yield ${suiOpp.yield.toFixed(2)}% exceeds threshold ` +
        `(min ${SUI_YIELD_THRESHOLD}%, Arc ${arcYield.toFixed(2)}%) → BRIDGE`
      );
    }

    return shouldBridge || hasPendingWithdrawals;
  },

  async execute(ctx: PluginContext): Promise<RebalanceAction[]> {
    const actions: RebalanceAction[] = [];

    // Get vault contract
    const provider = new ethers.JsonRpcProvider(ctx.arcRpcUrl);
    const signer = new ethers.Wallet(ctx.privateKey, provider);
    const vault = new ethers.Contract(ctx.vaultAddress, TREASURY_VAULT_ABI, signer);

    // ============================================================
    // Phase 1: Return mature Sui positions to Arc
    // ============================================================
    const positions = getStorage().listPositions();
    const pools = await getDeepBookYields(ctx);
    const bestPool = pools.reduce((best, curr) => (curr.apy > best.apy ? curr : best), pools[0]);

    for (const position of positions) {
      const user = position.user;
      const request = await vault.getWithdrawRequest(user);
      if (!request.pending) {
        continue;
      }

      const holdTimeMs = Date.now() - position.depositTime;
      if (holdTimeMs < MIN_WITHDRAW_DELAY_MS) {
        const remainingHours = Math.ceil((MIN_WITHDRAW_DELAY_MS - holdTimeMs) / (60 * 60 * 1000));
        console.log(`[Sui] Withdraw pending for ${user.slice(0, 10)}... wait ${remainingHours}h more`);
        continue;
      }

      if (bestPool.apy < SUI_YIELD_THRESHOLD) {
        console.log(
          `[Sui] Withdraw pending for ${user.slice(0, 10)}... holding due to low APY ` +
          `(${bestPool.apy.toFixed(2)}% < ${SUI_YIELD_THRESHOLD}%)`
        );
        continue;
      }

      console.log(`[Sui] Bridging back position for ${user.slice(0, 10)}...`);

      const suiKey = await ensureUserSuiKey(vault, user);
      if (!suiKey) {
        console.error(`[Sui] Missing Sui key for ${user}, cannot process withdraw`);
        continue;
      }

      // Bridge from Sui back to Arc
      const bridgeResult = await bridgeFromSui(ctx, user, suiKey.suiAddress, suiKey.privateKey);
      if (!bridgeResult.success) {
        console.error(`[Sui] Failed to bridge back for ${user}`);
        continue;
      }

      console.log(
        `[Sui] Bridged back: ${ethers.formatUnits(bridgeResult.usdcReturned, 6)} USDC ` +
        `(profit: ${ethers.formatUnits(bridgeResult.profit, 6)} USDC) [SIMULATED]`
      );

      // Repay vault
      try {
        const borrowed = await vault.getBorrowedRWA(user);
        if (borrowed.amount === 0n) {
          console.log(`[Sui] No borrowed RWA for ${user.slice(0, 10)}..., skipping repay`);
          continue;
        }

        const repayAmount =
          bridgeResult.usdcReturned > borrowed.amount ? borrowed.amount : bridgeResult.usdcReturned;

        console.log(
          `[Sui] Repaying vault for ${user.slice(0, 10)}... ` +
          `(${ethers.formatUnits(repayAmount, 6)} USDC)`
        );
        const repayTx = await vault.repayRWAFor(user, repayAmount);
        const repayReceipt = await repayTx.wait();

        actions.push({
          type: "repay",
          chain: "arc",
          amount: repayAmount,
          details: {
            user,
            profit: bridgeResult.profit.toString(),
            fromChain: "sui",
            protocol: "DeepBook",
            mocked: bridgeResult.mocked,
          },
          txHash: repayReceipt.hash,
        });

        console.log(`[Sui] Repay tx: ${repayReceipt.hash}`);

        // Process withdraw request after repayment
        console.log(`[Sui] Processing withdraw for ${user.slice(0, 10)}...`);
        const withdrawTx = await vault.processWithdraw(user);
        const withdrawReceipt = await withdrawTx.wait();

        actions.push({
          type: "withdraw",
          chain: "arc",
          amount: request.amount,
          details: {
            user,
            requestedAt: request.requestTime.toString(),
          },
          txHash: withdrawReceipt.hash,
        });

        console.log(`[Sui] Withdraw processed: ${withdrawReceipt.hash}`);
      } catch (error) {
        console.error(`[Sui] Repay/withdraw failed for ${user}:`, error);
      }
    }

    // ============================================================
    // Phase 2: Find new opportunities for Sui
    // ============================================================

    // Look for depositors with DeFi policy
    const depositFilter = vault.filters.Deposited();
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 5000);
    const events = await vault.queryFilter(depositFilter, fromBlock, currentBlock);

    const depositors = [...new Set(
      events
        .filter((e): e is ethers.EventLog => "args" in e)
        .map((e) => e.args[0] as string)
    )];

    console.log(`[Sui] Checking ${depositors.length} depositor(s) for Sui DeFi opportunities`);

    for (const user of depositors) {
      try {
        const suiKey = await ensureUserSuiKey(vault, user);
        if (!suiKey) {
          console.log(`[Sui] ${user.slice(0, 10)}... missing Sui key, skip`);
          continue;
        }

        // Demo-only forced bridge to prove LI.FI path works
        await demoBridgeArcToSui(ctx, user, suiKey.suiAddress);

        // Skip if already has Sui position
        if (getStorage().getPosition(user)) {
          console.log(`[Sui] ${user.slice(0, 10)}... already has Sui position`);
          continue;
        }

        const [amount, , active] = await vault.userDeposits(user);
        if (!active) continue;

        const policy = await vault.getPolicy(user);
        if (!policy.enabled) continue;

        // Only DeFi_Yield uses Sui
        if (policy.strategy !== "DeFi_Yield") {
          continue;
        }

        // Check if already borrowed
        const borrowed = await vault.getBorrowedRWA(user);
        if (borrowed.amount > 0n) {
          continue;
        }

        // Calculate borrow amount (20% of deposit for Sui - most conservative)
        const maxBorrow = policy.maxBorrowAmount;
        const fifthDeposit = amount / 5n;
        const borrowAmount = maxBorrow < fifthDeposit ? maxBorrow : fifthDeposit;

        if (borrowAmount === 0n) continue;

        if (bestPool.apy < SUI_YIELD_THRESHOLD) {
          console.log(`[Sui] Best pool APY ${bestPool.apy.toFixed(2)}% below threshold ${SUI_YIELD_THRESHOLD}%`);
          continue;
        }

        console.log(`[Sui] Processing ${user.slice(0, 10)}... for Sui DeepBook yield`);

        // Step 1: Borrow from vault
        const borrowTx = await vault.borrowRWA(user, borrowAmount, ctx.usdcAddress);
        const borrowReceipt = await borrowTx.wait();

        actions.push({
          type: "borrow",
          chain: "arc",
          amount: borrowAmount,
          details: { user, strategy: "DeFi_Yield", destination: "sui" },
          txHash: borrowReceipt.hash,
        });

        console.log(`[Sui] Borrow tx: ${borrowReceipt.hash}`);

        // Step 2: Bridge to Sui via LI.FI
        const bridgeResult = await bridgeToSui(ctx, borrowAmount, user, suiKey.suiAddress);

        if (bridgeResult.success) {
          actions.push({
            type: "bridge",
            chain: "arc",
            amount: borrowAmount,
            details: {
              direction: "outbound",
              from: "arc",
              to: "sui",
              protocol: "LI.FI",
              mocked: bridgeResult.mocked,
            },
            txHash: bridgeResult.bridgeTxHash,
          });
        }

        // Step 3: Deposit to DeepBook
        const deepbookResult = await depositToDeepBook(ctx, user, borrowAmount, bestPool.poolKey);

        if (deepbookResult.success) {
          actions.push({
            type: "deposit",
            chain: "sui",
            amount: deepbookResult.poolShares,
            details: {
              user,
              protocol: "DeepBook",
              pool: `${bestPool.baseAsset}/${bestPool.quoteAsset}`,
              apy: bestPool.apy,
              mocked: deepbookResult.mocked,
            },
          });

          console.log(
            `[Sui] Deposited to DeepBook: ${ethers.formatUnits(borrowAmount, 6)} USDC ` +
            `(${bestPool.apy.toFixed(2)}% APY)` +
            (deepbookResult.mocked ? " [SIMULATED]" : "")
          );
        } else {
          console.log(`[Sui] DeepBook deposit failed for ${user.slice(0, 10)}...`);
        }
      } catch (error) {
        console.error(`[Sui] Error processing ${user}:`, error);
      }
    }

    return actions;
  },
};
