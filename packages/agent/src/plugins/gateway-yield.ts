import { randomBytes } from "node:crypto";
import { ethers, NonceManager } from "ethers";
import axios from "axios";
import { AaveV3BaseSepolia } from "@bgd-labs/aave-address-book";
import { Plugin, PluginContext, YieldOpportunity, RebalanceAction, ChainConfig } from "../types.js";
import { TREASURY_VAULT_ABI } from "../abi/TreasuryVault.js";
import { GATEWAY_WALLET_ABI, GATEWAY_MINTER_ABI, ERC20_ABI, CHAIN_DOMAINS } from "../abi/Gateway.js";
import { AAVE_V3_POOL_ABI, AAVE_V3_DATA_PROVIDER_ABI } from "../abi/AaveV3.js";
import { COMET_ABI } from "../abi/CompoundIII.js";
import { AgentStorage } from "../utils/agent-storage.js";
import { logExplorerTx } from "../utils/tx-links.js";

// ============================================================
// Cross-chain position tracking (in-memory for MVP)
// ============================================================
interface CrossChainPosition {
  user: string;
  sourceChain: string;
  destinationChain: string;
  amount: bigint;
  depositTime: number;
  depositTxHash?: string;
}

const crossChainPositions: Map<string, CrossChainPosition> = new Map();

// Minimum time before returning funds (demo: 2 minutes)
const MIN_HOLD_TIME_MS = 2 * 60 * 1000;

// Yield threshold to trigger cross-chain movement
const YIELD_DIFF_THRESHOLD = 1.0; // 1% higher yield required to move

// ============================================================
// Yield sources per chain (DefiLlama + fallback)
// ============================================================
interface ChainYield {
  chain: string;
  protocol: string;
  apy: number;
  tvl: number;
}

const DEFILLAMA_YIELDS_URL = process.env.DEFILLAMA_YIELDS_URL || "https://yields.llama.fi/pools";
const DEFILLAMA_MIN_TVL = Number(process.env.DEFILLAMA_MIN_TVL || 5_000_000);
const DEFILLAMA_TIMEOUT_MS = Number(process.env.DEFILLAMA_TIMEOUT_MS || 10_000);
const DEFILLAMA_MAX_APY = Number(process.env.DEFILLAMA_MAX_APY || 30);
const DEFILLAMA_ALLOWED_PROJECTS = new Set(
  (process.env.DEFILLAMA_ALLOWED_PROJECTS ||
    "aave,compound,morpho,spark,aerodrome,uniswap,curve,yearn")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
);

// ============================================================
// Base Sepolia demo (Aave-only mock yield)
// ============================================================
function getBaseSepoliaRpcUrl() {
  return process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
}

function isBaseSepoliaDemoEnabled() {
  return String(process.env.BASE_SEPOLIA_DEMO_ENABLED || "false").toLowerCase() === "true";
}

function getBaseSepoliaDemoAmount() {
  return process.env.BASE_SEPOLIA_DEMO_AMOUNT_USDC || "1";
}

function getBaseSepoliaAaveApyFallback() {
  return Number(process.env.BASE_SEPOLIA_AAVE_APY || "7.5");
}

function getBaseSepoliaAaveApyMin() {
  return Number(process.env.BASE_SEPOLIA_AAVE_APY_MIN || "0");
}

function getBaseSepoliaAaveApyMax() {
  return Number(process.env.BASE_SEPOLIA_AAVE_APY_MAX || "100");
}

function getBaseSepoliaCometAddress() {
  return process.env.BASE_SEPOLIA_COMET_ADDRESS || "";
}

function getBaseSepoliaSwapRouter() {
  const value = process.env.BASE_SEPOLIA_SWAP_ROUTER;
  if (value && value.trim()) return value.trim();
  return "";
}

function getBaseSepoliaSwapFee() {
  return Number(process.env.BASE_SEPOLIA_SWAP_FEE || "3000");
}

function getBaseVaultDepositBps() {
  const raw = Number(process.env.BASE_VAULT_DEPOSIT_BPS || "10000");
  if (!Number.isFinite(raw)) return 10000;
  return Math.max(0, Math.min(10000, Math.floor(raw)));
}

function getBaseVaultMinDepositUsdc() {
  return process.env.BASE_VAULT_DEPOSIT_MIN_USDC || "1";
}

function getGatewayApiBaseUrl() {
  return process.env.GATEWAY_API_BASE_URL || "https://gateway-api-testnet.circle.com/v1";
}

function getGatewayMaxFee() {
  return BigInt(process.env.GATEWAY_MAX_FEE || "2010000");
}
const GATEWAY_MAX_BLOCK_HEIGHT = (1n << 256n) - 1n;

const EIP712_DOMAIN = { name: "GatewayWallet", version: "1" } as const;

const EIP712_TYPES = {
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
} as const;


// ============================================================
// Persistent storage (Aave positions)
// ============================================================
let _storage: AgentStorage | null = null;
function getStorage(): AgentStorage {
  if (!_storage) _storage = new AgentStorage();
  return _storage;
}

let _baseSepoliaNonceManager: NonceManager | null = null;
async function getBaseSepoliaSigner(ctx: PluginContext): Promise<NonceManager> {
  if (_baseSepoliaNonceManager) return _baseSepoliaNonceManager;
  const provider = new ethers.JsonRpcProvider(getBaseSepoliaRpcUrl());
  const wallet = new ethers.Wallet(ctx.privateKey, provider);
  const nm = new NonceManager(wallet);
  // Warm nonce cache using pending nonce
  await nm.getNonce("pending");
  _baseSepoliaNonceManager = nm;
  return nm;
}

