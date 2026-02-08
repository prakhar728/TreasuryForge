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

const API_URL = process.env.STARGATE_API_URL || "https://stargate.finance/api/v1";
const SRC_CHAIN_KEY = (process.env.STARGATE_SRC_CHAIN_KEY || "base").toLowerCase();
const DST_CHAIN_KEY = (process.env.STARGATE_DST_CHAIN_KEY || "sui").toLowerCase();
const SRC_TOKEN_SYMBOL = (process.env.STARGATE_SRC_TOKEN_SYMBOL || "USDC").toUpperCase();
const DST_TOKEN_SYMBOL = (process.env.STARGATE_DST_TOKEN_SYMBOL || "USDC").toUpperCase();
const DST_TOKEN_SYMBOLS = process.env.STARGATE_DST_TOKEN_SYMBOLS || "";
const SLIPPAGE_BPS = Number(process.env.STARGATE_SLIPPAGE_BPS || "50");

const BRIDGE_AMOUNT_USDC = Number(process.env.BRIDGE_AMOUNT_USDC || "0.2");
const DEEPBOOK_DEPOSIT_USDC = Number(
  process.env.DEEPBOOK_DEPOSIT_USDC || String(BRIDGE_AMOUNT_USDC)
);
const DEEPBOOK_DEPOSIT_SYMBOL = (process.env.DEEPBOOK_DEPOSIT_SYMBOL || "USDC").toUpperCase();
const SKIP_DEEPBOOK_DEPOSIT_ON_MISMATCH =
  String(process.env.SKIP_DEEPBOOK_DEPOSIT_ON_MISMATCH || "true").toLowerCase() === "true";

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const SUI_RPC_URL = process.env.SUI_RPC_URL || DEFAULT_SUI_RPC;
const SUI_MNEMONIC = process.env.SUI_MNEMONIC || "";
const SUI_PRIVATE_KEY = process.env.SUI_PRIVATE_KEY || "";

const STATUS_POLL = String(process.env.STARGATE_STATUS_POLL || "true").toLowerCase() === "true";
const STATUS_POLL_INTERVAL_MS = Number(process.env.STARGATE_STATUS_POLL_INTERVAL_MS || "10000");
const STATUS_TIMEOUT_MS = Number(process.env.STARGATE_STATUS_TIMEOUT_MS || "600000");
const WAIT_FOR_USDC_SECONDS = Number(process.env.WAIT_FOR_USDC_SECONDS || "600");
const ROUTE_PROBE = String(process.env.STARGATE_ROUTE_PROBE || "false").toLowerCase() === "true";
const ROUTE_PROBE_MAX = Number(process.env.STARGATE_ROUTE_PROBE_MAX || "40");
const ROUTE_PROBE_DELAY_MS = Number(process.env.STARGATE_ROUTE_PROBE_DELAY_MS || "150");

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

async function waitForSuiCoin(
  client: SuiGrpcClient,
  owner: string,
  coinType: string,
  decimals: number,
  minAmount: number
): Promise<number> {
  const deadline = Date.now() + WAIT_FOR_USDC_SECONDS * 1000;
  while (Date.now() < deadline) {
    const bal = await client.getBalance({
      owner,
      coinType,
    });
    const amount = Number(bal.totalBalance) / 10 ** decimals;
    if (amount >= minAmount) return amount;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return 0;
}

function normalizeSymbols(primary: string, extra: string): string[] {
  const list = [primary, ...extra.split(",")].map((s) => s.trim().toUpperCase()).filter(Boolean);
  return Array.from(new Set(list));
}

function formatTokenList(tokens: Array<{ symbol: string }>, limit = 50): string {
  const unique = Array.from(new Set(tokens.map((t) => t.symbol?.toUpperCase()).filter(Boolean))).sort();
  if (unique.length <= limit) return unique.join(", ");
  return `${unique.slice(0, limit).join(", ")} … (+${unique.length - limit} more)`;
}

function resolveToken(
  tokens: Array<{ symbol: string; address: string; decimals: number; chainKey: string }>,
  chainKey: string,
  symbols: string[]
) {
  for (const symbol of symbols) {
    const match = tokens.find(
      (t) => t.chainKey?.toLowerCase() === chainKey && t.symbol?.toUpperCase() === symbol
    );
    if (match) return match;
  }
  return undefined;
}

async function probeRoutes(
  tokens: Array<{ symbol: string; address: string; decimals: number; chainKey: string }>,
  srcChainKey: string,
  dstChainKey: string,
  srcToken: { address: string; decimals: number },
  sender: string,
  receiver: string,
  amount: string
) {
  const candidates = tokens.filter((t) => t.chainKey?.toLowerCase() === dstChainKey);
  const limited = candidates.slice(0, ROUTE_PROBE_MAX);
  console.log(
    `[Stargate] Probing routes for ${limited.length}/${candidates.length} ${dstChainKey} tokens...`
  );

  const successes: Array<{ symbol: string; address: string }> = [];
  for (const token of limited) {
    const res = await fetchQuote({
      srcChainKey,
      dstChainKey,
      srcToken: srcToken.address,
      dstToken: token.address,
      srcAddress: sender,
      dstAddress: receiver,
      srcAmount: amount,
    });
    if (!res?.__error) {
      successes.push({ symbol: token.symbol, address: token.address });
      console.log(`[Stargate] Route OK: ${token.symbol}`);
    }
    await new Promise((r) => setTimeout(r, ROUTE_PROBE_DELAY_MS));
  }

  if (successes.length === 0) {
    console.log("[Stargate] No routes found in probe set.");
  } else {
    console.log(
      `[Stargate] Route candidates: ${successes
        .map((t) => `${t.symbol} (${t.address})`)
        .join(", ")}`
    );
  }
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
  amount: number,
  depositSymbol: string
) {
  const coin = (mainnetCoins as Record<string, { type: string }>)[depositSymbol];
  if (!coin) {
    const supported = Object.keys(mainnetCoins).sort().join(", ");
    throw new Error(`[DeepBook] Unsupported deposit symbol ${depositSymbol}. Supported: ${supported}`);
  }

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
  tx.add(dbClient.balanceManager.depositIntoManager("MAIN", depositSymbol, amount));

  const res = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: suiKeypair,
    options: { showEffects: true },
  });

  console.log(`[DeepBook] Deposited ${amount} ${depositSymbol} into BalanceManager ${managerId}`);
  return res;
}

