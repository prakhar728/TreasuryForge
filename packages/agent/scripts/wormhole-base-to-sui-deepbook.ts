import dotenv from "dotenv";
import { Wormhole, circle, routes } from "@wormhole-foundation/sdk";
import evmPlatform from "@wormhole-foundation/sdk/platforms/evm";
import suiPlatform from "@wormhole-foundation/sdk/platforms/sui";
import evm from "@wormhole-foundation/sdk/evm";
import sui from "@wormhole-foundation/sdk/sui";
import "@wormhole-labs/cctp-executor-route";
import { cctpExecutorRoute } from "@wormhole-labs/cctp-executor-route";
import { createRequire } from "module";
import { registerProtocol, protocolIsRegistered } from "@wormhole-foundation/sdk-definitions";
import { _platform as evmPlatformCore } from "@wormhole-foundation/sdk-evm";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { DeepBookClient, mainnetCoins, mainnetPools, mainnetPackageIds } from "@mysten/deepbook-v3";

dotenv.config({ path: "../../.env" });

type Network = "Mainnet";

const NETWORK: Network = "Mainnet";
const DEFAULT_SUI_RPC = "https://fullnode.mainnet.sui.io:443";

const require = createRequire(import.meta.url);
const { EvmCCTPExecutor } = require("@wormhole-labs/cctp-executor-route/dist/cjs/evm/index.js") as {
  EvmCCTPExecutor: typeof import("@wormhole-labs/cctp-executor-route/dist/cjs/evm/executor.js").EvmCCTPExecutor;
};
if (!protocolIsRegistered(evmPlatformCore, "CCTPExecutor")) {
  registerProtocol(evmPlatformCore, "CCTPExecutor", EvmCCTPExecutor);
}

const EVM_PRIVATE_KEY =
  process.env.BASE_PRIVATE_KEY ||
  process.env.EVM_PRIVATE_KEY ||
  process.env.PRIVATE_KEY ||
  "";

const SUI_MNEMONIC = process.env.SUI_MNEMONIC || "";
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY || "";

const BRIDGE_AMOUNT_USDC = Number(process.env.BRIDGE_AMOUNT_USDC || "1");
const DEEPBOOK_DEPOSIT_USDC = Number(
  process.env.DEEPBOOK_DEPOSIT_USDC || String(BRIDGE_AMOUNT_USDC)
);
const DEEPBOOK_POOL_KEY = process.env.DEEPBOOK_POOL_KEY || "SUI_USDC";

const WAIT_FOR_USDC_SECONDS = Number(process.env.WAIT_FOR_USDC_SECONDS || "120");
const POLL_INTERVAL_MS = 5_000;
const SUI_USDC_COIN_TYPE = process.env.SUI_USDC_COIN_TYPE || "";

const PLACE_ORDER = String(process.env.DEEPBOOK_PLACE_ORDER || "false").toLowerCase() === "true";
const ORDER_PRICE = Number(process.env.DEEPBOOK_ORDER_PRICE || "0");
const ORDER_QUANTITY = Number(process.env.DEEPBOOK_ORDER_QUANTITY || "0");
const ORDER_IS_BID = String(process.env.DEEPBOOK_ORDER_IS_BID || "true").toLowerCase() === "true";

function assertEnv(label: string, value: string) {
  if (!value) {
    throw new Error(`${label} is required`);
  }
}

function getSuiKeypair(): Ed25519Keypair {
  if (SUI_PRIVATE_KEY) {
    const decoded = decodeSuiPrivateKey(SUI_PRIVATE_KEY);
    if (decoded.scheme !== "ED25519") {
      throw new Error(`Unsupported Sui key scheme: ${decoded.scheme}`);
    }
    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  }

  assertEnv("SUI_MNEMONIC", SUI_MNEMONIC);
  return Ed25519Keypair.deriveKeypair(SUI_MNEMONIC);
}

