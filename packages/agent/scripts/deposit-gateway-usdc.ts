import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ path: "../../.env" });

type ChainConfig = {
  name: string;
  rpcUrl: string;
  usdcAddress: string;
  gatewayWallet: string;
};

const CHAINS: Record<string, ChainConfig> = {
  arc: {
    name: "arc",
    rpcUrl: process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network",
    usdcAddress: process.env.ARC_USDC_ADDRESS || "0x3600000000000000000000000000000000000000",
    gatewayWallet: process.env.GATEWAY_WALLET_ADDRESS || "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  },
  base: {
    name: "base",
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    usdcAddress: process.env.BASE_SEPOLIA_USDC_ADDRESS || "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    gatewayWallet: process.env.GATEWAY_WALLET_ADDRESS || "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  },
  ethereum: {
    name: "ethereum",
    rpcUrl: process.env.ETH_SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    usdcAddress: process.env.ETH_SEPOLIA_USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    gatewayWallet: process.env.GATEWAY_WALLET_ADDRESS || "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  },
  avalanche: {
    name: "avalanche",
    rpcUrl: process.env.AVAX_FUJI_RPC_URL || "https://api.avax-test.network/ext/bc/C/rpc",
    usdcAddress: process.env.AVAX_FUJI_USDC_ADDRESS || "0x5425890298aed601595a70AB815c96711a31Bc65",
    gatewayWallet: process.env.GATEWAY_WALLET_ADDRESS || "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  },
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

const GATEWAY_WALLET_ABI = [
  "function deposit(address token, uint256 amount) external",
];

function getArg(flag: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function requireEnv(label: string, value?: string) {
  if (!value) throw new Error(`${label} is required`);
}

async function main() {
  const chainKey = (getArg("--chain", "arc") || "arc").toLowerCase();
  const amountStr = getArg("--amount", process.env.GATEWAY_DEPOSIT_USDC || "1");
  if (!amountStr) throw new Error("Amount is required");

  const chain = CHAINS[chainKey];
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainKey}. Use arc|base|ethereum|avalanche`);
  }

  const privateKey =
    process.env.PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    process.env.EVM_PRIVATE_KEY ||
    "";
  requireEnv("PRIVATE_KEY", privateKey);

  const provider = new ethers.JsonRpcProvider(chain.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const usdc = new ethers.Contract(chain.usdcAddress, ERC20_ABI, wallet);
  const gateway = new ethers.Contract(chain.gatewayWallet, GATEWAY_WALLET_ABI, wallet);

  const amount = ethers.parseUnits(amountStr, 6);
  const balance = await usdc.balanceOf(wallet.address);
  console.log(`[Gateway] Wallet ${wallet.address} USDC balance: ${ethers.formatUnits(balance, 6)}`);
  if (balance < amount) {
    throw new Error(
      `Insufficient USDC: ${ethers.formatUnits(balance, 6)} < ${ethers.formatUnits(amount, 6)}`
    );
  }

  const allowance = await usdc.allowance(wallet.address, chain.gatewayWallet);
  if (allowance < amount) {
    console.log(`[Gateway] Approving USDC to GatewayWallet on ${chain.name}...`);
    const approveTx = await usdc.approve(chain.gatewayWallet, ethers.MaxUint256);
    await approveTx.wait();
  }

  console.log(`[Gateway] Depositing ${ethers.formatUnits(amount, 6)} USDC on ${chain.name}...`);
  const depositTx = await gateway.deposit(chain.usdcAddress, amount);
  const receipt = await depositTx.wait();
  console.log(`[Gateway] Deposit tx: ${receipt.hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
