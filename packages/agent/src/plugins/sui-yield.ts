import { ethers } from "ethers";
import { deepbook, testnetCoins, testnetPools, mainnetCoins, mainnetPools } from "@mysten/deepbook-v3";
import type { SuiGrpcClient as SuiClientType } from "@mysten/sui/grpc";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { createRequire } from "module";
import { Plugin, PluginContext, YieldOpportunity, RebalanceAction } from "../types.js";
import { TREASURY_VAULT_ABI } from "../abi/TreasuryVault.js";
import { Wormhole, circle, routes } from "@wormhole-foundation/sdk";
import evmPlatform from "@wormhole-foundation/sdk/platforms/evm";
import suiPlatform from "@wormhole-foundation/sdk/platforms/sui";
import evm from "@wormhole-foundation/sdk/evm";
import "@wormhole-labs/cctp-executor-route";
import { cctpExecutorRoute } from "@wormhole-labs/cctp-executor-route";
import { registerProtocol, protocolIsRegistered } from "@wormhole-foundation/sdk-definitions";
import { _platform as evmPlatformCore } from "@wormhole-foundation/sdk-evm";
import { AgentStorage } from "../utils/agent-storage.js";

const require = createRequire(import.meta.url);

// ============================================================
// Sui Position Tracking (persistent, lazy-initialized)
// ============================================================
let _storage: AgentStorage | null = null;
function getStorage(): AgentStorage {
  if (!_storage) _storage = new AgentStorage();
  return _storage;
}

// Minimum wait after withdraw request (12 hours)
const MIN_WITHDRAW_DELAY_MS = 12 * 60 * 60 * 1000;

const WORMHOLE_NETWORK = (process.env.WORMHOLE_NETWORK || "Mainnet") as "Mainnet" | "Testnet";
const DEEPBOOK_USDC_COIN_KEY = process.env.DEEPBOOK_USDC_COIN_KEY || "DBUSDC";
const SUI_NETWORK = (process.env.SUI_NETWORK ||
  (WORMHOLE_NETWORK === "Mainnet" ? "mainnet" : "testnet")) as "mainnet" | "testnet";
const WORMHOLE_BASE_CHAIN = process.env.WORMHOLE_BASE_CHAIN || "Base";
const WORMHOLE_BASE_TO_SUI = String(process.env.WORMHOLE_BASE_TO_SUI || "true").toLowerCase() === "true";
let loggedSuiNetwork = false;

const BASE_MAINNET_RPC_URL = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
const BASE_MAINNET_USDC_ADDRESS =
  process.env.BASE_MAINNET_USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_MAINNET_TO_SUI_MAX_USDC = 100_000n; // 0.1 USDC (6 decimals)

const { EvmCCTPExecutor } = require("@wormhole-labs/cctp-executor-route/dist/cjs/evm/index.js") as {
  EvmCCTPExecutor: typeof import("@wormhole-labs/cctp-executor-route/dist/cjs/evm/executor.js").EvmCCTPExecutor;
};
if (!protocolIsRegistered(evmPlatformCore, "CCTPExecutor" as any)) {
  registerProtocol(evmPlatformCore, "CCTPExecutor" as any, EvmCCTPExecutor as any);
}

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

function getSuiNetworkConfig() {
  return SUI_NETWORK === "mainnet"
    ? { network: "mainnet" as const, coins: mainnetCoins, pools: mainnetPools }
    : { network: "testnet" as const, coins: testnetCoins, pools: testnetPools };
}

