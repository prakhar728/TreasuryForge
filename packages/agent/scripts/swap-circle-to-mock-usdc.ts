#!/usr/bin/env npx tsx
import "dotenv/config";
import { ethers } from "ethers";

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY || "";
const ROUTER = process.env.BASE_SEPOLIA_SWAP_ROUTER || "";
const FEE = Number(process.env.BASE_SEPOLIA_SWAP_FEE || "3000");

const CIRCLE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MOCK_USDC = "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
];

function requireEnv(name: string, value: string) {
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function main() {
  requireEnv("PRIVATE_KEY", PRIVATE_KEY);
  requireEnv("BASE_SEPOLIA_SWAP_ROUTER", ROUTER);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const amountIn = ethers.parseUnits(process.env.SWAP_AMOUNT_USDC || "1", 6);
  const usdc = new ethers.Contract(CIRCLE_USDC, ERC20_ABI, wallet);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);

  const balance = await usdc.balanceOf(wallet.address);
  console.log(`Circle USDC balance: ${ethers.formatUnits(balance, 6)}`);
  if (balance < amountIn) {
    throw new Error(`Insufficient Circle USDC: ${ethers.formatUnits(balance, 6)} < ${ethers.formatUnits(amountIn, 6)}`);
  }

  const allowance = await usdc.allowance(wallet.address, ROUTER);
  if (allowance < amountIn) {
    console.log("Approving router...");
    const approveTx = await usdc.approve(ROUTER, amountIn);
    await approveTx.wait();
    console.log(`Approve tx: ${approveTx.hash}`);
  }

  console.log("Swapping Circle USDC → mock USDC...");
  const params = {
    tokenIn: CIRCLE_USDC,
    tokenOut: MOCK_USDC,
    fee: FEE,
    recipient: wallet.address,
    amountIn,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  };

  const swapTx = await router.exactInputSingle(params);
  const receipt = await swapTx.wait();
  console.log(`Swap tx: ${receipt.hash}`);
}

main().catch((err) => {
  console.error("Swap failed:", err);
  process.exit(1);
});
