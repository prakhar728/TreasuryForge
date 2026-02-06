import { ethers } from "ethers";
import { Plugin, PluginContext, YieldOpportunity, RebalanceAction, ChainConfig } from "../types.js";
import { TREASURY_VAULT_ABI } from "../abi/TreasuryVault.js";
import { GATEWAY_WALLET_ABI, GATEWAY_MINTER_ABI, ERC20_ABI, CHAIN_DOMAINS } from "../abi/Gateway.js";

// ============================================================
// Cross-chain position tracking (in-memory for MVP)
// ============================================================
interface CrossChainPosition {
  user: string;
  sourceChain: string;
  destinationChain: string;
  amount: bigint;
  depositTime: number;
  depositTxHash?: string;
}

const crossChainPositions: Map<string, CrossChainPosition> = new Map();

// Minimum time before returning funds (demo: 2 minutes)
const MIN_HOLD_TIME_MS = 2 * 60 * 1000;

// Yield threshold to trigger cross-chain movement
const YIELD_DIFF_THRESHOLD = 1.0; // 1% higher yield required to move

// ============================================================
// Mock yield sources per chain (in production, query real protocols)
// ============================================================
interface ChainYield {
  chain: string;
  protocol: string;
  apy: number;
  tvl: number;
}

// Simulated yields - in production these would come from on-chain queries
function getMockChainYields(): ChainYield[] {
  // Add some randomness to simulate changing market conditions
  const noise = () => (Math.random() - 0.5) * 2; // ±1%

  return [
    { chain: "arc", protocol: "USYC", apy: 5.0 + noise(), tvl: 10_000_000 },
    { chain: "ethereum", protocol: "Aave-USDC", apy: 4.2 + noise(), tvl: 500_000_000 },
    { chain: "base", protocol: "Compound-USDC", apy: 6.5 + noise(), tvl: 50_000_000 },
    { chain: "avalanche", protocol: "Benqi-USDC", apy: 5.8 + noise(), tvl: 25_000_000 },
  ];
}

// ============================================================
// Gateway Operations
// ============================================================

async function getUnifiedBalance(ctx: PluginContext, chainConfig: ChainConfig): Promise<bigint> {
  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    const wallet = new ethers.Wallet(ctx.privateKey, provider);
    const minter = new ethers.Contract(chainConfig.gatewayMinter, GATEWAY_MINTER_ABI, wallet);

    const balance = await minter.unifiedBalance(wallet.address);
    return balance;
  } catch (error) {
    console.log(`[Gateway] Could not fetch unified balance on ${chainConfig.name}:`, error);
    return 0n;
  }
}

async function depositToGateway(
  ctx: PluginContext,
  sourceChain: ChainConfig,
  amount: bigint,
  destinationChain?: ChainConfig
): Promise<{ success: boolean; txHash?: string; mocked?: boolean }> {
  try {
    const provider = new ethers.JsonRpcProvider(sourceChain.rpcUrl);
    const wallet = new ethers.Wallet(ctx.privateKey, provider);

    // Check USDC balance
    const usdc = new ethers.Contract(sourceChain.usdcAddress, ERC20_ABI, wallet);
    const balance = await usdc.balanceOf(wallet.address);

    if (balance < amount) {
      console.log(`[Gateway] Insufficient USDC on ${sourceChain.name}: ${ethers.formatUnits(balance, 6)} < ${ethers.formatUnits(amount, 6)}`);
      // Return mocked success for demo
      return { success: true, mocked: true };
    }

    // Approve Gateway to spend USDC
    const gatewayWallet = new ethers.Contract(sourceChain.gatewayWallet, GATEWAY_WALLET_ABI, wallet);

    const allowance = await usdc.allowance(wallet.address, sourceChain.gatewayWallet);
    if (allowance < amount) {
      console.log(`[Gateway] Approving USDC for Gateway on ${sourceChain.name}...`);
      const approveTx = await usdc.approve(sourceChain.gatewayWallet, ethers.MaxUint256);
      await approveTx.wait();
    }

    // Deposit to Gateway
    let depositTx;
    if (destinationChain) {
      // Deposit with specific destination
      const destDomain = CHAIN_DOMAINS[destinationChain.name] || 0;
      const mintRecipient = ethers.zeroPadValue(wallet.address, 32);
      depositTx = await gatewayWallet["deposit(uint256,bytes32,bytes32)"](
        amount,
        ethers.zeroPadValue(ethers.toBeHex(destDomain), 32),
        mintRecipient
      );
    } else {
      // Deposit to unified balance
      depositTx = await gatewayWallet["deposit(uint256)"](amount);
    }

    const receipt = await depositTx.wait();
    console.log(`[Gateway] Deposited ${ethers.formatUnits(amount, 6)} USDC to Gateway on ${sourceChain.name}`);

    return { success: true, txHash: receipt.hash };
  } catch (error) {
    console.log(`[Gateway] Deposit failed on ${sourceChain.name}, using mock mode:`, error);
    // Return mocked for demo
    return { success: true, mocked: true };
  }
}

