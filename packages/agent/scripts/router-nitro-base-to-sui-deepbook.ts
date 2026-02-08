import dotenv from "dotenv";
import axios from "axios";
import { ethers } from "ethers";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { deepbook, mainnetCoins, mainnetPools } from "@mysten/deepbook-v3";

dotenv.config({ path: "../../.env" });

const DEFAULT_SUI_RPC = "https://fullnode.mainnet.sui.io:443";
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const ROUTER_API_URL =
  process.env.ROUTER_API_URL || "https://xplore.api.v2.routerprotocol.com";
const ROUTER_API_KEY = process.env.ROUTER_API_KEY || "";
const ROUTER_SLIPPAGE = Number(process.env.ROUTER_SLIPPAGE || "0.005");
const ROUTER_FROM_CHAIN_KEY = (process.env.ROUTER_FROM_CHAIN_KEY || "base").toLowerCase();
const ROUTER_TO_CHAIN_KEY = (process.env.ROUTER_TO_CHAIN_KEY || "sui").toLowerCase();
const ROUTER_FROM_CHAIN_ID = process.env.ROUTER_FROM_CHAIN_ID || "";
const ROUTER_TO_CHAIN_ID = process.env.ROUTER_TO_CHAIN_ID || "";

const BRIDGE_AMOUNT_USDC = Number(process.env.BRIDGE_AMOUNT_USDC || "0.2");
const DEEPBOOK_DEPOSIT_USDC = Number(
  process.env.DEEPBOOK_DEPOSIT_USDC || String(BRIDGE_AMOUNT_USDC)
);
const DEEPBOOK_POOL_KEY = process.env.DEEPBOOK_POOL_KEY || "SUI_USDC";

const SUI_RPC_URL = process.env.SUI_RPC_URL || DEFAULT_SUI_RPC;
const SUI_MNEMONIC = process.env.SUI_MNEMONIC || "";
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY || "";

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const BASE_SENDER_ADDRESS = process.env.ROUTER_SENDER_ADDRESS || "";
const BASE_REFUND_ADDRESS = process.env.ROUTER_REFUND_ADDRESS || BASE_SENDER_ADDRESS;

const STATUS_POLL = String(process.env.ROUTER_STATUS_POLL || "true").toLowerCase() === "true";
const STATUS_POLL_INTERVAL_MS = Number(process.env.ROUTER_STATUS_POLL_INTERVAL_MS || "10000");
const STATUS_TIMEOUT_MS = Number(process.env.ROUTER_STATUS_TIMEOUT_MS || "600000");

const WAIT_FOR_USDC_SECONDS = Number(process.env.WAIT_FOR_USDC_SECONDS || "600");

function assertEnv(label: string, value: string) {
  if (!value) throw new Error(`${label} is required`);
}