function computeBaseVaultDepositAmount(amount: bigint): bigint {
  const bps = getBaseVaultDepositBps();
  const min = ethers.parseUnits(getBaseVaultMinDepositUsdc(), 6);
  let deposit = (amount * BigInt(bps)) / 10000n;
  if (deposit < min) {
    deposit = amount >= min ? min : 0n;
  }
  if (deposit > amount) deposit = amount;
  return deposit;
}

async function depositToBaseVault(
  ctx: PluginContext,
  baseChain: ChainConfig,
  amount: bigint,
  meta?: { user?: string }
): Promise<{ success: boolean; txHash?: string; amountDeposited?: bigint }> {
  try {
    if (!ctx.baseVaultAddress) {
      console.log("[Base Vault] BASE_VAULT_ADDRESS not set, skipping deposit");
      return { success: false };
    }

    const wallet = await getBaseSepoliaSigner(ctx);
    const usdc = new ethers.Contract(baseChain.usdcAddress, ERC20_ABI, wallet);
    const vault = new ethers.Contract(ctx.baseVaultAddress, TREASURY_VAULT_ABI, wallet);

    const balance = await usdc.balanceOf(wallet.address);
    let depositAmount = computeBaseVaultDepositAmount(amount);
    if (depositAmount === 0n) {
      console.log("[Base Vault] Computed deposit amount is 0, skipping");
      return { success: false };
    }

    if (balance < depositAmount) {
      const adjusted = balance;
      if (adjusted <= 0n) {
        console.log("[Base Vault] Insufficient USDC balance for deposit");
        return { success: false };
      }
      console.log(
        `[Base Vault] Adjusting deposit amount to ${ethers.formatUnits(adjusted, 6)} USDC due to balance`
      );
      depositAmount = adjusted;
    }

    const allowance = await usdc.allowance(wallet.address, ctx.baseVaultAddress);
    if (allowance < depositAmount) {
      const approveTx = await usdc.approve(ctx.baseVaultAddress, depositAmount);
      await approveTx.wait();
    }

    const depositTx = await vault.deposit(depositAmount);
    const receipt = await depositTx.wait();

    console.log(
      `[Base Vault] Deposited ${ethers.formatUnits(depositAmount, 6)} USDC` +
        (meta?.user ? ` for ${meta.user.slice(0, 10)}...` : "")
    );
    logExplorerTx("base", receipt.hash, "Base vault deposit");

    return { success: true, txHash: receipt.hash, amountDeposited: depositAmount };
  } catch (error) {
    console.error("[Base Vault] Deposit failed:", error);
    return { success: false };
  }
}

async function withdrawFromBaseVault(
  ctx: PluginContext,
  amount: bigint
): Promise<{ success: boolean; txHash?: string; amountWithdrawn?: bigint }> {
  try {
    if (!ctx.baseVaultAddress) {
      console.log("[Base Vault] BASE_VAULT_ADDRESS not set, cannot withdraw");
      return { success: false };
    }

    const wallet = await getBaseSepoliaSigner(ctx);
    const vault = new ethers.Contract(ctx.baseVaultAddress, TREASURY_VAULT_ABI, wallet);

    const vaultBalance = await vault.balanceOf(wallet.address);
    let withdrawAmount = amount;
    if (vaultBalance < withdrawAmount) {
      if (vaultBalance <= 0n) {
        console.log("[Base Vault] No vault balance to withdraw");
        return { success: false };
      }
      console.log(
        `[Base Vault] Adjusting withdraw amount to ${ethers.formatUnits(vaultBalance, 6)} USDC due to vault balance`
      );
      withdrawAmount = vaultBalance;
    }

    const withdrawTx = await vault.withdraw(withdrawAmount);
    const receipt = await withdrawTx.wait();

    console.log(`[Base Vault] Withdrew ${ethers.formatUnits(withdrawAmount, 6)} USDC`);
    logExplorerTx("base", receipt.hash, "Base vault withdraw");

    return { success: true, txHash: receipt.hash, amountWithdrawn: withdrawAmount };
  } catch (error) {
    console.error("[Base Vault] Withdraw failed:", error);
    return { success: false };
  }
}
async function supplyToAaveBaseSepolia(
  ctx: PluginContext,
  amount: bigint,
  meta?: { user?: string; apy?: number }
): Promise<{ success: boolean; txHash?: string; mocked?: boolean }> {
  try {
    const wallet = await getBaseSepoliaSigner(ctx);

    const usdcAddress = AaveV3BaseSepolia.ASSETS.USDC.UNDERLYING;
    const poolAddress = AaveV3BaseSepolia.POOL;

    const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, wallet);
    const balance = await usdc.balanceOf(wallet.address);

    if (balance < amount) {
      console.log(
        `[Base Sepolia/Aave] Insufficient USDC: ${ethers.formatUnits(balance, 6)} < ${ethers.formatUnits(amount, 6)}`
      );
      return { success: false };
    }

    const allowance = await usdc.allowance(wallet.address, poolAddress);
    if (allowance < amount) {
      const approveTx = await usdc.approve(poolAddress, amount);
      await approveTx.wait();
    }

    const pool = new ethers.Contract(poolAddress, AAVE_V3_POOL_ABI, wallet);
    const supplyTx = await pool.supply(usdcAddress, amount, wallet.address, 0);
    const receipt = await supplyTx.wait();

    console.log(
      `[Base Sepolia/Aave] Supplied ${ethers.formatUnits(amount, 6)} USDC`
    );
    logExplorerTx("base", receipt.hash, "Aave supply");

    const user = meta?.user;
    if (user) {
      try {
        getStorage().upsertAavePosition({
          user,
          chain: "base-sepolia",
          protocol: "AaveV3",
          asset: usdcAddress,
          usdcAmount: ethers.formatUnits(amount, 6),
          aToken: AaveV3BaseSepolia.ASSETS.USDC.A_TOKEN,
          apy: meta?.apy ?? 0,
          depositTime: Date.now(),
          txHash: receipt.hash,
          status: "active",
          updatedAt: Date.now(),
        });
      } catch (error) {
        console.log("[Base Sepolia/Aave] Failed to persist position:", error);
      }
    }

    return { success: true, txHash: receipt.hash };
  } catch (error) {
    console.error("[Base Sepolia/Aave] Supply failed:", error);
    return { success: false };
  }
}

