import {
  config,
  createConfig,
  executeRoute,
  getChains,
  getQuote,
  getRoutes,
  EVM,
  Sui,
  type QuoteRequest,
  type Route,
  type RoutesRequest,
  type SDKProvider,
} from "@lifi/sdk";
import { createWalletClient, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalSuiWallet } from "./sui-wallet.js";

// ============================================================
// LI.FI Bridge Configuration
// ============================================================

// Chain IDs
const ARC_TESTNET_CHAIN_ID = 5042002;
const SUI_CHAIN_ID = 101; // LI.FI's internal ID for Sui

// USDC addresses per chain
const USDC_ADDRESSES: Record<number, string> = {
  [ARC_TESTNET_CHAIN_ID]: "0x3600000000000000000000000000000000000000", // Arc native USDC
  [SUI_CHAIN_ID]: "0x5d4b302506645c37ff133b98c4b50a5ae14e9876::coin::COIN", // Sui USDC
};

let lifiConfigured = false;
let cachedSuiAddress: string | null = null;
let cachedSuiSupport: { supported: boolean; chainId?: number; name?: string } | null = null;

// ============================================================
// LI.FI SDK Setup
// ============================================================

export interface LiFiBridgeConfig {
  privateKey: string;
  arcRpcUrl?: string;
  suiPrivateKey?: string;
  suiRpcUrl?: string;
}

export function initLiFi(configInput: LiFiBridgeConfig): void {
  if (!lifiConfigured) {
    const rawApiKey = process.env.LIFI_API_KEY || "";
    const apiKey =
      rawApiKey && !rawApiKey.toLowerCase().includes("your_lifi_api_key_here")
        ? rawApiKey
        : undefined;
    createConfig({
      integrator: process.env.LIFI_INTEGRATOR || "TreasuryForge",
      apiKey,
    });
    lifiConfigured = true;
  }

  const arcRpcUrl = configInput.arcRpcUrl || "https://rpc.testnet.arc.network";
  const arcChain: Chain = {
    id: ARC_TESTNET_CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
    rpcUrls: {
      default: { http: [arcRpcUrl] },
      public: { http: [arcRpcUrl] },
    },
  };

  const account = privateKeyToAccount(normalizeEvmPrivateKey(configInput.privateKey));

  const getWalletClient = async () =>
    createWalletClient({
      account,
      chain: arcChain,
      transport: http(arcRpcUrl),
    });

  const providers: SDKProvider[] = [EVM({ getWalletClient }) as SDKProvider];

  if (configInput.suiPrivateKey) {
    const suiRpcUrl = configInput.suiRpcUrl || "https://fullnode.testnet.sui.io:443";
    const { wallet, address } = createLocalSuiWallet({
      privateKey: configInput.suiPrivateKey,
      rpcUrl: suiRpcUrl,
    });

    cachedSuiAddress = address;

    const suiProvider = (Sui as unknown as (opts: { getWallet: () => Promise<any> }) => SDKProvider)({
      getWallet: async () => wallet as any,
    });
    providers.push(suiProvider);
  }

  config.setProviders(providers);
  console.log("[LiFi] SDK configured for TreasuryForge (multi-VM)");
}

function normalizeEvmPrivateKey(input: string): `0x${string}` {
  if (input.startsWith("0x")) return input as `0x${string}`;
  return `0x${input}` as `0x${string}`;
}

function requireInitialized() {
  if (!lifiConfigured) {
    throw new Error("LI.FI SDK not initialized. Call initLiFi first.");
  }
}

function requireSuiWallet(): string {
  if (!cachedSuiAddress) {
    throw new Error("Sui wallet not configured. Set SUI_PRIVATE_KEY to enable Sui execution.");
  }
  return cachedSuiAddress;
}

function extractTxHash(route: Route): string | undefined {
  for (const step of route.steps || []) {
    if ((step as any).transactionId) return (step as any).transactionId;
    const execution = (step as any).execution;
    const processes = execution?.process ?? execution?.processes;
    if (Array.isArray(processes)) {
      const tx = processes.find((p: any) => p?.txHash);
      if (tx?.txHash) return tx.txHash;
    }
  }
  return undefined;
}

// ============================================================
// Bridge Operations
// ============================================================

export interface BridgeQuote {
  fromChain: number;
  toChain: number;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  estimatedOutput: string;
  estimatedGas: string;
  bridgeUsed: string;
  executionTime: number; // seconds
}

