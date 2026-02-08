import dotenv from "dotenv";
import { Plugin, PluginContext, YieldOpportunity, ChainConfig, SuiConfig, RebalanceAction } from "./types.js";
import { arcRebalancePlugin } from "./plugins/arc-rebalance.js";
import { gatewayYieldPlugin } from "./plugins/gateway-yield.js";
import { suiYieldPlugin, getPendingWormholeBridges, type PendingBridgeStatus } from "./plugins/sui-yield.js";
import { createRequire } from "module";
import { ethers } from "ethers";
import { TREASURY_VAULT_ABI } from "./abi/TreasuryVault.js";
import { initAgentApi, pushLog, setAgentState, type Position, type Signal } from "./utils/agent-api.js";
import { AgentStorage } from "./utils/agent-storage.js";
import { getExplorerTxBase } from "./utils/tx-links.js";
const require = createRequire(import.meta.url);
const pluginsConfig = require("./plugins.json");
const rawLog = console.log.bind(console);
const rawWarn = console.warn.bind(console);
const rawError = console.error.bind(console);

dotenv.config({ path: "../../.env" });

// ============================================================
// Gateway Chain Configurations
// ============================================================

const GATEWAY_CHAINS: ChainConfig[] = [
  {
    name: "arc",
    chainId: 5042002,
    rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
    usdcAddress: process.env.ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  },
  {
    name: "ethereum",
    chainId: 11155111,
    rpcUrl: process.env.ETH_SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    usdcAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Sepolia USDC
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  },
  {
    name: "base",
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia USDC
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  },
  {
    name: "avalanche",
    chainId: 43113,
    rpcUrl: process.env.AVAX_FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
    usdcAddress: "0x5425890298aed601595a70AB815c96711a31Bc65", // Fuji USDC
    gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    gatewayMinter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  },
];

// ============================================================
// Plugin Registry
// ============================================================

const PLUGIN_REGISTRY: Record<string, Plugin> = {
  "arc-rebalance": arcRebalancePlugin,
  "gateway-yield": gatewayYieldPlugin,
  "sui-yield": suiYieldPlugin,
};

type ActionEntry = { time: string; plugin: string; action: RebalanceAction };
const ACTION_HISTORY_LIMIT = Number(process.env.AGENT_ACTION_BUFFER || "50");
const actionHistory: ActionEntry[] = [];

function formatAmount(amount: bigint, decimals = 6): string {
  return Number(ethers.formatUnits(amount, decimals)).toFixed(2);
}

function normalizeChainForExplorer(chain: string): string {
  if (chain.includes("base")) return "base";
  if (chain.includes("arc")) return "arc";
  if (chain.includes("eth")) return "ethereum";
  if (chain.includes("avax") || chain.includes("avalanche")) return "avalanche";
  return chain;
}

function formatTxLink(chain: string, txHash?: string): string {
  if (!txHash) return "";
  const normalized = normalizeChainForExplorer(chain);
  const base = getExplorerTxBase(normalized);
  if (!base) return txHash;
  return `${base}${txHash}`;
}

function shortUser(user?: string): string {
  if (!user) return "unknown";
  return `${user.slice(0, 6)}...${user.slice(-4)}`;
}