async function getSigner<N extends string, C extends string>(
  chain: any
): Promise<{ chain: any; signer: any; address: any }> {
  let signer: any;
  const platform = chain.platform.utils()._platform;
  switch (platform) {
    case "Evm":
      assertEnv("BASE_PRIVATE_KEY (or EVM_PRIVATE_KEY/PRIVATE_KEY)", EVM_PRIVATE_KEY);
      signer = await (await evm()).getSigner(await chain.getRpc(), EVM_PRIVATE_KEY);
      break;
    case "Sui":
      assertEnv("SUI_MNEMONIC", SUI_MNEMONIC || "set SUI_MNEMONIC or SUI_PRIVATE_KEY");
      signer = await (await sui()).getSigner(await chain.getRpc(), SUI_MNEMONIC);
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  return {
    chain,
    signer,
    address: Wormhole.chainAddress(chain.chain, signer.address()),
  };
}

async function waitForSuiUsdc(
  client: SuiGrpcClient,
  owner: string,
  minAmount: number
): Promise<number> {
  const coinType = SUI_USDC_COIN_TYPE || mainnetCoins.USDC.type;
  const deadline = Date.now() + WAIT_FOR_USDC_SECONDS * 1000;
  while (Date.now() < deadline) {
    const amount = await getSuiCoinBalance(client, owner, coinType);
    if (amount >= minAmount) return amount;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return 0;
}

async function getSuiCoinBalance(
  client: SuiGrpcClient,
  owner: string,
  coinType: string
): Promise<number> {
  try {
    const balances = await client.listBalances({ owner });
    const list = (balances as any)?.data || (balances as any)?.balances || balances;
    if (Array.isArray(list)) {
      const match = list.find((b: any) => b.coinType === coinType);
      if (match) {
        const raw = match.balance ?? match.coinBalance ?? match.totalBalance ?? match.amount;
        if (raw !== undefined) return Number(raw) / 1e6;
      }
    }
  } catch (error) {
    console.log("[Sui] listBalances failed:", error);
  }

  try {
    const bal = await client.getBalance({ owner, coinType });
    const total = typeof bal?.totalBalance === "string" ? bal.totalBalance : "";
    if (total) return Number(total) / 1e6;
  } catch (error) {
    console.log("[Sui] getBalance failed:", error);
  }

  try {
    const coins = await client.listCoins({ owner, coinType });
    const data = (coins as any)?.data || (coins as any)?.coins || [];
    const sum = data.reduce((acc: number, c: any) => acc + Number(c?.balance || 0), 0);
    return sum / 1e6;
  } catch (error) {
    console.log("[Sui] listCoins failed:", error);
    return 0;
  }
}

async function ensureBalanceManagerId(
  client: SuiGrpcClient,
  address: string,
  suiKeypair: Ed25519Keypair
): Promise<string> {
  const deepbookClient = new DeepBookClient({
    address,
    network: "mainnet",
    client,
    coins: mainnetCoins,
    pools: mainnetPools,
  });

  const existing = await deepbookClient.getBalanceManagerIds(address);
  if (existing.length > 0) {
    return existing[0];
  }

  const tx = new Transaction();
  const manager = deepbookClient.balanceManager.createBalanceManagerWithOwner(address)(tx);
  tx.moveCall({
    target: `${mainnetPackageIds.DEEPBOOK_PACKAGE_ID}::balance_manager::register_balance_manager`,
    arguments: [manager, tx.object(mainnetPackageIds.REGISTRY_ID)],
  });
  deepbookClient.balanceManager.shareBalanceManager(manager)(tx);

  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: suiKeypair,
    options: { showEffects: true, showObjectChanges: true },
  });

  const createdFromChanges = (() => {
    const changes = (res as any)?.objectChanges;
    if (!Array.isArray(changes)) return "";
    const created = changes.find(
      (change: any) =>
        change?.type === "created" &&
        typeof change?.objectType === "string" &&
        change.objectType.includes("::balance_manager::BalanceManager")
    );
    return typeof created?.objectId === "string" ? created.objectId : "";
  })();

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const after = await deepbookClient.getBalanceManagerIds(address);
    if (after.length > 0) {
      return after[0];
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (createdFromChanges) {
    return createdFromChanges;
  }

  throw new Error("BalanceManager creation failed");
}

async function depositIntoDeepBook(
  client: SuiGrpcClient,
  address: string,
  suiKeypair: Ed25519Keypair,
  amountUsdc: number
) {
  const managerId = await ensureBalanceManagerId(client, address, suiKeypair);
  const dbClient = new DeepBookClient({
    address,
    network: "mainnet",
    client,
    coins: mainnetCoins,
    pools: mainnetPools,
    balanceManagers: {
      MAIN: { address: managerId },
    },
  });

  const tx = new Transaction();
  tx.add(dbClient.balanceManager.depositIntoManager("MAIN", "USDC", amountUsdc));

  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: suiKeypair,
    options: { showEffects: true },
  });

  console.log(`[DeepBook] Deposited ${amountUsdc} USDC into BalanceManager ${managerId}`);
  return res;
}

async function placeDeepBookOrder(
  client: SuiGrpcClient,
  address: string,
  suiKeypair: Ed25519Keypair
) {
  if (!PLACE_ORDER) return;
  if (!ORDER_PRICE || !ORDER_QUANTITY) {
    console.log("[DeepBook] ORDER_PRICE and ORDER_QUANTITY required when DEEPBOOK_PLACE_ORDER=true");
    return;
  }

  const managerId = await ensureBalanceManagerId(client, address, suiKeypair);
  const dbClient = new DeepBookClient({
    address,
    network: "mainnet",
    client,
    coins: mainnetCoins,
    pools: mainnetPools,
    balanceManagers: {
      MAIN: { address: managerId },
    },
  });

  const tx = new Transaction();
  tx.add(
    dbClient.deepBook.placeLimitOrder({
      poolKey: DEEPBOOK_POOL_KEY,
      balanceManagerKey: "MAIN",
      clientOrderId: String(Date.now()),
      price: ORDER_PRICE,
      quantity: ORDER_QUANTITY,
      isBid: ORDER_IS_BID,
      orderType: 3, // POST_ONLY
    })
  );

  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: suiKeypair,
    options: { showEffects: true },
  });

  console.log(
    `[DeepBook] Placed ${ORDER_IS_BID ? "bid" : "ask"} limit order on ${DEEPBOOK_POOL_KEY}`
  );
  return res;
}

function getFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  if (!Number.isFinite(BRIDGE_AMOUNT_USDC) || BRIDGE_AMOUNT_USDC <= 0) {
    throw new Error("BRIDGE_AMOUNT_USDC must be > 0");
  }

  const resumeOnly = getFlag("--resume");
  const wh = new Wormhole(NETWORK, [evmPlatform.Platform, suiPlatform.Platform]);
  const dst = wh.getChain("Sui");
  const dstSigner = await getSigner(dst);

  if (!resumeOnly) {
    const src = wh.getChain("Base");
    const srcSigner = await getSigner(src);

    const srcUsdc = circle.usdcContract.get(NETWORK, src.chain);
    const dstUsdc = circle.usdcContract.get(NETWORK, dst.chain);
    if (!srcUsdc || !dstUsdc) {
      throw new Error("USDC is not configured for the selected chains");
    }

    const tr = await routes.RouteTransferRequest.create(wh, {
      source: Wormhole.tokenId(src.chain, srcUsdc),
      destination: Wormhole.tokenId(dst.chain, dstUsdc),
      sourceDecimals: 6,
      destinationDecimals: 6,
      sender: srcSigner.address,
      recipient: dstSigner.address,
    });

    const RouteImpl = cctpExecutorRoute();
    const route = new RouteImpl(wh);
    const validation = await route.validate(tr, { amount: BRIDGE_AMOUNT_USDC });
    if (!validation.valid) {
      throw validation.error;
    }
    const quote = await route.quote(tr, validation.params);
    if (!quote.success) {
      throw quote.error ?? new Error("Failed to fetch quote");
    }

    console.log("[CCTP] Quote:", quote);
    console.log("[CCTP] Submitting transfer...");

    const receipt = await route.initiate(tr, srcSigner.signer, quote, dstSigner.address);
    console.log("[CCTP] Receipt:", receipt);

    const lastTx = receipt.originTxs?.[receipt.originTxs.length - 1];
    if (lastTx) {
      const txid = typeof lastTx === "string" ? lastTx : lastTx.txid ?? String(lastTx);
      console.log(`WormholeScan URL: https://wormholescan.io/#/tx/${txid}?network=${NETWORK}`);
    }
  } else {
    console.log("[CCTP] Resume mode: skipping bridge, waiting for Sui USDC...");
  }

  const suiKeypair = getSuiKeypair();
  const suiAddress = suiKeypair.toSuiAddress();
  const suiRpc = process.env.SUI_RPC_URL || DEFAULT_SUI_RPC;
  const suiClient = new SuiGrpcClient({ network: "mainnet", baseUrl: suiRpc });

  const allBalances = await suiClient.listBalances({ owner: suiAddress });
  const balancesList = (allBalances as any)?.data || (allBalances as any)?.balances || allBalances;
  if (Array.isArray(balancesList) && balancesList.length > 0) {
    const toNum = (value: any) => {
      if (typeof value === "bigint") return Number(value);
      if (typeof value === "number") return value;
      if (typeof value === "string") return Number(value);
      return NaN;
    };
    console.log(
      "[Sui] All balances:",
      balancesList
        .map((b: any) => {
          const total = b.totalBalance ?? b.balance ?? b.total ?? b.amount;
          return `${b.coinType}=${toNum(total)}`;
        })
        .join(", ")
    );

    const usdcType = SUI_USDC_COIN_TYPE || mainnetCoins.USDC.type;
    const usdcEntry = balancesList.find((b: any) => b.coinType === usdcType);
    if (usdcEntry) {
      console.log("[Sui] USDC entry (raw):", usdcEntry);
    }
  } else {
    console.log("[Sui] No balances returned for address.");
    const usdcType = SUI_USDC_COIN_TYPE || mainnetCoins.USDC.type;
    const usdcBal = await getSuiCoinBalance(suiClient, suiAddress, usdcType);
    console.log(`[Sui] Direct USDC balance (${usdcType}): ${usdcBal}`);
  }

  console.log(`[Sui] Waiting for USDC balance on ${suiAddress}...`);
  const usdcBalance = await waitForSuiUsdc(suiClient, suiAddress, Math.min(0.01, BRIDGE_AMOUNT_USDC));
  if (usdcBalance <= 0) {
    throw new Error("USDC not detected on Sui before timeout");
  }
  console.log(`[Sui] USDC balance: ${usdcBalance}`);

  const depositAmount = Math.min(DEEPBOOK_DEPOSIT_USDC, usdcBalance);
  if (depositAmount <= 0) {
    throw new Error("No USDC available for DeepBook deposit");
  }

  await depositIntoDeepBook(suiClient, suiAddress, suiKeypair, depositAmount);
  await placeDeepBookOrder(suiClient, suiAddress, suiKeypair);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
