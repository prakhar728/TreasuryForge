# TreasuryForge

**Autonomous RWA-backed treasury optimizer on Circle's Arc chain**

TreasuryForge lets users deposit USDC, set yield policies, and let an AI agent autonomously manage their funds. The agent monitors yields via Stork oracle, deploys to RWA strategies (USYC - tokenized US Treasury fund), and automatically returns principal + profits.

## Bounty Targets

| Bounty | Prize | Status |
|--------|-------|--------|
| **#3: Agentic Commerce with RWA** | $2,500 | Done |
| **#1: Chain Abstracted USDC Apps** | $5,000 | Done |

## How It Works

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│   User                    Vault                    Agent                   │
│    │                        │                        │                     │
│    │── deposit(USDC) ──────▶│                        │                     │
│    │── setPolicy(RWA) ─────▶│                        │                     │
│    │                        │                        │                     │
│    │                        │◀── monitor events ─────│                     │
│    │                        │                        │                     │
│    │                        │── borrowRWA() ────────▶│                     │
│    │                        │                        │── deposit to USYC   │
│    │                        │                        │                     │
│    │                        │                        │   (yield accrues)   │
│    │                        │                        │                     │
│    │                        │                        │── redeem USYC       │
│    │                        │◀── repayRWA(+yield) ───│                     │
│    │                        │                        │                     │
│    │◀── withdraw(+profit) ──│                        │                     │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Clone and setup
git clone <repo>
cd TreasuryForge
cp .env.example .env

# 2. Deploy vault to Arc testnet
cd contracts/arc
forge script script/DeployTreasuryVault.s.sol:DeployTreasuryVault --rpc-url arc --broadcast

# 2b. Deploy vault to Base Sepolia (Circle USDC parking)
forge script script/DeployTreasuryVaultBase.s.sol:DeployTreasuryVaultBase --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --dotenv-path ../../.env

# 3. Start agent
cd packages/agent
npm install && npm run dev

# 4. Start frontend
cd apps/web
npm install && npm run dev

# (Optional) Wormhole CCTP Base -> Sui + DeepBook deposit (mainnet)
cd packages/agent
npm run bridge:base-sui-deepbook

# Resume mode: skip bridge, just deposit on Sui once funds arrive
cd packages/agent
npm run bridge:base-sui-deepbook -- --resume

# (Optional) Router Nitro Base -> Sui + DeepBook deposit (mainnet)
cd packages/agent
npm run bridge:nitro-base-sui-deepbook
```

## Project Structure

```
TreasuryForge/
├── contracts/
│   └── arc/                    # Solidity contracts (Foundry)
│       └── src/TreasuryVault.sol
├── packages/
│   └── agent/                  # Autonomous agent (TypeScript)
│       └── src/
│           ├── index.ts        # Agent core loop
│           ├── plugins/        # Yield strategy plugins
│           │   └── arc-rebalance.ts  # USYC RWA integration
│           └── abi/            # Contract ABIs
├── apps/
│   └── web/                    # React frontend
│       └── src/
│           └── components/DepositUI.tsx
└── docs/
    └── architecture.md         # Full system documentation
```

## Deployed Contracts (Arc Testnet)

| Contract | Address |
|----------|---------|
| TreasuryVault | `0xfc052abb90f5bd0b0c161105a9e2f9bf933fdffa` |
| USDC | `0x3600000000000000000000000000000000000000` |
| USYC Token | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` |
| USYC Teller | `0x9fdF14c5B14173D74C08Af27AebFf39240dC105A` |

## Agent Plugin Architecture

```typescript
interface Plugin {
  name: string;
  monitor(ctx): Promise<YieldOpportunity[]>;   // Check yields
  evaluate(opps, ctx): Promise<boolean>;       // Decide to act
  execute(ctx): Promise<RebalanceAction[]>;    // Execute trades
}
```

### Current Plugins

**arc-rebalance** (Bounty 3: RWA)
- Monitors Stork oracle for yield rates
- Borrows from vault based on user policies
- Deposits to USYC (tokenized US Treasury fund)
- Auto-redeems and repays with yield

**gateway-yield** (Bounty 1: Cross-chain)
- Uses Circle Gateway for unified USDC balance
- Hunts best yields across Arc, Ethereum Sepolia, Base Sepolia, Avalanche Fuji
- Bridges USDC via GatewayWallet (burn) → GatewayMinter (mint)
- Returns profits to Arc and repays vault

## Key Features

- **Policy-Based Automation**: Users set thresholds, agent executes
- **RWA Integration**: Real yield from US Treasury-backed USYC
- **Mock Fallback**: Works without USYC allowlisting for demo
- **Complete Cycle**: Borrow -> Yield -> Repay (not just deposit)

## Testing

```bash
cd contracts/arc
forge test -vv

# With gas report
forge test --gas-report
```

## Environment Variables

```bash
# Arc Chain
ARC_RPC_URL=https://rpc.testnet.arc.network
ARC_VAULT_ADDRESS=0xfc052abb90f5bd0b0c161105a9e2f9bf933fdffa
ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000

# USYC (RWA)
ARC_USYC_ADDRESS=0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C
ARC_USYC_TELLER=0x9fdF14c5B14173D74C08Af27AebFf39240dC105A

# Agent
PRIVATE_KEY=<agent-wallet-key>
STORK_API_KEY=<stork-key>
AGENT_POLL_INTERVAL=300000

# Base Vault (Circle USDC)
BASE_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
BASE_VAULT_ADDRESS=<base-vault-address>
BASE_VAULT_DEPOSIT_BPS=10000
BASE_VAULT_DEPOSIT_MIN_USDC=1
```

## Resources

- [Architecture Diagram](./docs/architecture.md)
- [Arc Testnet Docs](https://developers.circle.com/w3s/docs/programmable-wallets-overview)
- [USYC Documentation](https://www.hashnote.com/)

## License

MIT

---

**Built for ETHGlobal HackMoney 2026**