function formatActionPosition(action: RebalanceAction): Position {
  const details = action.details || {};
  const mocked = Boolean(details.mocked);
  const protocol = typeof details.protocol === "string" ? details.protocol : undefined;
  const user = typeof details.user === "string" ? details.user : undefined;
  const amountLabel = formatAmount(action.amount);
  const chainLabel = action.chain || "unknown";
  const txLink = formatTxLink(chainLabel, action.txHash);
  const txSuffix = txLink ? ` · Tx ${txLink}` : "";
  const stage = typeof details.stage === "string" ? details.stage : undefined;

  const status = mocked ? "Simulated" : "Recorded";
  const tone = mocked ? "amber" : "emerald";

  switch (action.type) {
    case "borrow":
      return {
        name: "Vault Borrow",
        status,
        detail: `User ${shortUser(user)} · Borrowed ${amountLabel} USDC on ${chainLabel}${txSuffix}`,
        tone,
        user,
      };
    case "repay":
      return {
        name: "Vault Repay",
        status,
        detail: `User ${shortUser(user)} · Repaid ${amountLabel} USDC via ${chainLabel}${txSuffix}`,
        tone,
        user,
      };
    case "bridge": {
      const from = typeof details.from === "string" ? details.from : "source";
      const to = typeof details.to === "string" ? details.to : "destination";
      const stageLabel = stage === "burn" ? "Gateway Burn" : stage === "mint" ? "Gateway Mint" : "Bridge Transfer";
      return {
        name: stageLabel,
        status,
        detail: `Bridged ${amountLabel} USDC ${from} → ${to}` +
          (protocol ? ` · ${protocol}` : "") +
          (stage ? ` · ${stage.toUpperCase()}` : "") +
          txSuffix,
        tone,
        user,
      };
    }
    case "deposit": {
      const asset = typeof details.asset === "string" ? details.asset : "USDC";
      if (protocol === "DeepBook") {
        const pool = typeof details.pool === "string" ? details.pool : "DeepBook";
        const apy = typeof details.apy === "number" ? details.apy.toFixed(2) : undefined;
        return {
          name: "DeepBook Liquidity",
          status,
          detail: `User ${shortUser(user)} · ${amountLabel} ${asset} → ${pool}${apy ? ` · ${apy}% APY` : ""}${txSuffix}`,
          tone,
          user,
        };
      }
      if (protocol === "BaseVault") {
        return {
          name: "Base Vault Deposit",
          status,
          detail: `Deposited ${amountLabel} USDC on ${chainLabel}${txSuffix}`,
          tone,
          user,
        };
      }
      return {
        name: "Yield Deposit",
        status,
        detail: `Deposited ${amountLabel} ${asset} on ${chainLabel}${txSuffix}`,
        tone,
        user,
      };
    }
    case "withdraw":
      return {
        name: "Withdraw Processed",
        status,
        detail: `User ${shortUser(user)} · ${amountLabel} USDC withdrawn on ${chainLabel}${txSuffix}`,
        tone,
        user,
      };
    case "order":
      return {
        name: "Order Placement",
        status,
        detail: `Placed order on ${chainLabel} · ${amountLabel} USDC${txSuffix}`,
        tone,
        user,
      };
    default:
      return {
        name: "Agent Action",
        status,
        detail: `Executed ${action.type} on ${chainLabel}${txSuffix}`,
        tone,
        user,
      };
  }
}

function formatPendingBridgePosition(pending: PendingBridgeStatus): Position {
  const elapsedMs = Date.now() - pending.startedAt;
  const elapsedMin = Math.max(0, Math.floor(elapsedMs / 60000));
  const elapsedSec = Math.max(0, Math.floor((elapsedMs % 60000) / 1000));
  const elapsed = `${elapsedMin}m ${elapsedSec}s`;
  const wormholeNetwork = (process.env.WORMHOLE_NETWORK || "Mainnet").toLowerCase();
  const networkParam = wormholeNetwork === "testnet" ? "Testnet" : "Mainnet";
  const txLink = pending.txHash
    ? `https://wormholescan.io/#/tx/${pending.txHash}?network=${networkParam}`
    : "";
  return {
    name: "Pending Wormhole Bridge",
    status: "In Transit",
    detail: `User ${shortUser(pending.user)} · ${formatAmount(pending.amount)} USDC Base → Sui · Elapsed ${elapsed}` +
      (txLink ? ` · WormholeScan ${txLink}` : ""),
    tone: "amber",
    user: pending.user,
  };
}

function formatActionLog(pluginName: string, action: RebalanceAction): string {
  const details = action.details || {};
  const protocol = typeof details.protocol === "string" ? details.protocol : undefined;
  const user = typeof details.user === "string" ? details.user : undefined;
  const stage = typeof details.stage === "string" ? details.stage : undefined;
  const amountLabel = formatAmount(action.amount);
  const txLabel = action.txHash ? `tx ${action.txHash.slice(0, 10)}...` : "tx pending";

  switch (action.type) {
    case "borrow":
      return `[Action] Borrow - ${shortUser(user)} borrowed ${amountLabel} USDC on ${action.chain} · ${txLabel}`;
    case "repay":
      return `[Action] Repay - ${shortUser(user)} repaid ${amountLabel} USDC on ${action.chain} · ${txLabel}`;
    case "bridge": {
      const from = typeof details.from === "string" ? details.from : "source";
      const to = typeof details.to === "string" ? details.to : "destination";
      const stageLabel = stage ? ` ${stage.toUpperCase()}` : "";
      return `[Action] Bridge${stageLabel} - ${amountLabel} USDC ${from} → ${to}` +
        `${protocol ? ` (${protocol})` : ""} · ${txLabel}`;
    }
    case "deposit":
      return `[Action] Deposit - ${amountLabel} USDC on ${action.chain}${protocol ? ` (${protocol})` : ""} · ${txLabel}`;
    case "withdraw":
      return `[Action] Withdraw - ${amountLabel} USDC on ${action.chain} · ${txLabel}`;
    case "order":
      return `[Action] Order - ${amountLabel} USDC on ${action.chain} · ${txLabel}`;
    default:
      return `[Action] ${action.type} - ${amountLabel} USDC on ${action.chain} · ${txLabel}`;
  }
}

