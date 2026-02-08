# TreasuryForge

**Our one-liner: Autonomous USDC treasury optimizer spanning Arc + Sui, with an explainable agent and live ops console.**

TreasuryForge lets teams deposit USDC on Arc, set yield policies, and let an agent route capital into RWA yield (USYC), cross-chain stablecoin carry via Circle Gateway, and DeepBook liquidity on Sui. Every action is streamed to a live UI so users can see exactly why the agent moved funds. We tried to make it a glass box, instead of a black box.

> **IMPORTANT DEMO NOTE — TWO FLOWS**
> **TESTNET FLOW:** Arc testnet + Circle Gateway are used for vault + agent features.  
> **MAINNET FLOW (IN VIDEO):** DeepBook liquidity is not available on Sui testnet, so the demo video shows a mainnet flow with Base → Sui bridging and DeepBook deposits.  
> Once Arc mainnet launches, we can route USDC end‑to‑end using Circle (Arc → Base via unified Gateway, then Base → Sui via CCTP), keeping the entire bridge path on Circle infrastructure.

Built for **ETHGlobal HackMoney 2026** with a focus on:
- Arc prize tracks: chain‑abstracted USDC liquidity, RWA agentic commerce, and treasury systems.
- Sui prize track: DeepBook‑powered DeFi with real order‑book signals.

## Why This Exists
Real treasuries have three problems:
- **Risk‑off markets push teams into stables**, but it’s unclear where to deploy safely for yield.
- **Fragmented liquidity** across chains and venues makes best‑rate routing hard.
- **Opaque automation** turns yield ops into a black box.

I built this in a risk‑off market while sitting on stablecoins I didn’t want to leave idle. Yields move fast, the “best” option changes weekly, and I don’t have time to manage it all. I wanted a system that could watch the market for me, route my stables to the best yield, and show me exactly why it made each move.

TreasuryForge uses Arc testnet and Circle’s unified USDC balance to simplify cross‑chain liquidity. Instead of rebuilding that complexity ourselves, we focus on a vault + agent that does the routing and yield ops for the user—with full transparency.

## What’s Built
- **Arc Treasury Vault (Solidity)**
  - User deposits, policies, and controlled borrows.
  - Agent‑only RWA borrow/repay and withdrawal processing.
- **Autonomous Agent (TypeScript)**
  - Plugin‑based yield engine.
  - Live agent API for UI signals, positions, and logs.
- **Sui Treasury Module (Move)**
  - DeepBook pool deposits, maker orders, and PTB‑composable rebalancing.
- **Ops Console (React)**
  - Deposit + policy UI, live signals, positions, and agent feed.


# AI Tools Used
- We use AI tools to generate moment diagrams and architecture diagrams because it is faster and clearer.
- We use AI to audit the code as much as possible.
- We use AI for front-end generation since I’m not a strong front-end developer.

## Architecture (One‑Page)
See the full diagram in `docs/architecture.md`.

High‑level flow:
1. User deposits USDC on Arc and sets a policy.
2. Agent scans yields and chooses the best strategy.
3. Agent borrows from vault and allocates:
   - USYC (RWA) on Arc.
   - Cross‑chain USDC via Circle Gateway.
   - Sui DeepBook liquidity via Wormhole CCTP.
4. Profits return to Arc and are repaid to the vault.
5. UI shows every step in real time.

## Hackathon Alignment
### Arc Prize Tracks
- **Best Chain‑Abstracted USDC Apps**
  - Circle Gateway integration to move USDC across Arc, Base Sepolia, Ethereum Sepolia, Avalanche Fuji.
  - Unified agent logic treats multiple chains as one liquidity surface.
- **Build Global Payouts and Treasury Systems**
  - Vault + policy system for treasury management and controlled withdrawals.
- **Best Agentic Commerce App Powered by RWAs**
  - USYC integration with Stork‑informed yield policy and autonomous repay.

### Sui Prize Track
- DeepBook pool operations and order‑book‑derived yield signals.
- Sui treasury module designed for PTB‑composable rebalancing.

## Quick Start
```bash
# 1. Setup
cp .env.example .env

# 2. Deploy Arc vault (Foundry)
cd contracts/arc
forge script script/DeployTreasuryVault.s.sol:DeployTreasuryVault --rpc-url arc --broadcast

# 3. Start agent
cd ../../packages/agent
npm install
npm run dev

# 4. Start frontend
cd ../../apps/web
npm install
npm run dev
```

### Optional: Base Sepolia Vault (for Circle Gateway demo)
```bash
cd contracts/arc
forge script script/DeployTreasuryVaultBase.s.sol:DeployTreasuryVaultBase --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --dotenv-path ../../.env
```

### Optional: Bridge USDC Base → Sui + DeepBook (Mainnet)
```bash
cd packages/agent
npm run bridge:base-sui-deepbook

# Resume if transfer already initiated
npm run bridge:base-sui-deepbook -- --resume
```

### Optional: Stargate Base → Sui + DeepBook (Mainnet)
```bash
cd packages/agent
npm run bridge:stargate-base-sui-deepbook
```

## Repo Map
```
TreasuryForge/
├── apps/web                # React ops console
├── contracts/arc           # Arc Solidity vault (Foundry)
├── contracts/sui           # Sui treasury + DeepBook Move module
├── packages/agent          # Autonomous agent + plugins
├── docs/architecture.md    # System diagram
└── scripts                 # Demo helpers and guides
```

## Agent Plugins
- `arc-rebalance`
  - Uses Stork oracle to decide when to borrow for USYC yield.
  - Simulates USYC if agent isn’t allowlisted.
- `gateway-yield`
  - Queries yields (DefiLlama + Aave fallback) and routes USDC via Circle Gateway.
  - Demo mode on Base Sepolia with adjustable APY.
- `sui-yield`
  - Computes DeepBook spread‑based yield signals.
  - Bridges USDC to Sui and deposits into DeepBook pools.

## Deployed (Arc Testnet)
Replace if you redeploy.

| Contract | Address |
|----------|---------|
| TreasuryVault | `0x7d5561636c5c78e85997cfb53da79b74b9a16f93` |
| USDC | `0x3600000000000000000000000000000000000000` |
| USYC Token | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| USYC Teller | `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` |

## Environment
See `.env.example` for the full list. Minimum to demo:
- `ARC_RPC_URL`
- `ARC_VAULT_ADDRESS`
- `ARC_USDC_ADDRESS`
- `PRIVATE_KEY`

Optional integrations:
- `STORK_API_KEY` (RWA yield)
- `BASE_SEPOLIA_RPC_URL` and `BASE_VAULT_ADDRESS` (Circle Gateway demo)
- `SUI_PRIVATE_KEY` or `SUI_MNEMONIC` (DeepBook demo)

## Testing
```bash
cd contracts/arc
forge test -vv
```

## Resources
- Architecture diagram: `docs/architecture.md`
- DeepBook margin guide: `scripts/DEEPBOOK_MARGIN_YIELD.md`



---

**TreasuryForge — Built for ETHGlobal HackMoney 2026**