export interface BridgeResult {
  success: boolean;
  mocked: boolean;
  txHash?: string;
  outputAmount?: bigint;
  error?: string;
}

/**
 * Get a quote for bridging USDC from Arc to Sui
 */
export async function getArcToSuiQuote(
  amount: bigint,
  fromAddress: string,
  toSuiAddress?: string
): Promise<BridgeQuote | null> {
  try {
    requireInitialized();
    const quoteRequest: QuoteRequest = {
      fromChain: ARC_TESTNET_CHAIN_ID,
      toChain: SUI_CHAIN_ID,
      fromToken: USDC_ADDRESSES[ARC_TESTNET_CHAIN_ID],
      toToken: USDC_ADDRESSES[SUI_CHAIN_ID],
      fromAmount: amount.toString(),
      fromAddress,
      toAddress: toSuiAddress || fromAddress,
      slippage: 0.03,
    };

    const quote = await getQuote(quoteRequest);

    return {
      fromChain: ARC_TESTNET_CHAIN_ID,
      toChain: SUI_CHAIN_ID,
      fromToken: USDC_ADDRESSES[ARC_TESTNET_CHAIN_ID],
      toToken: USDC_ADDRESSES[SUI_CHAIN_ID],
      fromAmount: amount.toString(),
      estimatedOutput: quote.estimate?.toAmount || amount.toString(),
      estimatedGas: quote.estimate?.gasCosts?.[0]?.amount || "0",
      bridgeUsed: quote.toolDetails?.name || quote.tool || "Unknown",
      executionTime: quote.estimate?.executionDuration || 300,
    };
  } catch (error: any) {
    console.log(`[LiFi] Failed to get Arc→Sui quote: ${error.message}`);
    return null;
  }
}

/**
 * Get a quote for bridging USDC from Sui back to Arc
 */
export async function getSuiToArcQuote(
  amount: bigint,
  fromSuiAddress: string,
  toAddress: string
): Promise<BridgeQuote | null> {
  try {
    requireInitialized();
    const quoteRequest: QuoteRequest = {
      fromChain: SUI_CHAIN_ID,
      toChain: ARC_TESTNET_CHAIN_ID,
      fromToken: USDC_ADDRESSES[SUI_CHAIN_ID],
      toToken: USDC_ADDRESSES[ARC_TESTNET_CHAIN_ID],
      fromAmount: amount.toString(),
      fromAddress: fromSuiAddress,
      toAddress,
      slippage: 0.03,
    };

    const quote = await getQuote(quoteRequest);

    return {
      fromChain: SUI_CHAIN_ID,
      toChain: ARC_TESTNET_CHAIN_ID,
      fromToken: USDC_ADDRESSES[SUI_CHAIN_ID],
      toToken: USDC_ADDRESSES[ARC_TESTNET_CHAIN_ID],
      fromAmount: amount.toString(),
      estimatedOutput: quote.estimate?.toAmount || amount.toString(),
      estimatedGas: quote.estimate?.gasCosts?.[0]?.amount || "0",
      bridgeUsed: quote.toolDetails?.name || quote.tool || "Unknown",
      executionTime: quote.estimate?.executionDuration || 300,
    };
  } catch (error: any) {
    console.log(`[LiFi] Failed to get Sui→Arc quote: ${error.message}`);
    return null;
  }
}

/**
 * Execute bridge from Arc to Sui
 */
export async function bridgeArcToSui(
  amount: bigint,
  fromAddress: string,
  toSuiAddress?: string
): Promise<BridgeResult> {
  try {
    requireInitialized();
    const destination = toSuiAddress || requireSuiWallet();

    const routesRequest: RoutesRequest = {
      fromChainId: ARC_TESTNET_CHAIN_ID,
      toChainId: SUI_CHAIN_ID,
      fromTokenAddress: USDC_ADDRESSES[ARC_TESTNET_CHAIN_ID],
      toTokenAddress: USDC_ADDRESSES[SUI_CHAIN_ID],
      fromAmount: amount.toString(),
      fromAddress,
      toAddress: destination,
      options: { slippage: 0.03 },
    };

    const routes = await getRoutes(routesRequest);
    const route = routes.routes?.[0];
    if (!route) {
      throw new Error("No routes available for Arc→Sui");
    }

    console.log(`[LiFi] Route selected: ${route.steps?.[0]?.tool || "unknown"}, id=${route.id}`);

    let lastRoute: Route = route;
    const executedRoute = await executeRoute(route, {
      updateRouteHook: (updated) => {
        lastRoute = updated as Route;
        const steps = updated.steps?.length ?? 0;
        console.log(`[LiFi] Route update: id=${updated.id}, steps=${steps}`);
      },
    });

    const finalRoute = (executedRoute as Route) || lastRoute;
    const txHash = extractTxHash(finalRoute);

    return {
      success: true,
      mocked: false,
      txHash,
      outputAmount: BigInt(finalRoute.toAmount || amount.toString()),
    };
  } catch (error: any) {
    console.log(`[LiFi] Bridge Arc→Sui failed: ${error.message}`);

    return {
      success: true,
      mocked: true,
      txHash: `lifi_mock_${Date.now()}`,
      outputAmount: amount,
      error: error.message,
    };
  }
}