function recordAction(pluginName: string, action: RebalanceAction): void {
  actionHistory.unshift({ time: new Date().toISOString(), plugin: pluginName, action });
  if (actionHistory.length > ACTION_HISTORY_LIMIT) actionHistory.pop();
  const line = formatActionLog(pluginName, action);
  const user = typeof action.details?.user === "string" ? String(action.details.user) : undefined;
  pushLog(line, { relevant: true, user });
  rawLog(line);
}

function loadActivePlugins(): Plugin[] {
  const active = pluginsConfig.active as string[];
  const plugins: Plugin[] = [];

  for (const name of active) {
    const plugin = PLUGIN_REGISTRY[name];
    if (plugin) {
      plugins.push(plugin);
      console.log(`[Agent] Loaded plugin: ${name}`);
    } else {
      console.warn(`[Agent] Plugin "${name}" not found in registry, skipping`);
    }
  }

  return plugins;
}

// ============================================================
// Agent Core
// ============================================================

class TreasuryAgent {
  private plugins: Plugin[];
  private ctx: PluginContext;
  private pollInterval: number;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private storage: AgentStorage | null = null;

  constructor() {
    this.plugins = loadActivePlugins();
    try {
      this.storage = new AgentStorage();
    } catch (error) {
      console.warn("[Agent] Storage unavailable:", error);
      this.storage = null;
    }

    this.ctx = {
      arcRpcUrl: process.env.ARC_RPC_URL || "https://sepolia.arc.build/rpc",
      vaultAddress: process.env.ARC_VAULT_ADDRESS || "",
      usdcAddress: process.env.ARC_USDC_ADDRESS || "",
      baseVaultAddress: process.env.BASE_VAULT_ADDRESS || "",
      privateKey: process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || "",
      storkApiKey: process.env.STORK_API_KEY || "",
      pollInterval: parseInt(process.env.AGENT_POLL_INTERVAL || "300000"),
      // USYC (RWA) addresses
      usycAddress: process.env.ARC_USYC_ADDRESS || "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
      usycTellerAddress: process.env.ARC_USYC_TELLER || "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
      usycEntitlementsAddress: process.env.ARC_USYC_ENTITLEMENTS || "0xcc205224862c7641930c87679e98999d23c26113",
      // Circle Gateway (cross-chain)
      gatewayChains: GATEWAY_CHAINS,
      // Sui integration
      suiConfig: {
        rpcUrl: process.env.SUI_RPC_URL || "https://fullnode.testnet.sui.io:443",
        address: process.env.SUI_ADDRESS,
        usdcPackageId: process.env.SUI_USDC_PACKAGE || "0x2", // Testnet USDC
        usdcTreasuryId: process.env.SUI_USDC_TREASURY || "",
        deepbookPackageId: process.env.SUI_DEEPBOOK_PACKAGE || "0xdee9",
        poolId: process.env.SUI_POOL_ID || "", // USDC/SUI pool
      },
      suiPrivateKey: process.env.SUI_PRIVATE_KEY,
    };

    this.pollInterval = this.ctx.pollInterval;

    if (!this.ctx.vaultAddress) {
      console.warn("[Agent] WARNING: ARC_VAULT_ADDRESS not set — deploy the vault first");
    }
    if (!this.ctx.baseVaultAddress) {
      console.warn("[Agent] WARNING: BASE_VAULT_ADDRESS not set — Base vault deposits disabled");
    }
    console.log(`[Agent] Base vault address: ${this.ctx.baseVaultAddress || "<empty>"}`);
    if (!this.ctx.privateKey) {
      console.warn("[Agent] WARNING: PRIVATE_KEY not set — agent cannot sign transactions");
    }
  }

