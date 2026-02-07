import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
const envPath = path.join(repoRoot, ".env");
const arcDir = path.join(repoRoot, "contracts", "arc");
const broadcastDir = path.join(
  arcDir,
  "broadcast",
  "DeployTreasuryVault.s.sol"
);

function parseEnvFile(content) {
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    env[key] = value;
  }
  return env;
}

function loadEnv() {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }
  const envContent = fs.readFileSync(envPath, "utf8");
  return parseEnvFile(envContent);
}

function runDeploy(env) {
  const rpcUrl = env.ARC_RPC_URL;
  if (!rpcUrl) throw new Error("ARC_RPC_URL is missing in .env");
  if (!env.PRIVATE_KEY) throw new Error("PRIVATE_KEY is missing in .env");
  if (!env.ARC_USDC_ADDRESS) throw new Error("ARC_USDC_ADDRESS is missing in .env");

  const cmd =
    "forge script script/DeployTreasuryVault.s.sol:DeployTreasuryVault " +
    `--rpc-url ${rpcUrl} --broadcast`;

  execSync(cmd, {
    cwd: arcDir,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

function findLatestBroadcast() {
  if (!fs.existsSync(broadcastDir)) {
    throw new Error(`Broadcast dir not found: ${broadcastDir}`);
  }

  const chainDirs = fs
    .readdirSync(broadcastDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(broadcastDir, d.name));

  let latestFile = null;
  let latestMtime = 0;

  for (const dir of chainDirs) {
    const candidate = path.join(dir, "run-latest.json");
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (stat.mtimeMs > latestMtime) {
      latestMtime = stat.mtimeMs;
      latestFile = candidate;
    }
  }

  if (!latestFile) {
    throw new Error("No run-latest.json found under broadcast directory");
  }

  return latestFile;
}

function extractVaultAddress(broadcastPath) {
  const json = JSON.parse(fs.readFileSync(broadcastPath, "utf8"));
  const tx = (json.transactions || []).find(
    (t) => t.contractName === "TreasuryVault" && t.contractAddress
  );
  if (!tx?.contractAddress) {
    throw new Error("TreasuryVault contractAddress not found in broadcast");
  }
  return String(tx.contractAddress);
}

function updateEnvFile(newAddress) {
  const envContent = fs.readFileSync(envPath, "utf8");

  const updateLine = (content, key, value) => {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(content)) {
      return content.replace(re, `${key}=${value}`);
    }
    return content + `\n${key}=${value}\n`;
  };

  let next = envContent;
  next = updateLine(next, "ARC_VAULT_ADDRESS", newAddress);
  next = updateLine(next, "VITE_VAULT_ADDRESS", newAddress);

  fs.writeFileSync(envPath, next, "utf8");
}

function main() {
  const env = loadEnv();
  runDeploy(env);

  const broadcastPath = findLatestBroadcast();
  const newAddress = extractVaultAddress(broadcastPath);

  updateEnvFile(newAddress);
  console.log(`Updated .env with ARC_VAULT_ADDRESS=${newAddress}`);
  console.log(`Updated .env with VITE_VAULT_ADDRESS=${newAddress}`);
}

main();
