import dotenv from "dotenv";
import { Plugin, PluginContext, YieldOpportunity } from "./types.js";
import { arcRebalancePlugin } from "./plugins/arc-rebalance.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pluginsConfig = require("./plugins.json");

dotenv.config({ path: "../../.env" });

// ============================================================
// Plugin Registry
// ============================================================

const PLUGIN_REGISTRY: Record<string, Plugin> = {
  "arc-rebalance": arcRebalancePlugin,
  // Phase 2:
  // "lifi-bridge": lifiBridgePlugin,
  // "sui-yield": suiYieldPlugin,
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

  constructor() {
    this.plugins = loadActivePlugins();

    this.ctx = {
      arcRpcUrl: process.env.ARC_RPC_URL || "https://sepolia.arc.build/rpc",
      vaultAddress: process.env.ARC_VAULT_ADDRESS || "",
      usdcAddress: process.env.ARC_USDC_ADDRESS || "",
      privateKey: process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || "",
      storkApiKey: process.env.STORK_API_KEY || "",
      pollInterval: parseInt(process.env.AGENT_POLL_INTERVAL || "300000"),
    };

    this.pollInterval = this.ctx.pollInterval;

    if (!this.ctx.vaultAddress) {
      console.warn("[Agent] WARNING: ARC_VAULT_ADDRESS not set — deploy the vault first");
    }
    if (!this.ctx.privateKey) {
      console.warn("[Agent] WARNING: PRIVATE_KEY not set — agent cannot sign transactions");
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
agent.start();

process.on("SIGINT", () => agent.shutdown());
process.on("SIGTERM", () => agent.shutdown());