  private buildActionPositions(): Position[] {
    const pending = getPendingWormholeBridges();
    const pendingPositions = pending.map((p) => formatPendingBridgePosition(p));
    const actionPositions = actionHistory.slice(0, 6).map((entry) => formatActionPosition(entry.action));
    if (pendingPositions.length === 0 && actionPositions.length === 0) return [];
    return [...pendingPositions, ...actionPositions].slice(0, 6);
  }

  private async buildOnchainPositions(): Promise<Position[]> {
    try {
      const provider = new ethers.JsonRpcProvider(this.ctx.arcRpcUrl);
      const signer = new ethers.Wallet(this.ctx.privateKey, provider);
      const vault = new ethers.Contract(this.ctx.vaultAddress, TREASURY_VAULT_ABI, signer);

      const depositFilter = vault.filters.Deposited();
      const currentBlock = await provider.getBlockNumber();
      const fromBlock = Math.max(0, currentBlock - 50_000);

      const events: ethers.EventLog[] = [];
      const step = 10_000;
      for (let start = fromBlock; start <= currentBlock; start += step + 1) {
        const end = Math.min(currentBlock, start + step);
        const chunk = await vault.queryFilter(depositFilter, start, end);
        for (const ev of chunk) {
          if ("args" in ev) events.push(ev as ethers.EventLog);
        }
      }

      const depositors = [...new Set(
        events.map((e) => e.args[0] as string)
      )];

      const positions: Position[] = [];
      const stats = await vault.getVaultStats().catch(() => [0n, 0n, 0n]);
      const tvl = Number(ethers.formatUnits(stats[0] ?? 0n, 6)).toFixed(2);
      const borrows = Number(ethers.formatUnits(stats[1] ?? 0n, 6)).toFixed(2);

      for (const user of depositors) {
        const [deposit, , active] = await vault.userDeposits(user);
        if (!active) continue;
        const borrowed = await vault.getBorrowedRWA(user);
        const policy = await vault.getPolicy(user);

        const depositFmt = Number(ethers.formatUnits(deposit || 0n, 6)).toFixed(2);
        const borrowedFmt = Number(ethers.formatUnits(borrowed.amount || 0n, 6)).toFixed(2);

        positions.push({
          name: `User ${user.slice(0, 6)}...${user.slice(-4)}`,
          status: borrowed.amount > 0n ? "Borrowed" : "Idle",
          detail: `Deposit ${depositFmt} USDC · Borrowed ${borrowedFmt} · ${policy.strategy || "No policy"}`,
          tone: borrowed.amount > 0n ? "amber" : "emerald",
          user,
        });
      }

      if (positions.length === 0) {
        if ((stats[0] ?? 0n) > 0n) {
          positions.push({
            name: "Vault deposits detected",
            status: "Indexing",
            detail: `TVL ${tvl} USDC · Borrows ${borrows} · Waiting on depositor logs`,
            tone: "sky",
          });
          return positions;
        }

        positions.push({
          name: "No active users",
          status: "Idle",
          detail: "Deposit to begin agent management",
          tone: "sky",
        });
      }

      if (this.storage) {
        try {
          const aavePositions = this.storage.listAavePositions();
          for (const pos of aavePositions) {
            const amount = Number(pos.usdcAmount || "0").toFixed(2);
            const apy = Number(pos.apy || 0).toFixed(2);
            positions.push({
              name: `Aave ${pos.chain}`,
              status: pos.status === "active" ? "Active" : pos.status,
              detail: `User ${pos.user.slice(0, 6)}... · Supplied ${amount} USDC · APY ${apy}%`,
              tone: pos.status === "active" ? "emerald" : "amber",
              user: pos.user,
            });
          }
        } catch (error) {
          console.warn("[Agent] Failed to load Aave positions:", error);
        }
      }

      return positions;
    } catch (error) {
      console.error("[Agent] Failed to build positions:", error);
      return [
        {
          name: "Positions unavailable",
          status: "Error",
          detail: "Check agent RPC connectivity",
          tone: "rose",
        },
      ];
    }
  }

  private async buildPositions(): Promise<Position[]> {
    const actionPositions = this.buildActionPositions();
    if (actionPositions.length > 0) return actionPositions;
    return this.buildOnchainPositions();
  }