async function pollStatus(srcTxHash: string) {
  if (!STATUS_POLL) return;
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await axios.get(`${API_URL}/transfers/${srcTxHash}`);
    const status = res.data?.status || res.data;
    console.log("[Stargate] Status:", status);
    if (status?.state === "DELIVERED" || status?.state === "FAILED") return res.data;
    await new Promise((r) => setTimeout(r, STATUS_POLL_INTERVAL_MS));
  }
  console.log("[Stargate] Status polling timed out");
}

function extractTxSteps(quote: any): Array<{ to: string; data: string; value?: string; allowanceTarget?: string }> {
  const steps = quote?.steps || quote?.route?.steps || [];
  const txs: Array<{ to: string; data: string; value?: string; allowanceTarget?: string }> = [];

  for (const step of steps) {
    const tx = step?.transaction || step?.tx || step?.transactionRequest || step?.data?.transaction;
    const to = tx?.to || step?.to;
    const data = tx?.data || step?.data;
    if (to && data) {
      txs.push({
        to,
        data,
        value: tx?.value,
        allowanceTarget: step?.allowanceTarget || step?.spender || tx?.allowanceTarget,
      });
    }
  }

  return txs;
}

async function fetchQuote(params: Record<string, string | number | undefined>) {
  try {
    const res = await axios.get(`${API_URL}/quotes`, { params });
    return res.data;
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response) {
      const status = error.response.status;
      const data = error.response.data;
      return { __error: { status, data } };
    }
    throw error;
  }
}

