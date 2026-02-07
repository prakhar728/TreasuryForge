import 'dotenv/config';

import {
  DeepBookClient,
  GAS_BUDGET,
  mainnetCoins,
  mainnetMarginPools,
  mainnetPackageIds,
} from '@mysten/deepbook-v3';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

const NETWORK = (process.env.SUI_NETWORK || 'mainnet') as 'mainnet' | 'testnet';

type Args = {
  action?: string;
  coin?: string;
  amount?: string;
  amountRaw?: string;
  supplierCap?: string;
  referral?: string;
  execute?: boolean;
  confirm?: boolean;
};

const args = parseArgs(process.argv.slice(2));

const action = args.action ?? 'list';

if (action === 'list') {
  printAvailable();
  process.exit(0);
}

if (!args.coin) {
  throw new Error('Missing --coin. Use --coin SUI (or another margin pool key).');
}

const coinKey = args.coin.toUpperCase();
const coin = (mainnetCoins as Record<string, { type: string; scalar: number }>)[coinKey];
if (!coin) {
  throw new Error(`Unknown coin key: ${coinKey}. Run with --action list to see options.`);
}

if (!(mainnetMarginPools as Record<string, { address: string; type: string }>)[coinKey]) {
  throw new Error(
    `No margin pool for ${coinKey}. Run with --action list to see margin-enabled coins.`,
  );
}

const privateKey =
  process.env.SUI_PRIVATE_KEY ||
  process.env.SUI_SECRET_KEY ||
  process.env.SUI_PRIVATE_KEY_BASE64;

const keypair = privateKey ? getKeypair(privateKey) : null;
const address =
  keypair?.toSuiAddress() || process.env.SUI_ADDRESS || process.env.SUI_WALLET_ADDRESS || null;

const rpcUrl =
  process.env.SUI_RPC_URL || process.env.SUI_FULLNODE_URL || 'https://fullnode.mainnet.sui.io';
const suiClient = new SuiGrpcClient({ baseUrl: rpcUrl, network: NETWORK });
if (address) {
  const originalSimulate = suiClient.core.simulateTransaction.bind(suiClient.core);
  suiClient.core.simulateTransaction = async (input) => {
    const tx = (input as { transaction?: unknown }).transaction as
      | {
          setSenderIfNotSet?: (sender: string) => void;
          setGasBudgetIfNotSet?: (budget: number | string | bigint) => void;
          build?: (opts: { client: SuiGrpcClient }) => Promise<Uint8Array>;
        }
      | undefined;

    if (tx?.setSenderIfNotSet) tx.setSenderIfNotSet(address);
    if (tx?.setGasBudgetIfNotSet) tx.setGasBudgetIfNotSet(GAS_BUDGET);

    return originalSimulate(input);
  };
}
if (!address && action !== 'list') {
  throw new Error(
    'Missing Sui address. Set SUI_ADDRESS in .env for read-only actions, or SUI_PRIVATE_KEY for signing.',
  );
}

const dbClient = new DeepBookClient({
  address: address ?? '0x0',
  network: NETWORK,
  client: suiClient,
});

if (address) {
  console.log(`Using RPC: ${rpcUrl} (network=${NETWORK})`);
  console.log(`Using address: ${address}`);
  try {
    await printBalances(suiClient, address, coin.type, coinKey);
  } catch (err) {
    console.warn(`Balance fetch failed: ${(err as Error).message}`);
  }
}

if (action === 'caps') {
  if (!address) {
    throw new Error('Missing Sui address. Set SUI_ADDRESS in .env.');
  }
  await assertPackageExists(suiClient, mainnetPackageIds.MARGIN_PACKAGE_ID);
  await listSupplierCaps(suiClient, address, coin.type);
  process.exit(0);
}

if (action === 'info') {
  await assertPackageExists(suiClient, mainnetPackageIds.MARGIN_PACKAGE_ID);
  await printPoolInfo(dbClient, coinKey);
  process.exit(0);
}

