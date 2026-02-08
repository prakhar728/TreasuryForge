import dotenv from "dotenv";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { mainnetCoins, testnetCoins } from "@mysten/deepbook-v3";
import { AgentStorage } from "../src/utils/agent-storage.js";

dotenv.config({ path: "../../.env" });

const SUI_NETWORK = (process.env.SUI_NETWORK || "mainnet") as "mainnet" | "testnet";
const SUI_RPC_URL =
  process.env.SUI_RPC_URL ||
  (SUI_NETWORK === "mainnet" ? "https://fullnode.mainnet.sui.io:443" : "https://fullnode.testnet.sui.io:443");

const RECOVERY_SUI_ADDRESS =
  process.env.RECOVERY_SUI_ADDRESS ||
  "0xe84d42a41c3cadf27f1490b0d383a4b5d630227c73828c88dc2e8ad73e7ca617";

const MIN_USDC = Number(process.env.RECOVERY_MIN_USDC || "0.01");
const MAX_USDC = Number(process.env.RECOVERY_MAX_USDC || "0");

const DRY_RUN = process.argv.includes("--dry-run");

function requireEnv(label: string, value?: string) {
  if (!value) throw new Error(`${label} is required`);
}

function getSuiUsdcType(): string {
  if (SUI_NETWORK === "mainnet") return mainnetCoins.USDC.type;
  return testnetCoins.DBUSDC?.type || testnetCoins.USDC?.type;
}

async function buildSuiSigner(privateKey: string): Promise<Ed25519Keypair> {
  const decoded = decodeSuiPrivateKey(privateKey);
  if (decoded.scheme !== "ED25519") {
    throw new Error(`Unsupported Sui key scheme: ${decoded.scheme}`);
  }
  return Ed25519Keypair.fromSecretKey(decoded.secretKey);
}

function toBaseUnits(amount: number): bigint {
  return BigInt(Math.floor(amount * 1e6));
}

async function main() {
  requireEnv("SUI_KEYSTORE_MASTER_KEY", process.env.SUI_KEYSTORE_MASTER_KEY);
  requireEnv("RECOVERY_SUI_ADDRESS", RECOVERY_SUI_ADDRESS);
  if (!isValidSuiAddress(RECOVERY_SUI_ADDRESS)) {
    throw new Error(`RECOVERY_SUI_ADDRESS is not a valid Sui address: ${RECOVERY_SUI_ADDRESS}`);
  }

  const storage = new AgentStorage();
  const keys = storage.listSuiKeys();
  if (keys.length === 0) {
    console.log("[Recovery] No Sui keys found.");
    return;
  }

  const client = new SuiJsonRpcClient({ url: SUI_RPC_URL, network: SUI_NETWORK });
  const coinType = getSuiUsdcType();
  const minRaw = toBaseUnits(MIN_USDC);
  const maxRaw = MAX_USDC > 0 ? toBaseUnits(MAX_USDC) : 0n;
  const destination = normalizeSuiAddress(RECOVERY_SUI_ADDRESS);
  const suiGasType = "0x2::sui::SUI";

  for (const entry of keys) {
    const key = storage.getSuiKey(entry.user);
    if (!key) continue;

    const bal = await client.getBalance({ owner: key.suiAddress, coinType });
    const totalRaw = BigInt(typeof bal.totalBalance === "string" ? bal.totalBalance : String(bal.totalBalance || "0"));
    const balance = Number(totalRaw) / 1e6;
    if (totalRaw < minRaw) {
      console.log(`[Recovery] ${entry.user.slice(0, 10)}... Sui balance ${balance.toFixed(4)} < min`);
      continue;
    }

    let amountRaw = totalRaw;
    if (maxRaw > 0n && amountRaw > maxRaw) amountRaw = maxRaw;
    const amount = Number(amountRaw) / 1e6;

    console.log(
      `[Recovery] ${entry.user.slice(0, 10)}... Sui ${balance.toFixed(4)} USDC -> send ${amount.toFixed(4)} to ${destination}`
    );

    if (DRY_RUN) continue;

    const suiGas = await client.getBalance({ owner: key.suiAddress, coinType: suiGasType });
    const suiGasRaw = BigInt(
      typeof suiGas.totalBalance === "string" ? suiGas.totalBalance : String(suiGas.totalBalance || "0")
    );
    if (suiGasRaw === 0n) {
      console.log(
        `[Recovery] ${entry.user.slice(0, 10)}... no SUI gas coins found. Fund this address with SUI to send.`
      );
      continue;
    }

    const coins: { coinObjectId: string; balance: string }[] = [];
    let cursor: string | null | undefined = null;
    do {
      const page = await client.getCoins({ owner: key.suiAddress, coinType, cursor, limit: 50 });
      coins.push(...page.data.map((c) => ({ coinObjectId: c.coinObjectId, balance: String(c.balance) })));
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);

    if (coins.length === 0) {
      console.log(`[Recovery] ${entry.user.slice(0, 10)}... no USDC coins found`);
      continue;
    }

    const tx = new Transaction();
    tx.setGasBudget(5_000_000);

    const primary = coins[0].coinObjectId;
    if (coins.length > 1) {
      tx.mergeCoins(primary, coins.slice(1).map((c) => c.coinObjectId));
    }

    const [split] = tx.splitCoins(primary, [amountRaw.toString()]);
    tx.transferObjects([split], tx.pure.address(destination));

    const signer = await buildSuiSigner(key.privateKey);
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEffects: true },
    });

    console.log(`[Recovery] Sui transfer submitted for ${entry.user.slice(0, 10)}... ${result.digest}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
