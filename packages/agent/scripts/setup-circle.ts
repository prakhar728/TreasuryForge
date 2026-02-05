#!/usr/bin/env npx tsx
/// <reference types="node" />
/**
 * One-time setup script for Circle Developer-Controlled Wallets
 *
 * Run: npm run setup:circle
 *
 * This will:
 * 1. Generate an Entity Secret (32-byte hex)
 * 2. Get Circle's public key
 * 3. Encrypt and register the entity secret
 * 4. Create a Wallet Set
 * 5. Output values to add to .env
 */

import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import axios from "axios";

const CIRCLE_API_URL = "https://api.circle.com/v1/w3s";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      resolve(answer.trim());
    });
  });
}

// Generate a 32-byte hex entity secret
function generateEntitySecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

// Fetch Circle's public key for encryption
async function getPublicKey(apiKey: string): Promise<string> {
  const response = await axios.get(`${CIRCLE_API_URL}/config/entity/publicKey`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  return response.data.data.publicKey;
}

// Encrypt entity secret with Circle's RSA public key
function encryptEntitySecret(entitySecret: string, publicKeyPem: string): string {
  const entitySecretBuffer = Buffer.from(entitySecret, "hex");
  const encrypted = crypto.publicEncrypt(
    {
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    entitySecretBuffer
  );
  return encrypted.toString("base64");
}

// Register the entity secret ciphertext with Circle
async function registerEntitySecret(
  apiKey: string,
  ciphertext: string
): Promise<{ recoveryFile?: string }> {
  const response = await axios.post(
    `${CIRCLE_API_URL}/config/entity/entitySecret`,
    { entitySecretCiphertext: ciphertext },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    }
  );
  return response.data.data;
}

async function main(): Promise<void> {
  console.log("\n===========================================");
  console.log("  Circle Developer-Controlled Wallets Setup");
  console.log("===========================================\n");

  // Get API key from user
  const apiKey = await prompt("Enter your Circle API Key: ");

  if (!apiKey) {
    console.error("API key is required");
    process.exit(1);
  }

  // Step 1: Generate Entity Secret
  console.log("\n[1/5] Generating Entity Secret...");
  const entitySecret = generateEntitySecret();
  console.log("Entity Secret generated (32 bytes hex)");
  console.log(`  Secret: ${entitySecret.slice(0, 8)}...${entitySecret.slice(-8)}`);

  // Step 2: Get Circle's public key
  console.log("\n[2/5] Fetching Circle's public key...");
  let publicKey = "";
  try {
    publicKey = await getPublicKey(apiKey);
    console.log("Public key retrieved");
  } catch (error: unknown) {
    const err = error as { response?: { data?: unknown }; message?: string };
    console.error("Failed to get public key:", err.response?.data || err.message);
    console.log("\nSave your Entity Secret:", entitySecret);
    console.log("You can register manually at https://console.circle.com");
    rl.close();
    process.exit(1);
  }

  // Step 3: Encrypt and register
  console.log("\n[3/5] Encrypting and registering Entity Secret...");
  try {
    const ciphertext = encryptEntitySecret(entitySecret, publicKey);
    const result = await registerEntitySecret(apiKey, ciphertext);

    // Save recovery file
    if (result.recoveryFile) {
      const recoveryPath = path.join(process.cwd(), "circle-recovery.backup");
      fs.writeFileSync(recoveryPath, result.recoveryFile);
      console.log("Entity Secret registered");
      console.log(`Recovery file saved to: ${recoveryPath}`);
      console.log("\nIMPORTANT: Move the recovery file to a secure location!");
    } else {
      console.log("Entity Secret registered (no recovery file returned)");
    }
  } catch (error: unknown) {
    const err = error as { response?: { data?: { message?: string } }; message?: string };
    const errMsg = err.response?.data?.message || err.message || "";
    if (errMsg.includes("already registered") || errMsg.includes("already exists")) {
      console.log("Entity Secret already registered for this account");
      console.log("Using existing registration...");
    } else {
      console.error("Failed to register entity secret:", err.response?.data || err.message);
      console.log("\nSave your Entity Secret:", entitySecret);
      console.log("You can register manually at https://console.circle.com");
      rl.close();
      process.exit(1);
    }
  }

  // Step 4: Create Wallet Set
  console.log("\n[4/5] Creating Wallet Set...");

  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  let walletSetId = "";
  try {
    const walletSetResponse = await client.createWalletSet({
      name: "TreasuryForge-WalletSet",
    });

    walletSetId = walletSetResponse.data?.walletSet?.id || "";

    if (!walletSetId) {
      throw new Error("No wallet set ID returned");
    }

    console.log("Wallet Set created:", walletSetId);
  } catch (error: unknown) {
    const err = error as { response?: { data?: unknown }; message?: string };
    console.error("Failed to create wallet set:", err.response?.data || err.message);
    console.log("\nSave your Entity Secret:", entitySecret);
    console.log("You can create a wallet set manually in the Circle Console");
    rl.close();
    process.exit(1);
  }

  // Step 5: Output .env values
  console.log("\n[5/5] Setup Complete!");
  console.log("\n===========================================");
  console.log("  Add these to your .env file:");
  console.log("===========================================\n");
  console.log(`CIRCLE_API_KEY=${apiKey}`);
  console.log(`CIRCLE_API_URL=https://api.circle.com`);
  console.log(`CIRCLE_WALLET_ID=${walletSetId}`);
  console.log(`CIRCLE_ENTITY_SECRET=${entitySecret}`);
  console.log("\n===========================================\n");

  // Save to a local file for reference
  const envOutput = `# Circle Configuration (generated ${new Date().toISOString()})
CIRCLE_API_KEY=${apiKey}
CIRCLE_API_URL=https://api.circle.com
CIRCLE_WALLET_ID=${walletSetId}
CIRCLE_ENTITY_SECRET=${entitySecret}
`;

  const configPath = path.join(process.cwd(), "circle-config.generated.txt");
  fs.writeFileSync(configPath, envOutput);
  console.log("Config also saved to: circle-config.generated.txt");
  console.log("(Delete this file after copying to .env)\n");

  rl.close();
}

main().catch((err: Error) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
