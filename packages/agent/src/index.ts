import dotenv from "dotenv";
import { Plugin, PluginContext, YieldOpportunity, ChainConfig, SuiConfig } from "./types.js";
import { arcRebalancePlugin } from "./plugins/arc-rebalance.js";
import { gatewayYieldPlugin } from "./plugins/gateway-yield.js";
import { suiYieldPlugin } from "./plugins/sui-yield.js";
import { createRequire } from "module";
import { ethers } from "ethers";
import { TREASURY_VAULT_ABI } from "./abi/TreasuryVault.js";
import { initAgentApi, pushLog, setAgentState, type Position, type Signal } from "./utils/agent-api.js";
import { AgentStorage } from "./utils/agent-storage.js";
const require = createRequire(import.meta.url);
const pluginsConfig = require("./plugins.json");

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
    if (!this.ctx.privateKey) {
      console.warn("[Agent] WARNING: PRIVATE_KEY not set — agent cannot sign transactions");
    }
  }

  private async buildPositions(): Promise<Position[]> {
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
const originalLog = console.log.bind(console);
const originalWarn = console.warn.bind(console);
const originalError = console.error.bind(console);
console.log = (...args: any[]) => {
  const line = args.map(String).join(" ");
  pushLog(line);
  originalLog(...args);
};
console.warn = (...args: any[]) => {
  const line = args.map(String).join(" ");
  pushLog(line);
  originalWarn(...args);
};
console.error = (...args: any[]) => {
  const line = args.map(String).join(" ");
  pushLog(line);
  originalError(...args);
};

initAgentApi();
agent.start();

process.on("SIGINT", () => agent.shutdown());
process.on("SIGTERM", () => agent.shutdown());
