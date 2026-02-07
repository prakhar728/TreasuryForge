# TreasuryForge Demo Flow

This demo highlights two **independent** segments:
1. **EVM testnet unified balance + allocation**
2. **Sui mainnet yield via DeepBook**

## Prereqs
Segment A (EVM testnet):
- Agent wallet has **Arc testnet USDC** for deposit + demo rebalancing.
- `.env` has:
  - `STORK_API_KEY`
  - `ARC_RPC_URL`, `ARC_USDC_ADDRESS`, `ARC_VAULT_ADDRESS`
  - `LIFI_API_KEY`, `LIFI_INTEGRATOR` (only if you’re using LI.FI on testnet EVM chains)

Segment B (Sui mainnet):
- A **separate** mainnet USDC balance for the Sui bridge + DeepBook.
- `.env` has:
  - `SUI_PRIVATE_KEY`, `SUI_KEYSTORE_MASTER_KEY`

## Flow
### Segment A — EVM testnet unified balance + allocation
1. **Deposit on Arc testnet**
   - Use the web UI to `approve` + `deposit` USDC.
2. **Set policy**
   - Strategy: `DeFi_Yield` for cross‑chain demo (EVM testnets).
3. **Agent cycle**
   - Stork fetches Arc yield.
   - DefiLlama fetches best USDC yield on other EVM testnets.
   - Agent logs best opportunity per strategy.
4. **Gateway unified balance**
   - If a unified balance exists on the destination chain, the agent mints directly.
   - Otherwise, it deposits on Arc and mints on the destination.
5. **Execute testnet allocation**
   - Agent bridges and enters the target testnet strategy.
   - This proves unified balance + strategy execution works on EVM testnets.

### Segment B — Sui mainnet yield via DeepBook
1. **Start with mainnet USDC (separate balance)**
   - This is **not** derived from Arc testnet funds.
2. **Bridge to Sui mainnet**
   - Use the supported bridge for USDC → Sui mainnet.
3. **DeepBook yield**
   - Invest into DeepBook to show the mainnet path works.

## DeepBook Liquidity Check (optional)
If you’re testing on Sui testnet and yields are mocked, check pool liquidity:

```bash
cd /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent
npx tsx -e "import { deepbook } from '@mysten/deepbook-v3'; import { SuiGrpcClient } from '@mysten/sui/grpc'; const client = new SuiGrpcClient({ network:'testnet', baseUrl: process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443' }).$extend(deepbook({ address: process.env.SUI_ADDRESS || '0x0' })); const data = await client.deepbook.getLevel2Range('SUI_DBUSDC', 0.01, 1000, true); console.log(data);"
```

If `bids` and `asks` are empty, the testnet pool has no liquidity and the agent will use mock yields.