async function fetchCompoundBaseSepoliaSupplyApy(): Promise<number> {
  try {
    const cometAddress = getBaseSepoliaCometAddress();
    if (!cometAddress) throw new Error("Missing BASE_SEPOLIA_COMET_ADDRESS");

    const provider = new ethers.JsonRpcProvider(getBaseSepoliaRpcUrl());
    const comet = new ethers.Contract(cometAddress, COMET_ABI, provider);
    const utilization = await comet.getUtilization();
    const ratePerSecond = await comet.getSupplyRate(utilization);

    const rate = Number(ratePerSecond);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error("Invalid supply rate");
    }

    // Comet rates are per-second with 1e18 scale
    const secondsPerYear = 31_536_000;
    const apy = (rate / 1e18) * secondsPerYear * 100;

    return Math.min(Math.max(apy, getBaseSepoliaAaveApyMin()), getBaseSepoliaAaveApyMax());
  } catch (error) {
    console.log("[Base Sepolia/Comet] Failed to fetch APY, using fallback:", error);
    return getBaseSepoliaAaveApyFallback();
  }
}

async function supplyToCompoundBaseSepolia(
  ctx: PluginContext,
  amount: bigint,
  meta?: { user?: string; apy?: number }
): Promise<{ success: boolean; txHash?: string; mocked?: boolean }> {
  try {
    const cometAddress = getBaseSepoliaCometAddress();
    if (!cometAddress) throw new Error("Missing BASE_SEPOLIA_COMET_ADDRESS");

    const wallet = await getBaseSepoliaSigner(ctx);

    const usdcAddress = AaveV3BaseSepolia.ASSETS.USDC.UNDERLYING;

    const comet = new ethers.Contract(cometAddress, COMET_ABI, wallet);
    const baseToken = await comet.baseToken();
    if (baseToken.toLowerCase() !== usdcAddress.toLowerCase()) {
      throw new Error(`Comet baseToken mismatch: ${baseToken} != ${usdcAddress}`);
    }

    const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, wallet);
    const balance = await usdc.balanceOf(wallet.address);

    if (balance < amount) {
      console.log(
        `[Base Sepolia/Comet] Insufficient USDC: ${ethers.formatUnits(balance, 6)} < ${ethers.formatUnits(amount, 6)}`
      );
      return { success: false };
    }

    const allowance = await usdc.allowance(wallet.address, cometAddress);
    if (allowance < amount) {
      const approveTx = await usdc.approve(cometAddress, amount);
      await approveTx.wait();
    }

    const supplyTx = await comet.supply(usdcAddress, amount);
    const receipt = await supplyTx.wait();

    console.log(
      `[Base Sepolia/Comet] Supplied ${ethers.formatUnits(amount, 6)} USDC`
    );
    logExplorerTx("base", receipt.hash, "Comet supply");

    const user = meta?.user;
    if (user) {
      try {
        getStorage().upsertAavePosition({
          user,
          chain: "base-sepolia",
          protocol: "CompoundIII",
          asset: usdcAddress,
          usdcAmount: ethers.formatUnits(amount, 6),
          aToken: cometAddress,
          apy: meta?.apy ?? 0,
          depositTime: Date.now(),
          txHash: receipt.hash,
          status: "active",
          updatedAt: Date.now(),
        });
      } catch (error) {
        console.log("[Base Sepolia/Comet] Failed to persist position:", error);
      }
    }

    return { success: true, txHash: receipt.hash };
  } catch (error) {
    console.error("[Base Sepolia/Comet] Supply failed:", error);
    return { success: false };
  }
}