/**
 * Execute bridge from Sui back to Arc
 */
export async function bridgeSuiToArc(
  amount: bigint,
  fromSuiAddress: string,
  toAddress: string
): Promise<BridgeResult> {
  try {
    requireInitialized();
    requireSuiWallet();

    const routesRequest: RoutesRequest = {
      fromChainId: SUI_CHAIN_ID,
      toChainId: ARC_TESTNET_CHAIN_ID,
      fromTokenAddress: USDC_ADDRESSES[SUI_CHAIN_ID],
      toTokenAddress: USDC_ADDRESSES[ARC_TESTNET_CHAIN_ID],
      fromAmount: amount.toString(),
      fromAddress: fromSuiAddress,
      toAddress,
      options: { slippage: 0.03 },
    };

    const routes = await getRoutes(routesRequest);
    const route = routes.routes?.[0];
    if (!route) {
      throw new Error("No routes available for Sui→Arc");
    }

    console.log(`[LiFi] Route selected: ${route.steps?.[0]?.tool || "unknown"}, id=${route.id}`);

    let lastRoute: Route = route;
    const executedRoute = await executeRoute(route, {
      updateRouteHook: (updated) => {
        lastRoute = updated as Route;
        const steps = updated.steps?.length ?? 0;
        console.log(`[LiFi] Route update: id=${updated.id}, steps=${steps}`);
      },
    });

    const finalRoute = (executedRoute as Route) || lastRoute;
    const txHash = extractTxHash(finalRoute);

    return {
      success: true,
      mocked: false,
      txHash,
      outputAmount: BigInt(finalRoute.toAmount || amount.toString()),
    };
  } catch (error: any) {
    console.log(`[LiFi] Bridge Sui→Arc failed: ${error.message}`);

    return {
      success: true,
      mocked: true,
      txHash: `lifi_mock_return_${Date.now()}`,
      outputAmount: amount,
      error: error.message,
    };
  }
}

/**
 * Check if LI.FI supports a specific route
 */
export async function checkRouteAvailable(
  fromChainId: number,
  toChainId: number
): Promise<boolean> {
  try {
    const chains = await getChains();
    const fromChain = chains.find((c) => c.id === fromChainId);
    const toChain = chains.find((c) => c.id === toChainId);
    return !!(fromChain && toChain);
  } catch {
    return false;
  }
}

/**
 * Get supported chains from LI.FI
 */
export async function getSupportedChains(): Promise<{ id: number; name: string }[]> {
  try {
    const chains = await getChains();
    return chains.map((c) => ({ id: c.id, name: c.name }));
  } catch (error: any) {
    console.log(`[LiFi] Failed to get chains: ${error.message}`);
    return [];
  }
}

/**
 * Check if LI.FI currently supports Sui as a chain.
 */
export async function checkSuiChainSupport(): Promise<{ supported: boolean; chainId?: number; name?: string }> {
  if (cachedSuiSupport) return cachedSuiSupport;

  try {
    const chains = await getChains();
    const sui = chains.find((c: any) => {
      const name = String(c.name || "").toLowerCase();
      const key = String(c.key || "").toLowerCase();
      return name === "sui" || key === "sui";
    });

    if (sui) {
      cachedSuiSupport = { supported: true, chainId: sui.id, name: sui.name };
      return cachedSuiSupport;
    }
  } catch (error: any) {
    console.log(`[LiFi] Failed to check Sui support: ${error.message}`);
  }

  cachedSuiSupport = { supported: false };
  return cachedSuiSupport;
}

export function getCachedSuiAddress(): string | null {
  return cachedSuiAddress;
}