async function mintFromGateway(
  ctx: PluginContext,
  destinationChain: ChainConfig,
  amount: bigint
): Promise<{ success: boolean; txHash?: string; mocked?: boolean }> {
  try {
    const provider = new ethers.JsonRpcProvider(destinationChain.rpcUrl);
    const wallet = new ethers.Wallet(ctx.privateKey, provider);
    const minter = new ethers.Contract(destinationChain.gatewayMinter, GATEWAY_MINTER_ABI, wallet);

    // Check unified balance
    const unifiedBalance = await minter.unifiedBalance(wallet.address);
    if (unifiedBalance < amount) {
      console.log(`[Gateway] Insufficient unified balance: ${ethers.formatUnits(unifiedBalance, 6)} < ${ethers.formatUnits(amount, 6)}`);
      return { success: true, mocked: true };
    }

    // Mint USDC on destination chain
    const mintTx = await minter.mint(amount);
    const receipt = await mintTx.wait();

    console.log(`[Gateway] Minted ${ethers.formatUnits(amount, 6)} USDC on ${destinationChain.name}`);
    return { success: true, txHash: receipt.hash };
  } catch (error) {
    console.log(`[Gateway] Mint failed on ${destinationChain.name}, using mock mode:`, error);
    return { success: true, mocked: true };
  }
}

// ============================================================
// Contract Helpers
// ============================================================
function getVaultContract(ctx: PluginContext) {
  const provider = new ethers.JsonRpcProvider(ctx.arcRpcUrl);
  const signer = new ethers.Wallet(ctx.privateKey, provider);
  return new ethers.Contract(ctx.vaultAddress, TREASURY_VAULT_ABI, signer);
}

function findChainConfig(ctx: PluginContext, chainName: string): ChainConfig | undefined {
  return ctx.gatewayChains.find(c => c.name === chainName);
}