function toBaseUnits(amount: number, decimals: number): string {
  return ethers.parseUnits(amount.toString(), decimals).toString();
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

async function waitForSuiUsdc(
  client: SuiGrpcClient,
  owner: string,
  minAmount: number
): Promise<number> {
  const deadline = Date.now() + WAIT_FOR_USDC_SECONDS * 1000;
  while (Date.now() < deadline) {
    const bal = await client.getBalance({
      owner,
      coinType: mainnetCoins.USDC.type,
    });
    const amount = Number(bal.totalBalance) / 1e6;
    if (amount >= minAmount) return amount;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return 0;
}

async function ensureBalanceManagerId(
  client: SuiGrpcClient,
  address: string,
  suiKeypair: Ed25519Keypair
): Promise<string> {
  const deepbookClient = client.$extend(
    deepbook({
      address,
      network: "mainnet",
      coins: mainnetCoins,
      pools: mainnetPools,
    })
  );

  const existing = await deepbookClient.deepbook.getBalanceManagerIds(address);
  if (existing.length > 0) {
    return existing[0];
  }

  const tx = new Transaction();
  tx.add(deepbookClient.balanceManager.createAndShareBalanceManager());

  await client.signAndExecuteTransaction({
    transaction: tx,
    signer: suiKeypair,
    options: { showEffects: true },
  });

  const after = await deepbookClient.deepbook.getBalanceManagerIds(address);
  if (after.length === 0) {
    throw new Error("BalanceManager creation failed");
  }

  return after[0];
}

async function depositIntoDeepBook(
  client: SuiGrpcClient,
  address: string,
  suiKeypair: Ed25519Keypair,
  amountUsdc: number
) {
  const managerId = await ensureBalanceManagerId(client, address, suiKeypair);
  const dbClient = client.$extend(
    deepbook({
      address,
      network: "mainnet",
      coins: mainnetCoins,
      pools: mainnetPools,
      balanceManagers: {
        MAIN: { address: managerId },
      },
    })
  );

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

async function pollRouterStatus(srcTxHash: string, baseUrl: string) {
  if (!STATUS_POLL) return;
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await axios.get(`${baseUrl}/v1/status`, {
      params: { txHash: srcTxHash },
      headers: ROUTER_API_KEY ? { "X-API-Key": ROUTER_API_KEY } : undefined,
    });
    const status = res.data?.status || res.data;
    console.log("[Router] Status:", status);
    if (status === "DONE" || status === "FAILED") return res.data;
    await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }
  console.log("[Router] Status polling timed out");
}

async function main() {
  assertEnv("PRIVATE_KEY", PRIVATE_KEY);
  if (!Number.isFinite(BRIDGE_AMOUNT_USDC) || BRIDGE_AMOUNT_USDC <= 0) {
    throw new Error("BRIDGE_AMOUNT_USDC must be > 0");
  }

  const chainsRes = await axios.get(`${ROUTER_API_URL}/v1/chains`, {
    headers: ROUTER_API_KEY ? { "X-API-Key": ROUTER_API_KEY } : undefined,
  });
  const chains: Array<{ id: number; key: string; name: string }> = chainsRes.data?.chains || [];
  if (chains.length === 0) {
    throw new Error(`Router /v1/chains returned no chains: ${JSON.stringify(chainsRes.data)}`);
  }

  const fromChain = ROUTER_FROM_CHAIN_ID
    ? chains.find((c) => String(c.id) === ROUTER_FROM_CHAIN_ID)
    : chains.find(
        (c) => c.key?.toLowerCase() === ROUTER_FROM_CHAIN_KEY || c.name?.toLowerCase() === ROUTER_FROM_CHAIN_KEY
      );
  const toChain = ROUTER_TO_CHAIN_ID
    ? chains.find((c) => String(c.id) === ROUTER_TO_CHAIN_ID)
    : chains.find(
        (c) => c.key?.toLowerCase() === ROUTER_TO_CHAIN_KEY || c.name?.toLowerCase() === ROUTER_TO_CHAIN_KEY
      );

  if (!fromChain || !toChain) {
    const sample = chains.slice(0, 20).map((c) => `${c.key ?? c.name ?? "?"}:${c.id}`).join(", ");
    throw new Error(
      `Could not resolve chains (from=${ROUTER_FROM_CHAIN_KEY}, to=${ROUTER_TO_CHAIN_KEY}). ` +
      `Sample chains: ${sample}`
    );
  }

  const tokensRes = await axios.get(`${ROUTER_API_URL}/v1/tokens`, {
    params: { chains: `${fromChain.id},${toChain.id}` },
    headers: ROUTER_API_KEY ? { "X-API-Key": ROUTER_API_KEY } : undefined,
  });

  const tokens = tokensRes.data?.tokens || {};
  const fromTokens: Array<{ symbol: string; address: string; decimals: number }> = tokens[String(fromChain.id)] || [];
  const toTokens: Array<{ symbol: string; address: string; decimals: number }> = tokens[String(toChain.id)] || [];

  const fromUsdc = fromTokens.find((t) => t.symbol === "USDC");
  const toUsdc = toTokens.find((t) => t.symbol === "USDC");
  if (!fromUsdc || !toUsdc) {
    throw new Error("USDC token not found for one or both chains in Router tokens list");
  }

  const amount = toBaseUnits(BRIDGE_AMOUNT_USDC, fromUsdc.decimals);
  const sender = BASE_SENDER_ADDRESS || new ethers.Wallet(PRIVATE_KEY).address;
  const suiKeypair = getSuiKeypair();
  const receiver = suiKeypair.toSuiAddress();

  const quoteRes = await axios.get(`${ROUTER_API_URL}/v1/quote`, {
    params: {
      fromChain: String(fromChain.id),
      fromToken: fromUsdc.address,
      toChain: String(toChain.id),
      toToken: toUsdc.address,
      fromAmount: amount,
      fromAddress: sender,
      toAddress: receiver,
      slippage: ROUTER_SLIPPAGE,
    },
    headers: ROUTER_API_KEY ? { "X-API-Key": ROUTER_API_KEY } : undefined,
  });

  const quoteData = quoteRes.data;
  const txRequest = quoteData?.transactionRequest;
  const approvalAddress = quoteData?.estimate?.approvalAddress;
  if (!txRequest?.to || !txRequest?.data) {
    throw new Error(`Quote missing transactionRequest: ${JSON.stringify(quoteData)}`);
  }

  console.log("[Router] Quote OK");

  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  if (approvalAddress) {
    const token = new ethers.Contract(fromUsdc.address, ERC20_ABI, wallet);
    const allowance = await token.allowance(wallet.address, approvalAddress);
    if (allowance < BigInt(amount)) {
      console.log("[Router] Approving token...");
      const approveTx = await token.approve(approvalAddress, ethers.MaxUint256);
      await approveTx.wait();
    }
  }

  console.log("[Router] Sending transaction...");
  const sent = await wallet.sendTransaction({
    to: txRequest.to,
    data: txRequest.data,
    value: txRequest.value ? BigInt(txRequest.value) : 0n,
    gasLimit: txRequest.gasLimit ? BigInt(txRequest.gasLimit) : undefined,
    gasPrice: txRequest.gasPrice ? BigInt(txRequest.gasPrice) : undefined,
  });

  console.log(`[Router] Source tx: ${sent.hash}`);
  await sent.wait();

  await pollRouterStatus(sent.hash, ROUTER_API_URL);

  const suiAddress = suiKeypair.toSuiAddress();
  const suiClient = new SuiGrpcClient({ network: "mainnet", baseUrl: SUI_RPC_URL });

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