function getDefaultSuiRpcUrl() {
  return SUI_NETWORK === "mainnet"
    ? "https://fullnode.mainnet.sui.io:443"
    : "https://fullnode.testnet.sui.io:443";
}

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

    const { network, coins, pools } = getSuiNetworkConfig();
    deepBookClient = new SuiGrpcClient({
      network,
      baseUrl: ctx.suiConfig?.rpcUrl || getDefaultSuiRpcUrl(),
    }).$extend(
      deepbook({
        address,
        coins,
        pools,
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
  const { coins, pools } = getSuiNetworkConfig();
  const deepbookClient = client.$extend(
    deepbook({
      address,
      coins,
      pools,
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
  } as any);

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

function getPrimaryPoolKeys() {
  if (SUI_NETWORK === "mainnet") {
    return { primary: "SUI_USDC", secondary: "DEEP_USDC", quote: "USDC" };
  }
  return { primary: "SUI_DBUSDC", secondary: "DEEP_DBUSDC", quote: "DBUSDC" };
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

    const { primary, secondary, quote } = getPrimaryPoolKeys();

    // Query primary pool - main liquidity pool
    try {
      const bids = await client.deepbook.getLevel2Range(primary, 0.01, 1000, true);
      const asks = await client.deepbook.getLevel2Range(primary, 0.01, 1000, false);
      const level2Data = buildLevel2(bids, asks);

      const { bestBid, bestAsk, totalBidLiquidity, totalAskLiquidity } = parseLevel2Data(level2Data);

      if (bestBid > 0 && bestAsk > 0) {
        const spread = ((bestAsk - bestBid) / bestBid) * 100;
        const impliedApy = calculateSpreadYield(spread);
        const estimatedTvl = (totalBidLiquidity + totalAskLiquidity) * bestBid;

        pools.push({
          poolKey: primary,
          baseAsset: "SUI",
          quoteAsset: quote,
          apy: impliedApy,
          tvl: estimatedTvl,
          spread,
        });

        console.log(
          `[Sui] ${primary}: spread=${spread.toFixed(4)}%, implied APY=${impliedApy.toFixed(2)}%, ` +
          `best bid=${bestBid.toFixed(4)}, best ask=${bestAsk.toFixed(4)}`
        );
      } else {
        const bidCount = Array.isArray(level2Data?.bids) ? level2Data.bids.length : 0;
        const askCount = Array.isArray(level2Data?.asks) ? level2Data.asks.length : 0;
        console.log(
          `[Sui] ${primary}: No valid bid/ask found ` +
          `(bids=${bidCount}, asks=${askCount})`
        );
      }
    } catch (e: any) {
      console.log(`[Sui] Could not fetch ${primary} pool:`, e.message);
    }

    // Query secondary pool
    try {
      const bids = await client.deepbook.getLevel2Range(secondary, 0.001, 100, true);
      const asks = await client.deepbook.getLevel2Range(secondary, 0.001, 100, false);
      const level2Data = buildLevel2(bids, asks);

      const { bestBid, bestAsk, totalBidLiquidity, totalAskLiquidity } = parseLevel2Data(level2Data);

      if (bestBid > 0 && bestAsk > 0) {
        const spread = ((bestAsk - bestBid) / bestBid) * 100;
        const impliedApy = calculateSpreadYield(spread);
        const estimatedTvl = (totalBidLiquidity + totalAskLiquidity) * bestBid;

        pools.push({
          poolKey: secondary,
          baseAsset: "DEEP",
          quoteAsset: quote,
          apy: impliedApy,
          tvl: estimatedTvl,
          spread,
        });

        console.log(
          `[Sui] ${secondary}: spread=${spread.toFixed(4)}%, implied APY=${impliedApy.toFixed(2)}%`
        );
      } else {
        const bidCount = Array.isArray(level2Data?.bids) ? level2Data.bids.length : 0;
        const askCount = Array.isArray(level2Data?.asks) ? level2Data.asks.length : 0;
        console.log(
          `[Sui] ${secondary}: No valid bid/ask found ` +
          `(bids=${bidCount}, asks=${askCount})`
        );
      }
    } catch (e: any) {
      console.log(`[Sui] Could not fetch ${secondary} pool:`, e.message);
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
// Wormhole CCTP Bridge (Base → Sui)
// ============================================================
export type PendingBridgeStatus = {
  user: string;
  suiAddress: string;
  amount: bigint;
  startedAt: number;
  txHash?: string;
  poolKey: string;
  apy?: number;
};

const pendingBridges = new Map<string, PendingBridgeStatus>();

export function getPendingWormholeBridges(): PendingBridgeStatus[] {
  return Array.from(pendingBridges.values());
}

function getBasePrivateKey(ctx: PluginContext): string {
  return (
    process.env.BASE_PRIVATE_KEY ||
    process.env.EVM_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    ctx.privateKey ||
    ""
  );
}

async function getBaseSigner(chain: any, ctx: PluginContext) {
  const key = getBasePrivateKey(ctx);
  if (!key) throw new Error("Missing BASE_PRIVATE_KEY (or PRIVATE_KEY) for Base signer");
  const signer = await (await evm()).getSigner(await chain.getRpc(), key);
  return signer;
}

function getBaseChainConfig(ctx: PluginContext) {
  return ctx.gatewayChains?.find((c) => c.name === "base");
}

function getWormholeBaseRpcUrl(ctx: PluginContext): string {
  if (WORMHOLE_BASE_CHAIN.toLowerCase() === "base") {
    return BASE_MAINNET_RPC_URL;
  }
  const base = getBaseChainConfig(ctx);
  return base?.rpcUrl || "https://sepolia.base.org";
}

function getWormholeBaseUsdc(ctx: PluginContext): string {
  if (WORMHOLE_BASE_CHAIN.toLowerCase() === "base") {
    return BASE_MAINNET_USDC_ADDRESS;
  }
  const base = getBaseChainConfig(ctx);
  return base?.usdcAddress || BASE_MAINNET_USDC_ADDRESS;
}

async function getBaseUsdcBalance(ctx: PluginContext): Promise<bigint> {
  const provider = new ethers.JsonRpcProvider(getWormholeBaseRpcUrl(ctx));
  const wallet = new ethers.Wallet(getBasePrivateKey(ctx), provider);
  const usdc = new ethers.Contract(getWormholeBaseUsdc(ctx), ["function balanceOf(address) view returns (uint256)"], wallet);
  return usdc.balanceOf(wallet.address);
}

function isBaseMainnetToSui(): boolean {
  return WORMHOLE_NETWORK === "Mainnet" && WORMHOLE_BASE_CHAIN.toLowerCase() === "base";
}

function clampBaseMainnetToSui(amount: bigint): { amount: bigint; capped: boolean } {
  if (!isBaseMainnetToSui()) return { amount, capped: false };
  if (amount > BASE_MAINNET_TO_SUI_MAX_USDC) {
    return { amount: BASE_MAINNET_TO_SUI_MAX_USDC, capped: true };
  }
  return { amount, capped: false };
}

async function bridgeBaseToSui(
  ctx: PluginContext,
  amount: bigint,
  forUser: string,
  suiAddress: string,
  poolKey: string,
  apy?: number
): Promise<{ success: boolean; mocked: boolean; bridgeTxHash?: string; amountBridged?: bigint }> {
  try {
    const capped = clampBaseMainnetToSui(amount);
    if (capped.capped) {
      console.log(
        `[Sui] Capping Base→Sui bridge to 0.1 USDC on Base mainnet ` +
        `(requested ${ethers.formatUnits(amount, 6)} USDC)`
      );
    }
    amount = capped.amount;
    const wh = new Wormhole(WORMHOLE_NETWORK, [evmPlatform.Platform, suiPlatform.Platform]) as any;
    const src = wh.getChain(WORMHOLE_BASE_CHAIN as any);
    const dst = wh.getChain("Sui" as any);

    const srcSigner = await getBaseSigner(src, ctx);

    const srcUsdc = circle.usdcContract.get(WORMHOLE_NETWORK, src.chain);
    const dstUsdc = circle.usdcContract.get(WORMHOLE_NETWORK, dst.chain);
    if (!srcUsdc || !dstUsdc) {
      throw new Error("USDC is not configured for the selected Wormhole chains");
    }

    const sender = Wormhole.chainAddress(src.chain, srcSigner.address());
    const recipient = Wormhole.chainAddress(dst.chain, suiAddress);
    const amountUsdc = Number(ethers.formatUnits(amount, 6));

    const tr = (await routes.RouteTransferRequest.create(wh as any, {
      source: Wormhole.tokenId(src.chain, srcUsdc),
      destination: Wormhole.tokenId(dst.chain, dstUsdc),
      sourceDecimals: 6,
      destinationDecimals: 6,
      sender,
      recipient,
    })) as any;

    const RouteImpl = cctpExecutorRoute() as any;
    const route = new RouteImpl(wh) as any;
    const validation = await route.validate(tr, { amount: amountUsdc });
    if (!validation.valid) {
      throw validation.error;
    }

    const quote = await route.quote(tr, validation.params);
    if (!quote.success) {
      throw quote.error ?? new Error("Failed to fetch Wormhole CCTP quote");
    }

    console.log(
      `[Sui] Wormhole CCTP quote: ${amountUsdc} USDC from ${WORMHOLE_BASE_CHAIN} → Sui`
    );
    console.log(`[Sui] Submitting Wormhole CCTP transfer...`);

    const receipt = await route.initiate(tr, srcSigner, quote, recipient);
    const originTxs = (receipt as any)?.originTxs as any[] | undefined;
    const lastTx = originTxs?.[originTxs.length - 1];
    const txHash =
      typeof lastTx === "string" ? lastTx : lastTx?.txid ? String(lastTx.txid) : undefined;

    pendingBridges.set(forUser, {
      user: forUser,
      suiAddress,
      amount,
      startedAt: Date.now(),
      txHash,
      poolKey,
      apy,
    });

    console.log(`[Sui] Wormhole transfer submitted${txHash ? `: ${txHash}` : ""}`);
    if (txHash) {
      const whNetwork = WORMHOLE_NETWORK.toLowerCase() === "testnet" ? "Testnet" : "Mainnet";
      console.log(`[Sui][Explorer] WormholeScan: https://wormholescan.io/#/tx/${txHash}?network=${whNetwork}`);
    }
    return { success: true, mocked: false, bridgeTxHash: txHash, amountBridged: amount };
  } catch (error) {
    console.error("[Sui] Wormhole bridge failed:", error);
    return { success: false, mocked: true, amountBridged: amount };
  }
}

async function getSuiUsdcBalance(
  client: SuiClientType,
  owner: string,
  coinType: string
): Promise<number> {
  try {
    const balances = await client.listBalances({ owner });
    const list = (balances as any)?.data || (balances as any)?.balances || balances;
    if (Array.isArray(list)) {
      const match = list.find((b: any) => b.coinType === coinType);
      if (match) {
        const raw = match.balance ?? match.coinBalance ?? match.totalBalance ?? match.amount;
        if (raw !== undefined) return Number(raw) / 1e6;
      }
    }
  } catch (error) {
    console.log("[Sui] listBalances failed:", error);
  }
  return 0;
}

async function drainPendingBridges(ctx: PluginContext): Promise<RebalanceAction[]> {
  const actions: RebalanceAction[] = [];
  if (pendingBridges.size === 0) return actions;
  const { network, coins } = getSuiNetworkConfig();
  const suiRpcUrl = ctx.suiConfig?.rpcUrl || getDefaultSuiRpcUrl();
  const suiClient = new SuiGrpcClient({ network, baseUrl: suiRpcUrl });

  for (const [user, pending] of pendingBridges.entries()) {
    const suiKey = getStorage().getSuiKey(user);
    if (!suiKey) continue;
    const balance = await getSuiUsdcBalance(suiClient, pending.suiAddress, coins.USDC.type);
    if (balance <= 0) {
      console.log(
        `[Sui] Awaiting USDC on Sui for ${user.slice(0, 10)}... (pending Wormhole bridge)`
      );
      continue;
    }

    const amountToDeposit = BigInt(Math.floor(Math.min(balance, Number(ethers.formatUnits(pending.amount, 6))) * 1e6));
    if (amountToDeposit <= 0n) continue;

    const deepbookResult = await depositToDeepBook(ctx, user, amountToDeposit, pending.poolKey);
    if (deepbookResult.success) {
      getStorage().upsertPosition({
        user,
        chain: "sui",
        usdcAmount: amountToDeposit.toString(),
        poolShares: deepbookResult.poolShares.toString(),
        depositTime: Date.now(),
        bridgeTxHash: pending.txHash,
        status: "active",
      });
      actions.push({
        type: "deposit",
        chain: "sui",
        amount: amountToDeposit,
        details: {
          user,
          protocol: "DeepBook",
          pool: pending.poolKey,
          apy: pending.apy,
          mocked: deepbookResult.mocked,
        },
      });
      pendingBridges.delete(user);
    }
  }
  return actions;
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

  console.log(`[Sui] Reverse bridge via Wormhole not implemented yet (demo sim).`);

  const holdTimeMs = Date.now() - depositTime;
  const holdTimeYears = holdTimeMs / (365 * 24 * 60 * 60 * 1000);

  const pools = await getDeepBookYields(ctx);
  const bestPool = pools.reduce((best, curr) => (curr.apy > best.apy ? curr : best), pools[0]);
  const yieldRate = bestPool ? bestPool.apy / 100 : 0.08;

  const minProfit = positionAmount / 666n;
  const calculatedProfit = BigInt(Math.floor(Number(positionAmount) * yieldRate * holdTimeYears));
  const profit = calculatedProfit > minProfit ? calculatedProfit : minProfit;

  const usdcReturned = positionAmount + profit;
  getStorage().deletePosition(forUser);

  return { success: true, mocked: true, usdcReturned, profit };
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

    const { network, coins, pools } = getSuiNetworkConfig();
    const suiRpcUrl = ctx.suiConfig?.rpcUrl || getDefaultSuiRpcUrl();
    const suiClient = new SuiGrpcClient({ network, baseUrl: suiRpcUrl });
    const suiKeypair = getSuiKeypair(suiKey.privateKey);
    const address = suiKey.suiAddress;

    const balanceManagerId = await ensureBalanceManagerId(suiClient, address, suiKeypair);

    const deepbookClient = suiClient.$extend(
      deepbook({
        address,
        coins,
        pools,
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
    } as any);

    const digest = (res as any)?.digest ?? (res as any)?.effects?.transactionDigest;
    console.log(`[Sui] DeepBook deposit tx: ${digest ?? "unknown"}`);
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

    if (!loggedSuiNetwork) {
      console.log(`[Sui] Network set to ${SUI_NETWORK} (Wormhole ${WORMHOLE_NETWORK})`);
      loggedSuiNetwork = true;
    }

    actions.push(...await drainPendingBridges(ctx));

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

        // If Wormhole Base->Sui flow is enabled, use Base USDC availability instead of Arc borrow state
        if (WORMHOLE_BASE_TO_SUI) {
          const gatewayPositions = getStorage().listGatewayPositions();
          const gatewayPos = gatewayPositions.find(
            (p) => p.user.toLowerCase() === user.toLowerCase() && p.status === "active"
          );
          if (!gatewayPos) {
            console.log(`[Sui] ${user.slice(0, 10)}... no Base vault position yet, skip`);
            continue;
          }

          const desiredRaw = BigInt(gatewayPos.amount || "0");
          const desiredCapped = clampBaseMainnetToSui(desiredRaw);
          if (desiredCapped.capped) {
            console.log(
              `[Sui] Capping Base→Sui bridge to 0.1 USDC on Base mainnet ` +
              `(requested ${ethers.formatUnits(desiredRaw, 6)} USDC)`
            );
          }
          const desired = desiredCapped.amount;
          const baseBalance = await getBaseUsdcBalance(ctx);
          if (baseBalance < desired || desired === 0n) {
            console.log(
              `[Sui] Base USDC balance too low for Wormhole bridge: ` +
              `${ethers.formatUnits(baseBalance, 6)} < ${ethers.formatUnits(desired, 6)}`
            );
            continue;
          }

          console.log(`[Sui] Base USDC detected. Bridging via Wormhole for ${user.slice(0, 10)}...`);
          const bridgeResult = await bridgeBaseToSui(
            ctx,
            desired,
            user,
            suiKey.suiAddress,
            bestPool.poolKey,
            bestPool.apy
          );
          if (bridgeResult.success) {
            const bridgedAmount = bridgeResult.amountBridged ?? desired;
            actions.push({
              type: "bridge",
              chain: "base",
              amount: bridgedAmount,
              details: {
                user,
                direction: "outbound",
                from: "base",
                to: "sui",
                protocol: "Wormhole CCTP",
                stage: "mint",
                mocked: bridgeResult.mocked,
              },
              txHash: bridgeResult.bridgeTxHash,
            });
            console.log(
              `[RELEVANT][Sui] Wormhole bridge queued for ${user.slice(0, 10)}... ` +
              `will deposit to DeepBook when USDC arrives on Sui`
            );
          }
          continue;
        }

        // Check if already borrowed (Arc-only path)
        const borrowed = await vault.getBorrowedRWA(user);
        if (borrowed.amount > 0n) {
          continue;
        }

        // Calculate borrow amount (20% of deposit for Sui - most conservative)
        const maxBorrow = policy.maxBorrowAmount;
        const fifthDeposit = amount / 5n;
        const borrowAmountRaw = maxBorrow < fifthDeposit ? maxBorrow : fifthDeposit;
        const borrowCapped = clampBaseMainnetToSui(borrowAmountRaw);
        if (borrowCapped.capped) {
          console.log(
            `[Sui] Capping Base→Sui bridge to 0.1 USDC on Base mainnet ` +
            `(requested ${ethers.formatUnits(borrowAmountRaw, 6)} USDC)`
          );
        }
        const borrowAmount = borrowCapped.amount;

        if (borrowAmount === 0n) continue;

        if (bestPool.apy < SUI_YIELD_THRESHOLD) {
          console.log(`[Sui] Best pool APY ${bestPool.apy.toFixed(2)}% below threshold ${SUI_YIELD_THRESHOLD}%`);
          continue;
        }

        console.log(`[Sui] Processing ${user.slice(0, 10)}... for Sui DeepBook yield`);

        // Step 1: Borrow from vault unless we are sourcing from Base via Wormhole
        if (!WORMHOLE_BASE_TO_SUI) {
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
        } else {
          const baseBalance = await getBaseUsdcBalance(ctx);
          if (baseBalance < borrowAmount) {
            console.log(
              `[Sui] Base USDC balance too low for Wormhole bridge: ` +
              `${ethers.formatUnits(baseBalance, 6)} < ${ethers.formatUnits(borrowAmount, 6)}`
            );
            continue;
          }
          console.log(`[Sui] Using Base USDC balance for Wormhole bridge`);
        }

        // Step 2: Bridge to Sui via Wormhole (CCTP executor route)
        const bridgeResult = await bridgeBaseToSui(
          ctx,
          borrowAmount,
          user,
          suiKey.suiAddress,
          bestPool.poolKey,
          bestPool.apy
        );

        if (bridgeResult.success) {
          const bridgedAmount = bridgeResult.amountBridged ?? borrowAmount;
          actions.push({
            type: "bridge",
            chain: "base",
            amount: bridgedAmount,
            details: {
              user,
              direction: "outbound",
              from: "base",
              to: "sui",
              protocol: "Wormhole CCTP",
              mocked: bridgeResult.mocked,
            },
            txHash: bridgeResult.bridgeTxHash,
          });
          console.log(
            `[RELEVANT][Sui] Wormhole bridge queued for ${user.slice(0, 10)}... ` +
            `will deposit to DeepBook when USDC arrives on Sui`
          );
        }

        continue;
      } catch (error) {
        console.error(`[Sui] Error processing ${user}:`, error);
      }
    }

    return actions;
  },
};