// ============================================================
// Plugin Implementation
// ============================================================
export const gatewayYieldPlugin: Plugin = {
  name: "gateway-yield",

  async monitor(ctx: PluginContext): Promise<YieldOpportunity[]> {
    // Get yield opportunities from all supported chains
    const chainYields = getMockChainYields();

    // Check for positions ready to return
    const readyToReturn = Array.from(crossChainPositions.values()).filter(
      (p) => Date.now() - p.depositTime >= MIN_HOLD_TIME_MS
    );
    if (readyToReturn.length > 0) {
      console.log(`[Gateway] ${readyToReturn.length} cross-chain position(s) ready to return`);
    }

    return chainYields.map(cy => ({
      front: cy.chain,
      yield: cy.apy,
      confidence: 0.8, // Mock confidence
      source: cy.protocol,
    }));
  },

  async evaluate(opportunities: YieldOpportunity[], ctx: PluginContext): Promise<boolean> {
    // Find Arc yield (our home chain)
    const arcOpp = opportunities.find(o => o.front === "arc");
    if (!arcOpp) return false;

    // Find best yield on other chains
    const otherChainOpps = opportunities.filter(o => o.front !== "arc");
    const bestOther = otherChainOpps.reduce((best, curr) =>
      curr.yield > best.yield ? curr : best,
      { yield: 0, front: "", confidence: 0, source: "" }
    );

    // Check if there are positions to return
    const hasReturnablePositions = Array.from(crossChainPositions.values()).some(
      (p) => Date.now() - p.depositTime >= MIN_HOLD_TIME_MS
    );

    // Should act if:
    // 1. Better yield elsewhere (by threshold amount)
    // 2. OR we have positions ready to return
    const yieldDiff = bestOther.yield - arcOpp.yield;
    const shouldBridge = yieldDiff >= YIELD_DIFF_THRESHOLD;

    if (shouldBridge) {
      console.log(
        `[Gateway] Found better yield on ${bestOther.front}: ${bestOther.yield.toFixed(2)}% vs Arc ${arcOpp.yield.toFixed(2)}% (diff: +${yieldDiff.toFixed(2)}%)`
      );
    }

    return shouldBridge || hasReturnablePositions;
  },

  async execute(ctx: PluginContext): Promise<RebalanceAction[]> {
    const vault = getVaultContract(ctx);
    const actions: RebalanceAction[] = [];
    const provider = new ethers.JsonRpcProvider(ctx.arcRpcUrl);
    const signer = new ethers.Wallet(ctx.privateKey, provider);

    // ============================================================
    // Phase 1: Return mature cross-chain positions to Arc
    // ============================================================
    for (const [posKey, position] of crossChainPositions.entries()) {
      if (Date.now() - position.depositTime < MIN_HOLD_TIME_MS) {
        const remainingSecs = Math.ceil((MIN_HOLD_TIME_MS - (Date.now() - position.depositTime)) / 1000);
        console.log(`[Gateway] Position for ${position.user.slice(0, 10)}... on ${position.destinationChain} needs ${remainingSecs}s more`);
        continue;
      }

      console.log(`[Gateway] Returning position from ${position.destinationChain} to Arc for ${position.user.slice(0, 10)}...`);

      const destChain = findChainConfig(ctx, position.destinationChain);
      const arcChain = findChainConfig(ctx, "arc");

      if (!destChain || !arcChain) {
        console.log(`[Gateway] Chain config not found, using mock mode`);

        // Simulate profit (1% for demo visibility)
        const profit = position.amount / 100n;
        const totalReturn = position.amount + profit;

        // Mock repay
        try {
          const repayTx = await vault.repayRWA(totalReturn);
          const receipt = await repayTx.wait();

          actions.push({
            type: "repay",
            chain: "arc",
            amount: totalReturn,
            details: {
              user: position.user,
              profit: profit.toString(),
              fromChain: position.destinationChain,
              mocked: true,
            },
            txHash: receipt.hash,
          });

          console.log(`[Gateway] Repaid ${ethers.formatUnits(totalReturn, 6)} USDC (profit: ${ethers.formatUnits(profit, 6)}) [SIMULATED]`);
        } catch (error) {
          console.error(`[Gateway] Repay failed:`, error);
        }

        crossChainPositions.delete(posKey);
        continue;
      }

      // Step 1: Deposit to Gateway on destination chain
      const depositResult = await depositToGateway(ctx, destChain, position.amount);

      if (depositResult.success) {
        actions.push({
          type: "bridge",
          chain: position.destinationChain,
          amount: position.amount,
          details: {
            direction: "return",
            from: position.destinationChain,
            to: "arc",
            mocked: depositResult.mocked,
          },
          txHash: depositResult.txHash,
        });
      }

      // Step 2: Mint on Arc
      const mintResult = await mintFromGateway(ctx, arcChain, position.amount);

      // Step 3: Repay vault with profit
      const profit = position.amount / 100n; // 1% profit for demo
      const totalReturn = position.amount + profit;

      try {
        const repayTx = await vault.repayRWA(totalReturn);
        const receipt = await repayTx.wait();

        actions.push({
          type: "repay",
          chain: "arc",
          amount: totalReturn,
          details: {
            user: position.user,
            profit: profit.toString(),
            fromChain: position.destinationChain,
            mocked: mintResult.mocked,
          },
          txHash: receipt.hash,
        });

        console.log(`[Gateway] Repaid ${ethers.formatUnits(totalReturn, 6)} USDC via Gateway`);
      } catch (error) {
        console.error(`[Gateway] Repay failed:`, error);
      }

      crossChainPositions.delete(posKey);
    }

    // ============================================================
    // Phase 2: Find new cross-chain opportunities
    // ============================================================

    // Get current yields
    const chainYields = getMockChainYields();
    const arcYield = chainYields.find(c => c.chain === "arc")?.apy || 5.0;
    const bestYield = chainYields.reduce((best, curr) =>
      curr.apy > best.apy && curr.chain !== "arc" ? curr : best,
      { chain: "", apy: 0, protocol: "", tvl: 0 }
    );

    if (bestYield.apy - arcYield < YIELD_DIFF_THRESHOLD) {
      console.log(`[Gateway] No cross-chain opportunity (best: ${bestYield.chain} ${bestYield.apy.toFixed(2)}% vs Arc ${arcYield.toFixed(2)}%)`);
      return actions;
    }

    // Look for depositors with cross-chain policy
    const depositFilter = vault.filters.Deposited();
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, currentBlock - 5000);
    const events = await vault.queryFilter(depositFilter, fromBlock, currentBlock);

    const depositors = [...new Set(
      events
        .filter((e): e is ethers.EventLog => "args" in e)
        .map((e) => e.args[0] as string)
    )];

    console.log(`[Gateway] Checking ${depositors.length} depositor(s) for cross-chain opportunities`);

    for (const user of depositors) {
      try {
        // Skip if already has cross-chain position
        const posKey = `${user}-gateway`;
        if (crossChainPositions.has(posKey)) {
          console.log(`[Gateway] ${user.slice(0, 10)}... already has cross-chain position`);
          continue;
        }

        const [amount, , active] = await vault.userDeposits(user);
        if (!active) continue;

        const policy = await vault.getPolicy(user);
        if (!policy.enabled) continue;

        // Check if strategy includes DeFi or cross-chain
        // Strategy enum: 0=DeFi_Yield, 1=RWA_Loan, 2=Stablecoin_Carry
        const strategy = Number(policy.strategy);
        if (strategy !== 0 && strategy !== 2) {
          // Only DeFi_Yield and Stablecoin_Carry use cross-chain
          continue;
        }

        // Check if already borrowed for this user
        const borrowed = await vault.getBorrowedRWA(user);
        if (borrowed.amount > 0n) {
          continue;
        }

        // Calculate borrow amount (25% of deposit for cross-chain, more conservative)
        const maxBorrow = policy.maxBorrowAmount;
        const quarterDeposit = amount / 4n;
        const borrowAmount = maxBorrow < quarterDeposit ? maxBorrow : quarterDeposit;

        if (borrowAmount === 0n) continue;

        console.log(`[Gateway] Processing ${user.slice(0, 10)}... for cross-chain to ${bestYield.chain}`);

        // Step 1: Borrow from vault
        const borrowTx = await vault.borrowRWA(user, borrowAmount, ctx.usdcAddress);
        const borrowReceipt = await borrowTx.wait();

        actions.push({
          type: "borrow",
          chain: "arc",
          amount: borrowAmount,
          details: { user, strategy: "DeFi_Yield", destination: bestYield.chain },
          txHash: borrowReceipt.hash,
        });

        console.log(`[Gateway] Borrow tx: ${borrowReceipt.hash}`);

        // Step 2: Bridge to best yield chain via Gateway
        const arcChain = findChainConfig(ctx, "arc");
        const destChain = findChainConfig(ctx, bestYield.chain);

        let bridgeMocked = true;
        if (arcChain && destChain) {
          const depositResult = await depositToGateway(ctx, arcChain, borrowAmount, destChain);
          bridgeMocked = depositResult.mocked || false;

          if (depositResult.success) {
            actions.push({
              type: "bridge",
              chain: "arc",
              amount: borrowAmount,
              details: {
                direction: "outbound",
                from: "arc",
                to: bestYield.chain,
                protocol: bestYield.protocol,
                mocked: bridgeMocked,
              },
              txHash: depositResult.txHash,
            });
          }
        }

        // Track position
        crossChainPositions.set(posKey, {
          user,
          sourceChain: "arc",
          destinationChain: bestYield.chain,
          amount: borrowAmount,
          depositTime: Date.now(),
        });

        console.log(
          `[Gateway] Bridged ${ethers.formatUnits(borrowAmount, 6)} USDC to ${bestYield.chain} ` +
          `for ${bestYield.protocol} (${bestYield.apy.toFixed(2)}% APY)` +
          (bridgeMocked ? " [SIMULATED]" : "")
        );

      } catch (error) {
        console.error(`[Gateway] Error processing ${user}:`, error);
      }
    }

    return actions;
  },
};