  async runCycle(): Promise<void> {
    console.log(`\n[Agent] ─── Cycle at ${new Date().toISOString()} ───`);

    // 1. Monitor: gather yield opportunities from all plugins
    const allOpportunities: YieldOpportunity[] = [];

    for (const plugin of this.plugins) {
      try {
        const opps = await plugin.monitor(this.ctx);
        allOpportunities.push(...opps);
        console.log(
          `[${plugin.name}] Found ${opps.length} opportunity(s): ${opps
            .map((o) => `${o.front} ${o.yield.toFixed(2)}%`)
            .join(", ")}`
        );
      } catch (error) {
        console.error(`[${plugin.name}] Monitor error:`, error);
      }
    }

    if (allOpportunities.length === 0) {
      console.log("[Agent] No opportunities found across any front");
      return;
    }

    // 2. Rank opportunities by yield (highest first)
    allOpportunities.sort((a, b) => b.yield - a.yield);
    console.log(
      `[Agent] Best opportunity: ${allOpportunities[0].front} at ${allOpportunities[0].yield.toFixed(2)}%`
    );

    // Log best opportunity per strategy (if provided)
    const bestByStrategy = new Map<string, YieldOpportunity>();
    for (const opp of allOpportunities) {
      const key = opp.strategy || "any";
      const current = bestByStrategy.get(key);
      if (!current || opp.yield > current.yield) {
        bestByStrategy.set(key, opp);
      }
    }
    for (const [strategy, opp] of bestByStrategy.entries()) {
      console.log(
        `[Agent] Best for ${strategy}: ${opp.front} ${opp.yield.toFixed(2)}% (${opp.source})`
      );
    }

    // 3. Evaluate + Execute: let each plugin decide and act
    for (const plugin of this.plugins) {
      try {
        const shouldAct = await plugin.evaluate(allOpportunities, this.ctx);

        if (shouldAct) {
          console.log(`[${plugin.name}] Executing rebalance...`);
          const actions = await plugin.execute(this.ctx);

          for (const action of actions) {
            console.log(
              `[${plugin.name}] ${action.type} on ${action.chain}: ${action.txHash || "pending"}`
            );
            recordAction(plugin.name, action);
          }

          if (actions.length === 0) {
            console.log(`[${plugin.name}] No actionable positions found`);
          }
        }
      } catch (error) {
        console.error(`[${plugin.name}] Execute error:`, error);
      }
    }

    // Update live state for UI
    const signals: Signal[] = [];
    for (const [strategy, opp] of bestByStrategy.entries()) {
      const tone =
        strategy === "RWA_Loan" ? "amber" :
        strategy === "Stablecoin_Carry" ? "sky" :
        "emerald";
      signals.push({
        label: `Best ${strategy}`,
        value: `${opp.front} ${opp.yield.toFixed(2)}%`,
        meta: opp.source,
        tone,
      });
    }

    const positions = await this.buildPositions();
    setAgentState({ signals, positions, lastAction: null });
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("[Agent] TreasuryForge Agent starting");
    console.log(`[Agent] Active plugins: ${this.plugins.map((p) => p.name).join(", ")}`);
    console.log(`[Agent] Poll interval: ${this.pollInterval / 1000}s`);
    console.log(`[Agent] Vault: ${this.ctx.vaultAddress || "(not set)"}`);
    console.log("");

    // Run first cycle immediately
    await this.runCycle();

    // Then poll on interval
    const poll = async () => {
      if (!this.running) return;
      await this.runCycle();
      this.timer = setTimeout(poll, this.pollInterval);
    };
    this.timer = setTimeout(poll, this.pollInterval);
  }

  shutdown(): void {
    console.log("\n[Agent] Shutting down...");
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    process.exit(0);
  }
}

// ============================================================
// Main
// ============================================================

const agent = new TreasuryAgent();
// Capture console output into log buffer for the UI
console.log = (...args: any[]) => {
  const line = args.map(String).join(" ");
  pushLog(line);
  rawLog(...args);
};
console.warn = (...args: any[]) => {
  const line = args.map(String).join(" ");
  pushLog(line);
  rawWarn(...args);
};
console.error = (...args: any[]) => {
  const line = args.map(String).join(" ");
  pushLog(line);
  rawError(...args);
};

initAgentApi();
agent.start();

process.on("SIGINT", () => agent.shutdown());
process.on("SIGTERM", () => agent.shutdown());