async function swapCircleToMockUsdcOnBase(
  ctx: PluginContext,
  amountIn: bigint
): Promise<{ success: boolean; txHash?: string; amountOut?: bigint }> {
  try {
    const routerAddress = getBaseSepoliaSwapRouter();
    if (!routerAddress) {
      console.error("[Base Sepolia/Swap] Missing BASE_SEPOLIA_SWAP_ROUTER in .env");
      return { success: false };
    }
    console.log(`[Base Sepolia/Swap] Using router: ${routerAddress}`);
    const fee = getBaseSepoliaSwapFee();
    const wallet = await getBaseSepoliaSigner(ctx);

    // NOTE: Circle USDC on Base Sepolia is 0x036CbD..., Aave/Comet mock USDC is 0xba50Cd...
    const circleUsdcAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const mockUsdcAddress = AaveV3BaseSepolia.ASSETS.USDC.UNDERLYING;

    const routerAbi = [
      "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
    ];

    const token = new ethers.Contract(circleUsdcAddress, ERC20_ABI, wallet);
    const allowance = await token.allowance(wallet.address, routerAddress);
    if (allowance < amountIn) {
      const approveTx = await token.approve(routerAddress, amountIn);
      await approveTx.wait();
    }

    const router = new ethers.Contract(routerAddress, routerAbi, wallet);
    const params = {
      tokenIn: circleUsdcAddress,
      tokenOut: mockUsdcAddress,
      fee,
      recipient: wallet.address,
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    const swapTx = await router.exactInputSingle(params);
    const receipt = await swapTx.wait();
    logExplorerTx("base", receipt.hash, "Uniswap swap");

    return { success: true, txHash: receipt.hash };
  } catch (error) {
    console.error("[Base Sepolia/Swap] Swap failed:", error);
    return { success: false };
  }
}
async function fetchAaveBaseSepoliaSupplyApy(): Promise<number> {
  try {
    const provider = new ethers.JsonRpcProvider(getBaseSepoliaRpcUrl());
    const dataProvider = new ethers.Contract(
      AaveV3BaseSepolia.AAVE_PROTOCOL_DATA_PROVIDER,
      AAVE_V3_DATA_PROVIDER_ABI,
      provider
    );

    const usdc = AaveV3BaseSepolia.ASSETS.USDC.UNDERLYING;
    const reserve = await dataProvider.getReserveData(usdc);

    // liquidityRate is in ray (1e27) and represents APR (per-year)
    const liquidityRateRay = reserve?.[5] as bigint;
    const ray = 10n ** 27n;
    const apy = Number(liquidityRateRay) / Number(ray) * 100;

    if (!Number.isFinite(apy)) {
      throw new Error("Invalid liquidity rate");
    }

    return Math.min(Math.max(apy, getBaseSepoliaAaveApyMin()), getBaseSepoliaAaveApyMax());
  } catch (error) {
    console.log("[Base Sepolia/Aave] Failed to fetch APY, using fallback:", error);
    return getBaseSepoliaAaveApyFallback();
  }
}

type LlamaPoolsResponse = { data?: any[] } | any[];

function normalizeChainName(chain: string): string {
  return chain.toLowerCase().replace(/\s+/g, "");
}

function getMockChainYields(): ChainYield[] {
  // Add some randomness to simulate changing market conditions
  const noise = () => (Math.random() - 0.5) * 2; // ±1%

  return [
    { chain: "arc", protocol: "USYC", apy: 5.0 + noise(), tvl: 10_000_000 },
    { chain: "ethereum", protocol: "Aave-USDC", apy: 4.2 + noise(), tvl: 500_000_000 },
    { chain: "base", protocol: "Compound-USDC", apy: 6.5 + noise(), tvl: 50_000_000 },
    { chain: "avalanche", protocol: "Benqi-USDC", apy: 5.8 + noise(), tvl: 25_000_000 },
  ];
}

async function getDefiLlamaChainYields(): Promise<ChainYield[]> {
  try {
    const response = await axios.get<LlamaPoolsResponse>(DEFILLAMA_YIELDS_URL, {
      timeout: DEFILLAMA_TIMEOUT_MS,
    });

    const pools = Array.isArray(response.data)
      ? response.data
      : (response.data?.data || []);

    if (!Array.isArray(pools) || pools.length === 0) {
      throw new Error("No pools returned");
    }

    const targetChains = new Set(["ethereum", "base", "avalanche"]);
    const chainBest = new Map<string, ChainYield>();

    for (const pool of pools) {
      const chainRaw = String(pool.chain || "").toLowerCase();
      const chain = normalizeChainName(chainRaw);
      if (!targetChains.has(chain)) continue;

      const symbol = String(pool.symbol || "");
      if (!symbol.toUpperCase().includes("USDC")) continue;

      const tvlUsd = Number(pool.tvlUsd ?? pool.tvl ?? 0);
      if (!Number.isFinite(tvlUsd) || tvlUsd < DEFILLAMA_MIN_TVL) continue;

      const apy =
        Number(pool.apy ?? 0) ||
        Number(pool.apyBase ?? 0) + Number(pool.apyReward ?? 0);

      if (!Number.isFinite(apy) || apy <= 0 || apy > DEFILLAMA_MAX_APY) continue;

      const project = String(pool.project || pool.protocol || "").toLowerCase();
      if (project && !DEFILLAMA_ALLOWED_PROJECTS.has(project)) continue;

      const current = chainBest.get(chain);
      if (!current || apy > current.apy) {
        chainBest.set(chain, {
          chain,
          protocol: String(pool.project || pool.protocol || "Unknown"),
          apy,
          tvl: tvlUsd,
        });
      }
    }

    const results = Array.from(chainBest.values());
    if (results.length === 0) {
      throw new Error("No matching USDC pools found");
    }

    // Include Arc baseline (local chain)
    results.push({ chain: "arc", protocol: "USYC", apy: 5.0, tvl: 10_000_000 });
    return results;
  } catch (error) {
    console.log("[Gateway] DefiLlama yields fetch failed, skipping gateway opportunities:", error);
    return [];
  }
}

// ============================================================
// Gateway Operations
// ============================================================

async function getUnifiedBalance(ctx: PluginContext, chainConfig: ChainConfig): Promise<bigint> {
  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    const wallet = new ethers.Wallet(ctx.privateKey, provider);
    const minter = new ethers.Contract(chainConfig.gatewayMinter, GATEWAY_MINTER_ABI, wallet);

    const balance = await minter.unifiedBalance(wallet.address);
    return balance;
  } catch (error) {
    console.log(`[Gateway] Could not fetch unified balance on ${chainConfig.name}:`, error);
    return 0n;
  }
}

function addressToBytes32(address: string) {
  return ("0x" +
    address
      .toLowerCase()
      .replace(/^0x/, "")
      .padStart(64, "0")) as `0x${string}`;
}

async function getGatewayBalance(
  depositor: string,
  domain: number
): Promise<bigint> {
  try {
    const body = {
      token: "USDC",
      sources: [{ domain, depositor }],
    };
    const res = await fetch(`${getGatewayApiBaseUrl()}/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Gateway balances error: ${res.status}`);
    }
    const json = (await res.json()) as { balances?: Array<{ domain: number; balance: string }> };
    const balance = json?.balances?.[0]?.balance || "0";
    return ethers.parseUnits(balance, 6);
  } catch (error) {
    console.log("[Gateway] Failed to fetch balances:", error);
    return 0n;
  }
}

