import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "treasuryforge.sqlite");
const ENC_VERSION = "v1";

export interface SuiKeyRecord {
  user: string;
  suiAddress: string;
  encryptedKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface SuiPositionRecord {
  user: string;
  chain: string;
  usdcAmount: string;
  poolShares: string;
  depositTime: number;
  bridgeTxHash?: string | null;
  status: string;
}

export interface AavePositionRecord {
  user: string;
  chain: string;
  protocol: string;
  asset: string;
  usdcAmount: string;
  aToken: string;
  apy: number;
  depositTime: number;
  txHash?: string | null;
  status: string;
  updatedAt: number;
}

export interface GatewayPositionRecord {
  user: string;
  destinationChain: string;
  amount: string;
  depositTime: number;
  txHash?: string | null;
  status: "active" | "blocked";
  lastAttempt: number;
  lastError?: string | null;
}

export class AgentStorage {
  private db: any;
  private masterKey: Buffer | null;

  constructor(params?: { dbPath?: string; masterKey?: string }) {
    const dbPath = params?.dbPath || process.env.TREASURYFORGE_DB_PATH || DEFAULT_DB_PATH;
    const masterKey = params?.masterKey || process.env.SUI_KEYSTORE_MASTER_KEY;

    if (!masterKey) {
      this.masterKey = null;
    } else {
      this.masterKey = normalizeMasterKey(masterKey);
    }

    ensureDir(path.dirname(dbPath));
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sui_keys (
        user TEXT PRIMARY KEY,
        sui_address TEXT NOT NULL,
        encrypted_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions (
        user TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        usdc_amount TEXT NOT NULL,
        pool_shares TEXT NOT NULL,
        deposit_time INTEGER NOT NULL,
        bridge_tx_hash TEXT,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aave_positions (
        user TEXT NOT NULL,
        chain TEXT NOT NULL,
        protocol TEXT NOT NULL,
        asset TEXT NOT NULL,
        usdc_amount TEXT NOT NULL,
        a_token TEXT NOT NULL,
        apy REAL NOT NULL,
        deposit_time INTEGER NOT NULL,
        tx_hash TEXT,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user, chain, protocol)
      );

      CREATE TABLE IF NOT EXISTS gateway_positions (
        user TEXT PRIMARY KEY,
        destination_chain TEXT NOT NULL,
        amount TEXT NOT NULL,
        deposit_time INTEGER NOT NULL,
        tx_hash TEXT,
        status TEXT NOT NULL,
        last_attempt INTEGER NOT NULL,
        last_error TEXT
      );
    `);
  }

  private requireMasterKey(): Buffer {
    if (!this.masterKey) {
      throw new Error("Missing SUI_KEYSTORE_MASTER_KEY for encrypted storage");
    }
    return this.masterKey;
  }

  upsertSuiKey(user: string, suiAddress: string, suiPrivateKey: string): void {
    const now = Date.now();
    const encrypted = encryptString(suiPrivateKey, this.requireMasterKey());

    const existing = this.db.prepare("SELECT user FROM sui_keys WHERE user = ?").get(user);
    if (existing) {
      this.db
        .prepare(
          `UPDATE sui_keys
           SET sui_address = ?, encrypted_key = ?, updated_at = ?
           WHERE user = ?`
        )
        .run(suiAddress, encrypted, now, user);
      return;
    }

    this.db
      .prepare(
        `INSERT INTO sui_keys (user, sui_address, encrypted_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(user, suiAddress, encrypted, now, now);
  }

  getSuiKey(user: string): { suiAddress: string; privateKey: string } | null {
    const row = this.db
      .prepare("SELECT sui_address as suiAddress, encrypted_key as encryptedKey FROM sui_keys WHERE user = ?")
      .get(user) as { suiAddress: string; encryptedKey: string } | undefined;

    if (!row) return null;

    const privateKey = decryptString(row.encryptedKey, this.requireMasterKey());
    return { suiAddress: row.suiAddress, privateKey };
  }

  createSuiKey(user: string): { suiAddress: string; privateKey: string } {
    const now = Date.now();
    const keypair = Ed25519Keypair.generate();
    const suiAddress = keypair.getPublicKey().toSuiAddress();
    const privateKey = keypair.getSecretKey();
    const encrypted = encryptString(privateKey, this.requireMasterKey());

    this.db
      .prepare(
        `INSERT OR REPLACE INTO sui_keys (user, sui_address, encrypted_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(user, suiAddress, encrypted, now, now);

    return { suiAddress, privateKey };
  }

  getSuiAddress(user: string): string | null {
    const row = this.db
      .prepare("SELECT sui_address as suiAddress FROM sui_keys WHERE user = ?")
      .get(user) as { suiAddress: string } | undefined;

    return row?.suiAddress || null;
  }

  listSuiKeys(): Array<{ user: string; suiAddress: string }> {
    const rows = this.db.prepare("SELECT user, sui_address as suiAddress FROM sui_keys").all() as Array<{
      user: string;
      suiAddress: string;
    }>;
    return rows;
  }

  upsertPosition(record: SuiPositionRecord): void {
    const existing = this.db.prepare("SELECT user FROM positions WHERE user = ?").get(record.user);

    if (existing) {
      this.db
        .prepare(
          `UPDATE positions
           SET chain = ?, usdc_amount = ?, pool_shares = ?, deposit_time = ?, bridge_tx_hash = ?, status = ?
           WHERE user = ?`
        )
        .run(
          record.chain,
          record.usdcAmount,
          record.poolShares,
          record.depositTime,
          record.bridgeTxHash || null,
          record.status,
          record.user
        );
      return;
    }

    this.db
      .prepare(
        `INSERT INTO positions (user, chain, usdc_amount, pool_shares, deposit_time, bridge_tx_hash, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.user,
        record.chain,
        record.usdcAmount,
        record.poolShares,
        record.depositTime,
        record.bridgeTxHash || null,
        record.status
      );
  }

  getPosition(user: string): SuiPositionRecord | null {
    const row = this.db.prepare("SELECT * FROM positions WHERE user = ?").get(user);
    return (row as SuiPositionRecord) || null;
  }

  listPositions(): SuiPositionRecord[] {
    return this.db.prepare("SELECT * FROM positions").all() as SuiPositionRecord[];
  }

  deletePosition(user: string): void {
    this.db.prepare("DELETE FROM positions WHERE user = ?").run(user);
  }

  upsertAavePosition(record: AavePositionRecord): void {
    const existing = this.db
      .prepare("SELECT user FROM aave_positions WHERE user = ? AND chain = ? AND protocol = ?")
      .get(record.user, record.chain, record.protocol);

    if (existing) {
      this.db
        .prepare(
          `UPDATE aave_positions
           SET asset = ?, usdc_amount = ?, a_token = ?, apy = ?, deposit_time = ?, tx_hash = ?, status = ?, updated_at = ?
           WHERE user = ? AND chain = ? AND protocol = ?`
        )
        .run(
          record.asset,
          record.usdcAmount,
          record.aToken,
          record.apy,
          record.depositTime,
          record.txHash || null,
          record.status,
          record.updatedAt,
          record.user,
          record.chain,
          record.protocol
        );
      return;
    }

    this.db
      .prepare(
        `INSERT INTO aave_positions
         (user, chain, protocol, asset, usdc_amount, a_token, apy, deposit_time, tx_hash, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.user,
        record.chain,
        record.protocol,
        record.asset,
        record.usdcAmount,
        record.aToken,
        record.apy,
        record.depositTime,
        record.txHash || null,
        record.status,
        record.updatedAt
      );
  }

  upsertGatewayPosition(record: GatewayPositionRecord): void {
    const existing = this.db.prepare("SELECT user FROM gateway_positions WHERE user = ?").get(record.user);
    if (existing) {
      this.db
        .prepare(
          `UPDATE gateway_positions
           SET destination_chain = ?, amount = ?, deposit_time = ?, tx_hash = ?, status = ?, last_attempt = ?, last_error = ?
           WHERE user = ?`
        )
        .run(
          record.destinationChain,
          record.amount,
          record.depositTime,
          record.txHash || null,
          record.status,
          record.lastAttempt,
          record.lastError || null,
          record.user
        );
      return;
    }

    this.db
      .prepare(
        `INSERT INTO gateway_positions
         (user, destination_chain, amount, deposit_time, tx_hash, status, last_attempt, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.user,
        record.destinationChain,
        record.amount,
        record.depositTime,
        record.txHash || null,
        record.status,
        record.lastAttempt,
        record.lastError || null
      );
  }

  getGatewayPosition(user: string): GatewayPositionRecord | null {
    const row = this.db.prepare("SELECT * FROM gateway_positions WHERE user = ?").get(user);
    if (!row) return null;
    const record = row as any;
    return {
      user: record.user,
      destinationChain: record.destination_chain,
      amount: record.amount,
      depositTime: record.deposit_time,
      txHash: record.tx_hash,
      status: record.status,
      lastAttempt: record.last_attempt,
      lastError: record.last_error,
    };
  }

  listGatewayPositions(): GatewayPositionRecord[] {
    const rows = this.db.prepare("SELECT * FROM gateway_positions").all() as any[];
    return rows.map((record) => ({
      user: record.user,
      destinationChain: record.destination_chain,
      amount: record.amount,
      depositTime: record.deposit_time,
      txHash: record.tx_hash,
      status: record.status,
      lastAttempt: record.last_attempt,
      lastError: record.last_error,
    }));
  }

  deleteGatewayPosition(user: string): void {
    this.db.prepare("DELETE FROM gateway_positions WHERE user = ?").run(user);
  }

  listAavePositions(): AavePositionRecord[] {
    return this.db.prepare("SELECT * FROM aave_positions").all() as AavePositionRecord[];
  }

  getAavePosition(user: string, chain: string, protocol: string): AavePositionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM aave_positions WHERE user = ? AND chain = ? AND protocol = ?")
      .get(user, chain, protocol);
    return (row as AavePositionRecord) || null;
  }
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeMasterKey(input: string): Buffer {
  if (input.startsWith("0x")) {
    const hex = input.slice(2);
    return ensureKeyLength(Buffer.from(hex, "hex"));
  }

  if (/^[0-9a-fA-F]+$/.test(input)) {
    return ensureKeyLength(Buffer.from(input, "hex"));
  }

  return ensureKeyLength(Buffer.from(input, "base64"));
}

function encryptString(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [ENC_VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

function ensureKeyLength(key: Buffer): Buffer {
  if (key.length === 32) return key;
  if (key.length > 32) return key.subarray(0, 32);
  return Buffer.concat([key, Buffer.alloc(32 - key.length)]);
}

function decryptString(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(":");
  if (version !== ENC_VERSION) {
    throw new Error("Unsupported encryption version");
  }

  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString("utf8");
}
