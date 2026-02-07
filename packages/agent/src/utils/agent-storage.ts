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

export class AgentStorage {
  private db: Database.Database;
  private masterKey: Buffer;

  constructor(params?: { dbPath?: string; masterKey?: string }) {
    const dbPath = params?.dbPath || process.env.TREASURYFORGE_DB_PATH || DEFAULT_DB_PATH;
    const masterKey = params?.masterKey || process.env.SUI_KEYSTORE_MASTER_KEY;

    if (!masterKey) {
      throw new Error("Missing SUI_KEYSTORE_MASTER_KEY for encrypted storage");
    }

    this.masterKey = normalizeMasterKey(masterKey);

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
    `);
  }

  upsertSuiKey(user: string, suiAddress: string, suiPrivateKey: string): void {
    const now = Date.now();
    const encrypted = encryptString(suiPrivateKey, this.masterKey);

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

    const privateKey = decryptString(row.encryptedKey, this.masterKey);
    return { suiAddress: row.suiAddress, privateKey };
  }

  createSuiKey(user: string): { suiAddress: string; privateKey: string } {
    const now = Date.now();
    const keypair = Ed25519Keypair.generate();
    const suiAddress = keypair.getPublicKey().toSuiAddress();
    const privateKey = keypair.getSecretKey();
    const encrypted = encryptString(privateKey, this.masterKey);

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
