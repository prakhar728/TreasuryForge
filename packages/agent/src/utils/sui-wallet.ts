import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient as SuiClient } from "@mysten/sui/jsonRpc";
import { fromBase64, fromHex } from "@mysten/sui/utils";
import {
  ReadonlyWalletAccount,
  StandardConnect,
  StandardEvents,
  SuiSignAndExecuteTransaction,
  SuiSignAndExecuteTransactionBlock,
  SuiSignPersonalMessage,
  SuiSignTransaction,
  SuiSignTransactionBlock,
  type Wallet,
  type IdentifierArray,
} from "@mysten/wallet-standard";

const SUI_TESTNET_CHAIN: `${string}:${string}` = "sui:testnet";

type EventListener = (...args: any[]) => void;

export function createLocalSuiWallet(params: {
  privateKey: string;
  rpcUrl: string;
  chain?: string;
}): { wallet: Wallet; address: string } {
  const keypair = Ed25519Keypair.fromSecretKey(parseSuiPrivateKey(params.privateKey));
  const client = new SuiClient({ url: params.rpcUrl, network: "testnet" });
  const wallet = new LocalSuiWallet({
    keypair,
    client,
    chain: (params.chain || SUI_TESTNET_CHAIN) as `${string}:${string}`,
  });

  return { wallet, address: wallet.accounts[0].address };
}

export function getSuiAddressFromPrivateKey(privateKey: string): string {
  const keypair = Ed25519Keypair.fromSecretKey(parseSuiPrivateKey(privateKey));
  return keypair.getPublicKey().toSuiAddress();
}

function parseSuiPrivateKey(input: string): Uint8Array | string {
  if (input.startsWith("suiprivkey")) {
    return input;
  }

  const trimmed = input.startsWith("0x") ? input.slice(2) : input;
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    return fromHex(`0x${trimmed}`);
  }

  return fromBase64(input);
}

class LocalSuiWallet implements Wallet {
  readonly version = "1.0.0";
  readonly name = "TreasuryForge Local Sui Wallet";
  readonly icon =
    "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxMiIgZmlsbD0iIzE0MjMzNiIvPjxwYXRoIGQ9Ik0zMiAxN0M0MC4yODQzIDE3IDQ3IDE5LjkyNTMgNDcgMjMuNTQ1N0M0NyAyNy4xNjYgNDAuMjg0MyAzMC4wOTE0IDMyIDMwLjA5MTRDMjMuNzE1NyAzMC4wOTE0IDE3IDI3LjE2NiAxNyAyMy41NDU3QzE3IDE5LjkyNTMgMjMuNzE1NyAxNyAzMiAxN1oiIGZpbGw9IiM0OEZCRkYiLz48cGF0aCBkPSJNMzIgMzMuOTA4NkMzOS45MzM2IDMzLjkwODYgNDYuMzI0NCAzNi40NjU4IDQ2LjMyNDQgMzkuNjIxNUM0Ni4zMjQ0IDQyLjc3NzEgMzkuOTMzNiA0NS4zMzQzIDMyIDQ1LjMzNDNDMjQuMDY2NCA0NS4zMzQzIDE3LjY3NTYgNDIuNzc3MSAxNy42NzU2IDM5LjYyMTVDMTcuNjc1NiAzNi40NjU4IDI0LjA2NjQgMzMuOTA4NiAzMiAzMy45MDg2WiIgZmlsbD0iIzEwQjY4MSIvPjwvc3ZnPg==";

  private readonly keypair: Ed25519Keypair;
  private readonly client: SuiClient;
  private readonly chain: `${string}:${string}`;
  private connected = false;
  private listeners = new Map<string, Set<EventListener>>();

  readonly accounts: ReadonlyWalletAccount[];

  constructor(params: { keypair: Ed25519Keypair; client: SuiClient; chain: `${string}:${string}` }) {
    this.keypair = params.keypair;
    this.client = params.client;
    this.chain = params.chain;

    const publicKey = this.keypair.getPublicKey().toRawBytes();
    const address = this.keypair.getPublicKey().toSuiAddress();

    this.accounts = [
      new ReadonlyWalletAccount({
        address,
        publicKey,
        chains: [this.chain],
        features: [
          SuiSignTransaction,
          SuiSignAndExecuteTransaction,
          SuiSignTransactionBlock,
          SuiSignAndExecuteTransactionBlock,
          SuiSignPersonalMessage,
        ],
      }),
    ];
  }

  get chains(): IdentifierArray {
    return [this.chain] as IdentifierArray;
  }

  get features(): Record<string, any> {
    return {
      [StandardConnect]: {
        version: "1.0.0",
        connect: async () => {
          this.connected = true;
          this.emit("change", { accounts: this.accounts });
          return { accounts: this.accounts };
        },
      },
      [StandardEvents]: {
        version: "1.0.0",
        on: (event: string, listener: EventListener) => {
          const listeners = this.listeners.get(event) || new Set<EventListener>();
          listeners.add(listener);
          this.listeners.set(event, listeners);
          return () => listeners.delete(listener);
        },
      },
      [SuiSignTransaction]: {
        version: "1.0.0",
        signTransaction: async (input: any) => {
          const bytes = await this.buildTransactionBytes(input?.transaction);
          const { signature, bytes: base64Bytes } = await this.keypair.signTransaction(bytes);
          return { bytes: base64Bytes, signature };
        },
      },
      [SuiSignAndExecuteTransaction]: {
        version: "1.0.0",
        signAndExecuteTransaction: async (input: any) => {
          return this.client.signAndExecuteTransaction({
            transaction: input?.transaction,
            signer: this.keypair,
            ...(input?.options || {}),
          });
        },
      },
      [SuiSignTransactionBlock]: {
        version: "1.0.0",
        signTransactionBlock: async (input: any) => {
          const bytes = await this.buildTransactionBytes(input?.transactionBlock);
          const { signature, bytes: base64Bytes } = await this.keypair.signTransaction(bytes);
          return { bytes: base64Bytes, signature };
        },
      },
      [SuiSignAndExecuteTransactionBlock]: {
        version: "1.0.0",
        signAndExecuteTransactionBlock: async (input: any) => {
          return this.client.signAndExecuteTransaction({
            transaction: input?.transactionBlock,
            signer: this.keypair,
            ...(input?.options || {}),
          });
        },
      },
      [SuiSignPersonalMessage]: {
        version: "1.0.0",
        signPersonalMessage: async (input: any) => {
          return this.keypair.signPersonalMessage(input?.message);
        },
      },
    };
  }

  private emit(event: string, ...args: any[]) {
    const listeners = this.listeners.get(event);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(...args);
    }
  }

  private async buildTransactionBytes(transaction: any): Promise<Uint8Array> {
    if (!transaction) {
      throw new Error("Missing transaction for Sui wallet signing");
    }
    if (transaction instanceof Uint8Array) {
      return transaction;
    }
    if (typeof transaction?.build === "function") {
      if (typeof transaction.setSenderIfNotSet === "function") {
        transaction.setSenderIfNotSet(this.accounts[0].address);
      }
      return transaction.build({ client: this.client });
    }

    throw new Error("Unsupported Sui transaction type");
  }
}
