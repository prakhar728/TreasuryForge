# DeepBook Margin Yield Script (Mainnet) — Test Guide

This guide walks through listing pools, inspecting SUI pool info, dry‑running deposits, executing deposits, listing SupplierCaps, and withdrawing back to SUI.

## Prereqs

Set these in `/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env`:

```
SUI_PRIVATE_KEY=suiprivkey...
SUI_ADDRESS=0xYOUR_PUBLIC_ADDRESS
```

Optional:

```
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io
```

## Script Path

```
/Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts
```

## 1) List Pools + Coins

```bash
SUI_NETWORK=mainnet \
SUI_RPC_URL=https://fullnode.mainnet.sui.io \
DOTENV_CONFIG_PATH=/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env \
npx tsx /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts \
  --action list
```

## 2) Inspect SUI Pool (read‑only)

```bash
SUI_NETWORK=mainnet \
SUI_RPC_URL=https://fullnode.mainnet.sui.io \
DOTENV_CONFIG_PATH=/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env \
npx tsx /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts \
  --action info \
  --coin SUI
```

## 3) Mint SupplierCap (required before deposit)

Dry‑run:

```bash
SUI_NETWORK=mainnet \
SUI_RPC_URL=https://fullnode.mainnet.sui.io \
DOTENV_CONFIG_PATH=/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env \
npx tsx /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts \
  --action mint-cap \
  --coin SUI
```

Execute:

```bash
SUI_NETWORK=mainnet \
SUI_RPC_URL=https://fullnode.mainnet.sui.io \
DOTENV_CONFIG_PATH=/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env \
npx tsx /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts \
  --action mint-cap \
  --coin SUI \
  --execute \
  --confirm
```

## 4) List SupplierCaps

```bash
SUI_NETWORK=mainnet \
SUI_RPC_URL=https://fullnode.mainnet.sui.io \
DOTENV_CONFIG_PATH=/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env \
npx tsx /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts \
  --action caps \
  --coin SUI
```

## 5) Dry‑Run Deposit (no execution)

```bash
SUI_NETWORK=mainnet \
SUI_RPC_URL=https://fullnode.mainnet.sui.io \
DOTENV_CONFIG_PATH=/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env \
npx tsx /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts \
  --action deposit \
  --coin SUI \
  --amount 0.1 \
  --supplier-cap <SUPPLIER_CAP_OBJECT_ID>
```

## 6) Execute Deposit (on‑chain)

```bash
SUI_NETWORK=mainnet \
SUI_RPC_URL=https://fullnode.mainnet.sui.io \
DOTENV_CONFIG_PATH=/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env \
npx tsx /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts \
  --action deposit \
  --coin SUI \
  --amount 0.1 \
  --supplier-cap <SUPPLIER_CAP_OBJECT_ID> \
  --execute \
  --confirm
```

## 7) Withdraw Back to SUI (full)

Replace `<SUPPLIER_CAP_OBJECT_ID>` with one from step 4.

```bash
SUI_NETWORK=mainnet \
SUI_RPC_URL=https://fullnode.mainnet.sui.io \
DOTENV_CONFIG_PATH=/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env \
npx tsx /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts \
  --action withdraw \
  --coin SUI \
  --supplier-cap <SUPPLIER_CAP_OBJECT_ID> \
  --execute \
  --confirm
```

## 8) Withdraw Back to SUI (partial)

```bash
SUI_NETWORK=mainnet \
SUI_RPC_URL=https://fullnode.mainnet.sui.io \
DOTENV_CONFIG_PATH=/Users/prakharojha/Desktop/me/personal/TreasuryForge/.env \
npx tsx /Users/prakharojha/Desktop/me/personal/TreasuryForge/packages/agent/scripts/deepbook-margin-yield.ts \
  --action withdraw \
  --coin SUI \
  --supplier-cap <SUPPLIER_CAP_OBJECT_ID> \
  --amount 0.1 \
  --execute \
  --confirm
```

## Notes

- If you see `fetch failed` during balance reads, retry. It’s a transient gRPC transport error.
- If you see a `testnet` chain in error metadata, your RPC is not mainnet; set `SUI_NETWORK=mainnet` and a mainnet RPC URL.
- Do not include `<` or `>` when pasting object IDs into commands.