async function depositToGateway(
  ctx: PluginContext,
  sourceChain: ChainConfig,
  amount: bigint,
): Promise<{ success: boolean; txHash?: string; mocked?: boolean }> {
  try {
    const provider = new ethers.JsonRpcProvider(sourceChain.rpcUrl);
    const wallet = new ethers.Wallet(ctx.privateKey, provider);

    // Check USDC balance
    const usdc = new ethers.Contract(sourceChain.usdcAddress, ERC20_ABI, wallet);
    const balance = await usdc.balanceOf(wallet.address);

    if (balance < amount) {
      console.log(`[Gateway] Insufficient USDC on ${sourceChain.name}: ${ethers.formatUnits(balance, 6)} < ${ethers.formatUnits(amount, 6)}`);
      return { success: false };
    }

    // Approve Gateway to spend USDC
    const gatewayWallet = new ethers.Contract(sourceChain.gatewayWallet, GATEWAY_WALLET_ABI, wallet);

    const allowance = await usdc.allowance(wallet.address, sourceChain.gatewayWallet);
    if (allowance < amount) {
      console.log(`[Gateway] Approving USDC for Gateway on ${sourceChain.name}...`);
      const approveTx = await usdc.approve(sourceChain.gatewayWallet, ethers.MaxUint256);
      await approveTx.wait();
    }

    // Deposit to unified balance
    const depositTx = await gatewayWallet["deposit(address,uint256)"](sourceChain.usdcAddress, amount);

    const receipt = await depositTx.wait();
    console.log(`[Gateway] Deposited ${ethers.formatUnits(amount, 6)} USDC to Gateway on ${sourceChain.name}`);
    logExplorerTx(sourceChain.name, receipt.hash, "Gateway deposit");

    return { success: true, txHash: receipt.hash, mocked: false };
  } catch (error) {
    console.log(`[Gateway] Deposit failed on ${sourceChain.name}:`, error);
    return { success: false };
  }
}

