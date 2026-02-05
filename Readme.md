# TreasuryForge 🏦

**An autonomous RWA-backed treasury optimizer agent for ETHGlobal HackMoney 2026**

TreasuryForge enables users to deposit USDC, set yield policies, and let an intelligent agent manage treasury rebalancing across Arc, Sui, and LI.FI. The agent monitors oracle prices, triggers borrowing when profitable, bridges to yield farms, and returns payouts via Circle.

## 🎯 MVP Flow

```
User Deposit USDC → Set Policies → Agent Monitors Oracle → 
Borrow RWA → Bridge to Sui → Rebalance on DeepBook → 
Monitor Yields → Payout via Circle Gateway
```

## 🏗️ Tech Stack

| Component | Technology |
|-----------|-----------|
| **Contracts** | Solidity (Arc), Move (Sui) |
| **Frontend** | React.js + ethers.js + wagmi |
| **Agent** | Node.js, TypeScript, Stork Oracle, LI.FI SDK |
| **Wallet** | Circle Developer-Controlled Wallets |
| **Deployment** | Foundry (Arc), Sui CLI (Sui) |

## 📂 Quick Links

- [Day 1 Setup & Arc Vault](./Day1_SETUP.md) ← **START HERE**
- [Smart Contracts](./contracts/arc/src/)
- [Agent Logic](./packages/agent/src/)
- [Frontend UI](./apps/web/src/)

## 🚀 Quick Start

```bash
# 1. Setup environment
cp .env.example .env
# Edit .env with your keys (Arc RPC, USDC address, etc.)

# 2. Deploy Arc vault
cd contracts/arc
forge test
forge script script/DeployTreasuryVault.s.sol:DeployTreasuryVault \
  --rpc-url arc --broadcast

# 3. Run agent
cd packages/agent
npm install && npm run dev

# 4. Start frontend
cd apps/web
npm install && npm run dev
```

## 📋 Day-by-Day Plan (Feb 4-8)

| Day | Goals | Status |
|-----|-------|--------|
| **Day 1** | Repo, Arc vault.sol, deploy script, tests | 🔄 In Progress |
| **Day 2** | Sui treasury.move, LI.FI bridge, Stork oracle | 📋 Planned |
| **Day 3** | Agent logic, React UI, integration tests | 📋 Planned |
| **Day 4** | Diagrams, README, demo video | 📋 Planned |

## 🎬 How It Works

### 1. **Deposit Phase**
- User connects wallet → Approves USDC → Deposits to Arc vault
- Sets yield policy (e.g., "Borrow if yield > 5%")

### 2. **Agent Monitoring**
- Polls Stork oracle every 5 minutes
- Evaluates user policies against current conditions
- If threshold met: initiates rebalancing

### 3. **Rebalancing**
- Borrows RWA tokens via Arc vault
- Bridges USDC to Sui via LI.FI
- Executes swaps on DeepBook for yield
- Tracks profitability

### 4. **Payout**
- Repays RWA debt
- Bridges funds back to Arc
- Triggers Circle Gateway payout to user

## 📝 Contract Overview

### TreasuryVault.sol (Arc)

**Main Functions:**
- `deposit(amount)` - User deposits USDC
- `setPolicy(yieldThreshold, maxBorrow, strategy)` - Define rebalancing rules
- `borrowRWA(user, amount, rwaToken)` - Agent borrows RWA
- `repayRWA(amount)` - User repays borrowed RWA
- `withdraw(amount)` - User withdraws funds

**Key Features:**
- Reentrancy-safe
- Policy enforcement
- Multi-user tracking
- RWA borrow limits

## 🤖 Agent Core

Runs every 5 minutes:

```typescript
1. Fetch Stork price feed
2. Calculate implied yield
3. Check user policies
4. Execute borrow if profitable
5. Bridge to Sui
6. Monitor yield generation
7. Report metrics
```

## 🎨 Frontend

Minimal React UI with:
- Deposit input with USDC approval
- Policy settings (yield threshold, max borrow)
- Strategy selector (DeFi_Yield, RWA_Loan, Stablecoin_Carry)
- Live balance display
- Transaction status feedback

## 🔗 Sponsor Integrations

✅ **Arc/Circle**
- USDC deposits on Arc testnet
- Circle Wallets for custody
- Gateway for final payouts

✅ **Sui**
- Programmable Transaction Blocks (PTBs)
- DeepBook for yield optimization
- Native Move smart contracts

✅ **LI.FI**
- Cross-chain bridging (Arc → Sui)
- Integrated swap routing
- Low slippage execution

✅ **Stork**
- Real-time oracle price feeds
- Confidence intervals
- Policy trigger evaluation

## 🧪 Testing

```bash
cd contracts/arc

# Run all tests
forge test -vv

# Run specific test
forge test --match-test testDeposit -vv

# Run with gas report
forge test --gas-report
```

## 📊 Current Status

- ✅ Repo structure created
- ✅ TreasuryVault.sol written with full test suite
- ✅ Deploy script for Arc
- ✅ Package.json for agent & frontend
- ✅ Core agent loop template
- ✅ Deposit UI component
- 🔄 Running tests (in progress)
- ⏳ Sui Move contracts (Day 2)
- ⏳ Full agent integration (Day 3)

## 🐛 Known Issues / TODOs

- [ ] Integrate actual Stork SDK (currently mocked)
- [ ] Integrate actual LI.FI SDK (currently mocked)
- [ ] Add Circle Wallets integration
- [ ] Sui Move contracts for PTB rebalancing
- [ ] Full error handling & retry logic
- [ ] Gas optimization for batch operations

## 📞 Support & Resources

- [Arc Testnet Docs](https://www.circle.com)
- [Sui Developer Docs](https://docs.sui.io)
- [Foundry Book](https://book.getfoundry.sh)
- [ethers.js v6 Docs](https://docs.ethers.org/v6)

## 📄 License

MIT

---

**Built for ETHGlobal HackMoney 2026** 🚀
**Deadline: Feb 8, 2026**