if (action === 'mint-cap') {
  if (!keypair || !address) {
    throw new Error(
      'Missing Sui private key. Set SUI_PRIVATE_KEY in .env (do not share it in chat).',
    );
  }
  await assertPackageExists(suiClient, mainnetPackageIds.MARGIN_PACKAGE_ID);

  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasBudget(GAS_BUDGET);

  const supplierCap = tx.add(dbClient.marginPool.mintSupplierCap());
  tx.transferObjects([supplierCap], tx.pure.address(address));

  if (!args.execute) {
    console.log('\nDry run (no on-chain execution). Add --execute --confirm to broadcast.');
    const inspect = await suiClient.simulateTransaction({
      transaction: tx,
      include: { effects: true, events: true, balanceChanges: true, commandResults: true },
    });
    console.dir(inspect, { depth: 4 });
    process.exit(0);
  }

  if (!args.confirm) {
    throw new Error('Refusing to execute without --confirm.');
  }

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    include: { effects: true, events: true, balanceChanges: true, objectTypes: true },
  });

  console.log('\nExecution result:');
  console.dir(result, { depth: 4 });
  printSupplierCapsFromResult(result);
  await listSupplierCaps(suiClient, address, coin.type);
  process.exit(0);
}

if (action === 'deposit' || action === 'withdraw') {
  if (!keypair || !address) {
    throw new Error(
      'Missing Sui private key. Set SUI_PRIVATE_KEY in .env (do not share it in chat).',
    );
  }
  await assertPackageExists(suiClient, mainnetPackageIds.MARGIN_PACKAGE_ID);
  if (action === 'deposit' && !args.amount && !args.amountRaw) {
    throw new Error('Missing --amount (human) or --amount-raw (atomic).');
  }
  if (action === 'withdraw' && !args.supplierCap) {
    throw new Error('Withdraw requires --supplier-cap <objectId>.');
  }
  if (action === 'deposit' && !args.supplierCap) {
    throw new Error('Deposit requires --supplier-cap <objectId>. Run --action mint-cap first.');
  }

  const amountAtomic =
    args.amountRaw !== undefined
      ? parseAmountRaw(args.amountRaw)
      : toAtomicFromScalar(args.amount ?? '0', coin.scalar);

  if (action === 'deposit' && amountAtomic <= 0n) {
    throw new Error('Deposit amount must be greater than 0.');
  }

  const amountNumber =
    args.amountRaw !== undefined
      ? toSafeNumber(amountAtomic) / coin.scalar
      : args.amount
        ? Number(args.amount)
        : undefined;

  const tx = new Transaction();
  tx.setSender(address);
  tx.setGasBudget(GAS_BUDGET);

  const supplierCapArg = tx.object(args.supplierCap!);

  if (action === 'deposit') {
    dbClient.marginPool.supplyToMarginPool(
      coinKey,
      supplierCapArg,
      amountNumber!,
      args.referral,
    )(tx);
  } else {
    const withdrawn =
      args.amount || args.amountRaw
        ? dbClient.marginPool.withdrawFromMarginPool(coinKey, supplierCapArg, amountNumber)(tx)
        : dbClient.marginPool.withdrawFromMarginPool(coinKey, supplierCapArg)(tx);
    tx.transferObjects([withdrawn], tx.pure.address(address));
  }

  await printPoolInfo(dbClient, coinKey);

  if (!args.execute) {
    console.log('\nDry run (no on-chain execution). Add --execute --confirm to broadcast.');
    const inspect = await suiClient.simulateTransaction({
      transaction: tx,
      include: { effects: true, events: true, balanceChanges: true, commandResults: true },
    });
    console.dir(inspect, { depth: 4 });
    process.exit(0);
  }

  if (!args.confirm) {
    throw new Error('Refusing to execute without --confirm.');
  }

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    include: { effects: true, events: true, balanceChanges: true, objectTypes: true },
  });

  console.log('\nExecution result:');
  console.dir(result, { depth: 4 });

  console.log(
    '\nNote: To find your SupplierCap, run --action caps (or use --supplier-cap in withdraw).',
  );

  await printBalances(suiClient, address, coin.type, coinKey);
  process.exit(0);
}

throw new Error(`Unknown --action ${action}. Use list | info | deposit | withdraw.`);

function parseArgs(argv: string[]): Args {
  const parsed: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        (parsed as Record<string, boolean>)[toCamel(key)] = true;
      } else {
        (parsed as Record<string, string>)[toCamel(key)] = next;
        i += 1;
      }
    }
  }
  return parsed;
}

function toCamel(input: string) {
  return input
    .split('-')
    .map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
}