async function transferViaGateway(
  ctx: PluginContext,
  sourceChain: ChainConfig,
  destinationChain: ChainConfig,
  amount: bigint,
  recipient?: string
): Promise<{ success: boolean; txHash?: string; mocked?: boolean }> {
  try {
    const sourceProvider = new ethers.JsonRpcProvider(sourceChain.rpcUrl);
    const sourceWallet = new ethers.Wallet(ctx.privateKey, sourceProvider);

    const destProvider = new ethers.JsonRpcProvider(destinationChain.rpcUrl);
    const destWallet = new ethers.Wallet(ctx.privateKey, destProvider);

    const sourceDomain = CHAIN_DOMAINS[sourceChain.name] ?? 0;
    const destinationDomain = CHAIN_DOMAINS[destinationChain.name] ?? 0;
    const depositor = await sourceWallet.getAddress();
    const recipientAddress = recipient || depositor;

    const burnIntent = {
      maxBlockHeight: GATEWAY_MAX_BLOCK_HEIGHT.toString(),
      maxFee: getGatewayMaxFee().toString(),
      spec: {
        version: 1,
        sourceDomain,
        destinationDomain,
        sourceContract: addressToBytes32(sourceChain.gatewayWallet),
        destinationContract: addressToBytes32(destinationChain.gatewayMinter),
        sourceToken: addressToBytes32(sourceChain.usdcAddress),
        destinationToken: addressToBytes32(destinationChain.usdcAddress),
        sourceDepositor: addressToBytes32(depositor),
        destinationRecipient: addressToBytes32(recipientAddress),
        sourceSigner: addressToBytes32(depositor),
        destinationCaller: addressToBytes32("0x0000000000000000000000000000000000000000"),
        value: amount.toString(),
        salt: "0x" + randomBytes(32).toString("hex"),
        hookData: "0x",
      },
    };

    const signature = await sourceWallet.signTypedData(
      EIP712_DOMAIN,
      EIP712_TYPES,
      burnIntent
    );

    const res = await fetch(`${getGatewayApiBaseUrl()}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ burnIntent, signature }]),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[Gateway] /transfer error:", res.status, text);
      return { success: false };
    }

    const json = (await res.json()) as { attestation?: string; signature?: string };
    const attestation = json?.attestation;
    const operatorSig = json?.signature;

    if (!attestation || !operatorSig) {
      console.error("[Gateway] Missing attestation or signature in /transfer response");
      return { success: false };
    }

    const minter = new ethers.Contract(destinationChain.gatewayMinter, GATEWAY_MINTER_ABI, destWallet);
    const mintTx = await minter.gatewayMint(attestation, operatorSig);
    const receipt = await mintTx.wait();

    console.log(`[Gateway] Minted ${ethers.formatUnits(amount, 6)} USDC on ${destinationChain.name}`);
    logExplorerTx(destinationChain.name, receipt.hash, "Gateway mint");
    return { success: true, txHash: receipt.hash, mocked: false };
  } catch (error) {
    console.log(`[Gateway] Transfer failed from ${sourceChain.name} to ${destinationChain.name}:`, error);
    return { success: false };
  }
}

// ============================================================
// Contract Helpers
// ============================================================
function getVaultContract(ctx: PluginContext) {
  const provider = new ethers.JsonRpcProvider(ctx.arcRpcUrl);
  const signer = new ethers.Wallet(ctx.privateKey, provider);
  return new ethers.Contract(ctx.vaultAddress, TREASURY_VAULT_ABI, signer);
}

function findChainConfig(ctx: PluginContext, chainName: string): ChainConfig | undefined {
  return ctx.gatewayChains.find(c => c.name === chainName);
}

// ============================================================
// Plugin Implementation
// ============================================================
export const gatewayYieldPlugin: Plugin = {
  name: "gateway-yield",

  async monitor(ctx: PluginContext): Promise<YieldOpportunity[]> {
    if (isBaseSepoliaDemoEnabled()) {
      const aaveApy = await fetchCompoundBaseSepoliaSupplyApy();
      return [
        {
          front: "arc",
          yield: 5.0,
          confidence: 0.6,
          source: "arc-baseline",
          strategy: "DeFi_Yield",
        },
        {
          front: "base",
          yield: aaveApy,
          confidence: 0.8,
          source: "CompoundIII",
          strategy: "DeFi_Yield",
        },
      ];
    }

    // Get yield opportunities from all supported chains
    const chainYields = await getDefiLlamaChainYields();
    if (chainYields.length === 0) {
      console.log("[Gateway] No yield data available, skipping gateway opportunities");
      return [];
    }

    // Check for positions ready to return
    const readyToReturn = Array.from(crossChainPositions.values()).filter(
      (p) => Date.now() - p.depositTime >= MIN_HOLD_TIME_MS
    );
    if (readyToReturn.length > 0) {
      console.log(`[Gateway] ${readyToReturn.length} cross-chain position(s) ready to return`);
    }

    return chainYields.map(cy => ({
      front: cy.chain,
      yield: cy.apy,
      confidence: 0.8, // Mock confidence
      source: cy.protocol,
      strategy: "DeFi_Yield",
    }));
  },

  async evaluate(opportunities: YieldOpportunity[], ctx: PluginContext): Promise<boolean> {
    if (isBaseSepoliaDemoEnabled()) {
      return true;
    }

    const gatewayChains = new Set(ctx.gatewayChains.map((c) => c.name));

    // Find Arc yield (our home chain) from gateway-supported opps
    const arcOpp = opportunities.find(
      (o) => o.front === "arc" && (!o.strategy || o.strategy === "DeFi_Yield")
    );
    if (!arcOpp) return false;

    // Find best yield on other chains
    const otherChainOpps = opportunities.filter(
      (o) =>
        o.front !== "arc" &&
        gatewayChains.has(o.front) &&
        (!o.strategy || o.strategy === "DeFi_Yield")
    );
    const bestOther = otherChainOpps.reduce((best, curr) =>
      curr.yield > best.yield ? curr : best,
      { yield: 0, front: "", confidence: 0, source: "" }
    );

    // Check if there are positions to return
    const hasReturnablePositions = Array.from(crossChainPositions.values()).some(
      (p) => Date.now() - p.depositTime >= MIN_HOLD_TIME_MS
    );

    // Should act if:
    // 1. Better yield elsewhere (by threshold amount)
    // 2. OR we have positions ready to return
    const yieldDiff = bestOther.yield - arcOpp.yield;
    const shouldBridge = yieldDiff >= YIELD_DIFF_THRESHOLD;

    if (shouldBridge) {
      console.log(
        `[Gateway] Found better yield on ${bestOther.front}: ${bestOther.yield.toFixed(2)}% vs Arc ${arcOpp.yield.toFixed(2)}% (diff: +${yieldDiff.toFixed(2)}%)`
      );
    }

    return shouldBridge || hasReturnablePositions;
  },

  async execute(ctx: PluginContext): Promise<RebalanceAction[]> {
    const vault = getVaultContract(ctx);
    const actions: RebalanceAction[] = [];
    const provider = new ethers.JsonRpcProvider(ctx.arcRpcUrl);
    const signer = new ethers.Wallet(ctx.privateKey, provider);

    // ============================================================
    // Phase 1: Return mature cross-chain positions to Arc
    // ============================================================
    for (const [posKey, position] of crossChainPositions.entries()) {
      if (Date.now() - position.depositTime < MIN_HOLD_TIME_MS) {
        const remainingSecs = Math.ceil((MIN_HOLD_TIME_MS - (Date.now() - position.depositTime)) / 1000);
        console.log(`[Gateway] Position for ${position.user.slice(0, 10)}... on ${position.destinationChain} needs ${remainingSecs}s more`);
        continue;
      }

      console.log(`[Gateway] Returning position from ${position.destinationChain} to Arc for ${position.user.slice(0, 10)}...`);

      const destChain = findChainConfig(ctx, position.destinationChain);
      const arcChain = findChainConfig(ctx, "arc");

      if (!destChain || !arcChain) {
        console.log(`[Gateway] Chain config not found, cannot return position`);
        continue;
      }

      // If funds are parked in Base vault, withdraw them first
      if (destChain.name === "base") {
        const withdrawResult = await withdrawFromBaseVault(ctx, position.amount);
        if (!withdrawResult.success) {
          console.log("[Gateway] Base vault withdraw failed, skipping return");
          continue;
        }
        if (withdrawResult.amountWithdrawn) {
          position.amount = withdrawResult.amountWithdrawn;
        }
      }

      // Step 1: Deposit to Gateway on destination chain
      const depositResult = await depositToGateway(ctx, destChain, position.amount);
      if (!depositResult.success) {
        console.log(`[Gateway] Return deposit failed on ${destChain.name}, skipping`);
        continue;
      }

      actions.push({
        type: "bridge",
        chain: position.destinationChain,
        amount: position.amount,
        details: {
          direction: "return-deposit",
          from: position.destinationChain,
          to: "arc",
          mocked: depositResult.mocked,
        },
        txHash: depositResult.txHash,
      });

      // Step 2: Transfer via Gateway to Arc (account for fee)
      const destDomain = CHAIN_DOMAINS[destChain.name] ?? 0;
      const balance = await getGatewayBalance(await signer.getAddress(), destDomain);
      const maxFee = getGatewayMaxFee();
      let amountToReturn = position.amount;
      const required = amountToReturn + maxFee;
      if (balance < required) {
        const adjusted = balance - maxFee;
        if (adjusted <= 0n) {
          console.log(
            `[Gateway] Insufficient unified balance on ${destChain.name} for fee. ` +
            `Balance=${ethers.formatUnits(balance, 6)} Fee=${ethers.formatUnits(maxFee, 6)}`
          );
          continue;
        }
        amountToReturn = adjusted;
        console.log(
          `[Gateway] Adjusting return amount to ${ethers.formatUnits(amountToReturn, 6)} ` +
          `to cover fee (maxFee=${ethers.formatUnits(maxFee, 6)})`
        );
      }

      const transferResult = await transferViaGateway(ctx, destChain, arcChain, amountToReturn);
      if (!transferResult.success) {
        console.log(`[Gateway] Transfer back to Arc failed, skipping repay`);
        continue;
      }

      // Step 3: Repay vault (no simulated profit until real yield protocols)
      const profit = 0n;
      const totalReturn = position.amount;

      try {
        const borrowed = await vault.getBorrowedRWA(position.user);
        if (borrowed.amount === 0n) {
          console.log(`[Gateway] No borrowed RWA for ${position.user.slice(0, 10)}..., skipping repay`);
          continue;
        }

        const repayAmount = totalReturn > borrowed.amount ? borrowed.amount : totalReturn;

        const repayTx = await vault.repayRWAFor(position.user, repayAmount);
        const receipt = await repayTx.wait();

        actions.push({
          type: "repay",
          chain: "arc",
          amount: repayAmount,
          details: {
            user: position.user,
            profit: profit.toString(),
            fromChain: position.destinationChain,
            mocked: false,
          },
          txHash: receipt.hash,
        });

        console.log(`[Gateway] Repaid ${ethers.formatUnits(totalReturn, 6)} USDC via Gateway`);
      } catch (error) {
        console.error(`[Gateway] Repay failed:`, error);
      }

      crossChainPositions.delete(posKey);
    }

    // ============================================================
    // Phase 2: Find new cross-chain opportunities
    // ============================================================

    let arcYield = 5.0;
    let bestYield = { chain: "", apy: 0, protocol: "", tvl: 0 };

    if (isBaseSepoliaDemoEnabled()) {
      const cometApy = await fetchCompoundBaseSepoliaSupplyApy();
      bestYield = { chain: "base", apy: cometApy, protocol: "CompoundIII", tvl: 0 };
    } else {
      // Get current yields
      const chainYields = await getDefiLlamaChainYields();
      arcYield = chainYields.find(c => c.chain === "arc")?.apy || 5.0;

      bestYield = chainYields.reduce((best, curr) =>
        curr.apy > best.apy && curr.chain !== "arc" ? curr : best,
        { chain: "", apy: 0, protocol: "", tvl: 0 }
      );

      if (bestYield.apy - arcYield < YIELD_DIFF_THRESHOLD) {
        console.log(`[Gateway] No cross-chain opportunity (best: ${bestYield.chain} ${bestYield.apy.toFixed(2)}% vs Arc ${arcYield.toFixed(2)}%)`);
        return actions;
      }
    }

    // Look for depositors with cross-chain policy
    const depositFilter = vault.filters.Deposited();
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 5000);
    const events = await vault.queryFilter(depositFilter, fromBlock, currentBlock);

    const depositors = [...new Set(
      events
        .filter((e): e is ethers.EventLog => "args" in e)
        .map((e) => e.args[0] as string)
    )];

    console.log(`[Gateway] Checking ${depositors.length} depositor(s) for cross-chain opportunities`);

    for (const user of depositors) {
      try {
        // Skip if already has cross-chain position
        const posKey = `${user}-gateway`;
        if (crossChainPositions.has(posKey)) {
          console.log(`[Gateway] ${user.slice(0, 10)}... already has cross-chain position`);
          continue;
        }

        const [amount, , active] = await vault.userDeposits(user);
        if (!active) {
          console.log(`[Gateway] ${user.slice(0, 10)}... deposit inactive, skipping`);
          continue;
        }

        const policy = await vault.getPolicy(user);
        if (!isBaseSepoliaDemoEnabled()) {
          if (!policy.enabled) continue;

          // Check if strategy includes DeFi or cross-chain
          // Strategy values: "DeFi_Yield", "RWA_Loan", "Stablecoin_Carry"
          if (policy.strategy !== "DeFi_Yield" && policy.strategy !== "Stablecoin_Carry") {
            // Only DeFi_Yield and Stablecoin_Carry use cross-chain
            continue;
          }
        }

        // Check if already borrowed for this user
        const borrowed = await vault.getBorrowedRWA(user);
        const hasBorrowed = borrowed.amount > 0n;

        // Calculate borrow amount (25% of deposit for cross-chain, more conservative)
        const maxBorrow = policy.maxBorrowAmount;
        const quarterDeposit = amount / 4n;
        const borrowAmount =
          maxBorrow > 0n ? (maxBorrow < quarterDeposit ? maxBorrow : quarterDeposit) : quarterDeposit;

        if (borrowAmount === 0n && !hasBorrowed) {
          console.log(`[Gateway] ${user.slice(0, 10)}... borrow amount is 0, skipping`);
          continue;
        }

        console.log(`[Gateway] Processing ${user.slice(0, 10)}... for cross-chain to ${bestYield.chain}`);

        // Step 1: Borrow from vault (skip if already borrowed and demo enabled)
        let effectiveBorrow = borrowAmount;
        let borrowTxHash: string | undefined;
        if (isBaseSepoliaDemoEnabled()) {
          if (hasBorrowed) {
            effectiveBorrow = borrowed.amount;
            console.log(
              `[Gateway] ${user.slice(0, 10)}... already borrowed ${ethers.formatUnits(effectiveBorrow, 6)} USDC, reusing for demo`
            );
          } else {
            effectiveBorrow = ethers.parseUnits(getBaseSepoliaDemoAmount(), 6);
            console.log(
              `[Gateway] Demo mode borrowing ${ethers.formatUnits(effectiveBorrow, 6)} USDC (override)`
            );
            const borrowTx = await vault.borrowRWA(user, effectiveBorrow, ctx.usdcAddress);
            const borrowReceipt = await borrowTx.wait();
            borrowTxHash = borrowReceipt.hash;

            actions.push({
              type: "borrow",
              chain: "arc",
              amount: effectiveBorrow,
              details: { user, strategy: "DeFi_Yield", destination: bestYield.chain },
              txHash: borrowReceipt.hash,
            });

            console.log(`[Gateway] Borrow tx: ${borrowReceipt.hash}`);
            logExplorerTx("arc", borrowReceipt.hash, "Vault borrow");
          }
        } else {
          const borrowTx = await vault.borrowRWA(user, borrowAmount, ctx.usdcAddress);
          const borrowReceipt = await borrowTx.wait();
          borrowTxHash = borrowReceipt.hash;

          actions.push({
            type: "borrow",
            chain: "arc",
            amount: borrowAmount,
            details: { user, strategy: "DeFi_Yield", destination: bestYield.chain },
            txHash: borrowReceipt.hash,
          });

          console.log(`[Gateway] Borrow tx: ${borrowReceipt.hash}`);
          logExplorerTx("arc", borrowReceipt.hash, "Vault borrow");
        }

        // Step 2: Bridge to best yield chain via Gateway
        const arcChain = findChainConfig(ctx, "arc");
        const destChain = findChainConfig(ctx, bestYield.chain);

        let bridgeMocked = false;
        let depositTxHash: string | undefined;
        let amountToTransfer = effectiveBorrow;
        if (arcChain && destChain) {
          const arcDomain = CHAIN_DOMAINS[arcChain.name] ?? 0;
          const balance = await getGatewayBalance(await signer.getAddress(), arcDomain);
          if (balance < effectiveBorrow) {
            const depositResult = await depositToGateway(ctx, arcChain, effectiveBorrow);
            bridgeMocked = depositResult.mocked || false;
            if (!depositResult.success) {
              console.log(`[Gateway] Bridge deposit failed, skipping position creation`);
              continue;
            }
            depositTxHash = depositResult.txHash;
          }

          const maxFee = getGatewayMaxFee();
          const required = amountToTransfer + maxFee;
          if (balance < required) {
            const adjusted = balance - maxFee;
            if (adjusted <= 0n) {
              console.log(
                `[Gateway] Insufficient unified balance for fee. Balance=${ethers.formatUnits(balance, 6)} ` +
                `Fee=${ethers.formatUnits(maxFee, 6)}. Lower GATEWAY_MAX_FEE or deposit more.`
              );
              continue;
            }
            amountToTransfer = adjusted;
            console.log(
              `[Gateway] Adjusting transfer amount to ${ethers.formatUnits(amountToTransfer, 6)} ` +
              `to cover fee (maxFee=${ethers.formatUnits(maxFee, 6)})`
            );
          }

          const transferResult = await transferViaGateway(ctx, arcChain, destChain, amountToTransfer);
          bridgeMocked = transferResult.mocked || false;
          if (!transferResult.success) {
            console.log(`[Gateway] Transfer via Gateway failed, skipping position creation`);
            continue;
          }

          actions.push({
            type: "bridge",
            chain: destChain.name,
            amount: amountToTransfer,
            details: {
              direction: "unified-transfer",
              from: arcChain.name,
              to: destChain.name,
              protocol: bestYield.protocol,
              mocked: bridgeMocked,
            },
            txHash: transferResult.txHash,
          });
          logExplorerTx(destChain.name, transferResult.txHash, "Gateway transfer");
        }

        // Track position
        crossChainPositions.set(posKey, {
          user,
          sourceChain: "arc",
          destinationChain: bestYield.chain,
          amount: amountToTransfer,
          depositTime: Date.now(),
          depositTxHash,
        });

        console.log(
          `[Gateway] Bridged ${ethers.formatUnits(amountToTransfer, 6)} USDC to ${bestYield.chain} ` +
          `for ${bestYield.protocol} (${bestYield.apy.toFixed(2)}% APY)` +
          (bridgeMocked ? " [SIMULATED]" : "")
        );

        if (bestYield.chain === "base") {
          const baseChain = findChainConfig(ctx, "base");
          if (!baseChain) {
            console.log("[Gateway] Base chain config missing, skipping vault deposit");
            continue;
          }

          const depositResult = await depositToBaseVault(ctx, baseChain, amountToTransfer, { user });
          if (depositResult.success) {
            const deposited = depositResult.amountDeposited ?? amountToTransfer;
            actions.push({
              type: "deposit",
              chain: "base-sepolia",
              amount: deposited,
              details: {
                protocol: "BaseVault",
                vault: ctx.baseVaultAddress,
                depositBps: getBaseVaultDepositBps(),
              },
              txHash: depositResult.txHash,
            });
            const currentPos = crossChainPositions.get(posKey);
            if (currentPos) {
              currentPos.amount = deposited;
            }
            if (deposited !== amountToTransfer) {
              console.log(
                `[Gateway] Base vault deposit used ${ethers.formatUnits(deposited, 6)} ` +
                `of ${ethers.formatUnits(amountToTransfer, 6)} USDC`
              );
            }
          } else {
            console.log("[Gateway] Base vault deposit failed after transfer");
          }
        }

      } catch (error) {
        console.error(`[Gateway] Error processing ${user}:`, error);
      }
    }

    // ============================================================
    // Phase 3: Base Sepolia demo allocation (Aave mock)
    // ============================================================
    if (isBaseSepoliaDemoEnabled()) {
      console.log("[Base Sepolia] Demo mode enabled (gateway + Aave flow)");
    }

    return actions;
  },
};