async function main() {
  assertEnv("PRIVATE_KEY", PRIVATE_KEY);
  if (!Number.isFinite(BRIDGE_AMOUNT_USDC) || BRIDGE_AMOUNT_USDC <= 0) {
    throw new Error("BRIDGE_AMOUNT_USDC must be > 0");
  }

  const chainsRes = await axios.get(`${API_URL}/chains`);
  const chains: Array<{ chainKey: string; chainId: number; name: string }> = chainsRes.data?.chains || [];

  const srcChain = chains.find((c) => c.chainKey?.toLowerCase() === SRC_CHAIN_KEY);
  const dstChain = chains.find((c) => c.chainKey?.toLowerCase() === DST_CHAIN_KEY);
  if (!srcChain || !dstChain) {
    throw new Error(`Chain not found (src=${SRC_CHAIN_KEY}, dst=${DST_CHAIN_KEY})`);
  }

  const tokensRes = await axios.get(`${API_URL}/tokens`);
  const tokens: Array<{ symbol: string; address: string; decimals: number; chainKey: string }> =
    tokensRes.data?.tokens || [];

  const srcToken = resolveToken(tokens, SRC_CHAIN_KEY, normalizeSymbols(SRC_TOKEN_SYMBOL, ""));
  if (!srcToken) {
    const available = formatTokenList(
      tokens.filter((t) => t.chainKey?.toLowerCase() === SRC_CHAIN_KEY)
    );
    throw new Error(
      `Source token not found for ${SRC_CHAIN_KEY} ${SRC_TOKEN_SYMBOL}. Available: ${available}`
    );
  }

  const dstSymbols = normalizeSymbols(DST_TOKEN_SYMBOL, DST_TOKEN_SYMBOLS);
  const dstToken = resolveToken(tokens, DST_CHAIN_KEY, dstSymbols);
  if (!dstToken) {
    const available = formatTokenList(
      tokens.filter((t) => t.chainKey?.toLowerCase() === DST_CHAIN_KEY)
    );
    throw new Error(
      `Destination token not found for ${DST_CHAIN_KEY} ${dstSymbols.join("|")}. Available: ${available}`
    );
  }

  const amount = toBaseUnits(BRIDGE_AMOUNT_USDC, srcToken.decimals);
  const minAmount = (BigInt(amount) * BigInt(10_000 - Math.floor(SLIPPAGE_BPS))) / 10_000n;

  const sender = new ethers.Wallet(PRIVATE_KEY).address;
  const suiKeypair = getSuiKeypair();
  const receiver = suiKeypair.toSuiAddress();

  const quoteParamsBase = {
    srcChainKey: srcChain.chainKey,
    dstChainKey: dstChain.chainKey,
    srcToken: srcToken.address,
    srcAddress: sender,
    dstAddress: receiver,
    srcAmount: amount,
  } as const;

  let quoteData: any;
  let selectedDstToken = dstToken;
  const quoteErrors: Array<{ symbol: string; status?: number; data?: any }> = [];

  for (const symbol of dstSymbols) {
    const candidate = resolveToken(tokens, DST_CHAIN_KEY, [symbol]);
    if (!candidate) continue;

    const withMin = await fetchQuote({
      ...quoteParamsBase,
      dstToken: candidate.address,
      dstAmountMin: minAmount.toString(),
    });

    if (!withMin?.__error) {
      quoteData = withMin;
      selectedDstToken = candidate;
      break;
    }

    const withoutMin = await fetchQuote({
      ...quoteParamsBase,
      dstToken: candidate.address,
    });

    if (!withoutMin?.__error) {
      quoteData = withoutMin;
      selectedDstToken = candidate;
      break;
    }

    quoteErrors.push({
      symbol: candidate.symbol,
      status: withMin.__error?.status || withoutMin.__error?.status,
      data: withMin.__error?.data || withoutMin.__error?.data,
    });
  }

  if (!quoteData) {
    const details = quoteErrors
      .map((e) => `${e.symbol}: ${e.status} ${JSON.stringify(e.data)}`)
      .join(" | ");
    if (ROUTE_PROBE) {
      await probeRoutes(tokens, SRC_CHAIN_KEY, DST_CHAIN_KEY, srcToken, sender, receiver, amount);
    }
    throw new Error(`No quote returned. Errors: ${details}`);
  }

  const quote = Array.isArray(quoteData?.quotes) ? quoteData.quotes[0] : quoteData;
  if (!quote) {
    throw new Error(`No quote returned: ${JSON.stringify(quoteData)}`);
  }

  const txSteps = extractTxSteps(quote);
  if (txSteps.length === 0) {
    throw new Error(`No transaction steps found in quote: ${JSON.stringify(quote)}`);
  }

  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const allowanceTarget = txSteps.find((s) => s.allowanceTarget)?.allowanceTarget;
  if (allowanceTarget) {
    const token = new ethers.Contract(srcToken.address, ERC20_ABI, wallet);
    const allowance = await token.allowance(wallet.address, allowanceTarget);
    if (allowance < BigInt(amount)) {
      console.log("[Stargate] Approving token...");
      const approveTx = await token.approve(allowanceTarget, ethers.MaxUint256);
      await approveTx.wait();
    }
  }

  let lastTxHash: string | undefined;
  for (const step of txSteps) {
    const sent = await wallet.sendTransaction({
      to: step.to,
      data: step.data,
      value: step.value ? BigInt(step.value) : 0n,
    });
    console.log(`[Stargate] Sent tx: ${sent.hash}`);
    lastTxHash = sent.hash;
    await sent.wait();
  }

  if (lastTxHash) {
    await pollStatus(lastTxHash);
  }

  const suiAddress = receiver;
  const suiClient = new SuiGrpcClient({ network: "mainnet", baseUrl: SUI_RPC_URL });

  console.log(`[Sui] Waiting for ${selectedDstToken.symbol} balance on ${suiAddress}...`);
  const dstBalance = await waitForSuiCoin(
    suiClient,
    suiAddress,
    selectedDstToken.address,
    selectedDstToken.decimals,
    Math.min(0.01, BRIDGE_AMOUNT_USDC)
  );
  if (dstBalance <= 0) {
    throw new Error(`${selectedDstToken.symbol} not detected on Sui before timeout`);
  }
  console.log(`[Sui] ${selectedDstToken.symbol} balance: ${dstBalance}`);

  if (DEEPBOOK_DEPOSIT_SYMBOL !== selectedDstToken.symbol.toUpperCase()) {
    const message = `[DeepBook] Bridged token ${selectedDstToken.symbol} does not match DEEPBOOK_DEPOSIT_SYMBOL=${DEEPBOOK_DEPOSIT_SYMBOL}.`;
    if (SKIP_DEEPBOOK_DEPOSIT_ON_MISMATCH) {
      console.log(`${message} Skipping DeepBook deposit.`);
      return;
    }
    throw new Error(`${message} Set DEEPBOOK_DEPOSIT_SYMBOL to match or enable skip.`);
  }

  const depositAmount = Math.min(DEEPBOOK_DEPOSIT_USDC, dstBalance);
  if (depositAmount <= 0) {
    throw new Error(`No ${DEEPBOOK_DEPOSIT_SYMBOL} available for DeepBook deposit`);
  }

  await depositIntoDeepBook(
    suiClient,
    suiAddress,
    suiKeypair,
    depositAmount,
    DEEPBOOK_DEPOSIT_SYMBOL
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