function toAtomicFromScalar(amount: string, scalar: number): bigint {
  const clean = amount.replace(/_/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  const numeric = Number(clean);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid amount: ${amount}`);
  }
  return BigInt(Math.round(numeric * scalar));
}

function parseAmountRaw(amountRaw: string): bigint {
  if (!/^\d+$/.test(amountRaw)) {
    throw new Error(`Invalid raw amount: ${amountRaw}`);
  }
  return BigInt(amountRaw);
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Amount is too large for JS number. Use a smaller amount.');
  }
  return Number(value);
}

function getKeypair(privateKey: string): Ed25519Keypair {
  const trimmed = privateKey.trim();
  if (trimmed.startsWith('0x')) {
    throw new Error(
      'Unsupported key format (0x...). Please provide a suiprivkey... or base64-encoded Ed25519 private key.',
    );
  }

  const { scheme, secretKey } = decodeSuiPrivateKey(trimmed);
  if (scheme !== 'ED25519') {
    throw new Error(`Unsupported key scheme: ${scheme}`);
  }
  return Ed25519Keypair.fromSecretKey(secretKey);
}

function printAvailable() {
  console.log('Available margin pools (mainnet):');
  const keys = Object.keys(mainnetMarginPools).sort();
  for (const key of keys) {
    console.log(`- ${key}`);
  }
  console.log('\nAvailable coins (mainnet):');
  const coinKeys = Object.keys(mainnetCoins).sort();
  for (const key of coinKeys) {
    console.log(`- ${key}`);
  }
}

async function printBalances(
  client: SuiClient,
  owner: string,
  coinType: string,
  coinKey: string,
) {
  const [suiBalance, targetBalance] = await Promise.all([
    client.getBalance({ owner, coinType: '0x2::sui::SUI' }),
    client.getBalance({ owner, coinType }),
  ]);

  console.log(`\nAddress: ${owner}`);
  console.log(`SUI balance (mist): ${suiBalance.balance.addressBalance}`);
  console.log(`${coinKey} balance (atomic): ${targetBalance.balance.addressBalance}`);
}

async function printPoolInfo(dbClient: DeepBookClient, coinKey: string) {
  const [
    poolId,
    totalSupply,
    totalBorrow,
    supplyCap,
    interestRate,
    protocolSpread,
    maxUtilization,
    minBorrow,
  ] = await Promise.all([
    dbClient.getMarginPoolId(coinKey),
    dbClient.getMarginPoolTotalSupply(coinKey),
    dbClient.getMarginPoolTotalBorrow(coinKey),
    dbClient.getMarginPoolSupplyCap(coinKey),
    dbClient.getMarginPoolInterestRate(coinKey),
    dbClient.getMarginPoolProtocolSpread(coinKey),
    dbClient.getMarginPoolMaxUtilizationRate(coinKey),
    dbClient.getMarginPoolMinBorrow(coinKey),
  ]);

  console.log(`\nMargin pool info for ${coinKey}:`);
  console.log(`- Pool ID: ${poolId}`);
  console.log(`- Total supply: ${totalSupply}`);
  console.log(`- Total borrow: ${totalBorrow}`);
  console.log(`- Supply cap: ${supplyCap}`);
  console.log(`- Interest rate: ${interestRate}`);
  console.log(`- Protocol spread: ${protocolSpread}`);
  console.log(`- Max utilization: ${maxUtilization}`);
  console.log(`- Min borrow: ${minBorrow}`);
}

async function assertPackageExists(client: SuiGrpcClient, packageId: string) {
  const result = await client.getObject({ objectId: packageId });
  if (result.error) {
    throw new Error(
      `DeepBook package not found on this RPC (${packageId}). Try a different Sui RPC via SUI_RPC_URL.`,
    );
  }
}

async function listSupplierCaps(client: SuiGrpcClient, owner: string, coinType: string) {
  const type = `${mainnetPackageIds.MARGIN_PACKAGE_ID}::margin_pool::SupplierCap`;
  const result = await client.listOwnedObjects({ owner, type });
  console.log(`\nSupplierCaps for ${coinType}:`);
  if (!result.objects.length) {
    console.log('- none');
    return;
  }
  for (const obj of result.objects) {
    console.log(`- ${obj.objectId}`);
  }
}

function printSupplierCapsFromResult(result: {
  objectTypes?: Record<string, string>;
}) {
  const supplierCaps = Object.entries(result.objectTypes ?? {})
    .filter(([, type]) => type.endsWith('::margin_pool::SupplierCap'))
    .map(([id]) => id);

  if (supplierCaps.length) {
    console.log('\nCreated SupplierCap object(s):');
    for (const id of supplierCaps) {
      console.log(`- ${id}`);
    }
  }
}
