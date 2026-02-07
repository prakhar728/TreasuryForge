import React, { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";

interface DepositUIProps {
  vaultAddress: string;
  usdcAddress: string;
  agentApiUrl: string;
}

const VAULT_ABI = [
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount) external",
  "function requestWithdraw(uint256 amount) external",
  "function cancelWithdraw() external",
  "function getWithdrawRequest(address user) external view returns (tuple(uint256 amount, uint256 requestTime, bool pending))",
  "function balanceOf(address user) external view returns (uint256)",
  "function setPolicy(uint256 yieldThreshold, uint256 maxBorrowAmount, string calldata strategy) external",
  "function getPolicy(address user) external view returns (tuple(uint256 yieldThreshold, uint256 maxBorrowAmount, bool enabled, string strategy))",
  "function getBorrowedRWA(address user) external view returns (tuple(uint256 amount, uint256 borrowTime, address rwaToken))",
  "function getVaultStats() external view returns (uint256 tvl, uint256 totalBorrows, uint256 numUsers)",
  "function userDeposits(address) external view returns (uint256 amount, uint256 timestamp, bool active)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function allowance(address owner, address spender) public view returns (uint256)",
  "function balanceOf(address account) public view returns (uint256)",
  "function decimals() public view returns (uint8)",
];

const ARC_CHAIN_ID = parseInt(import.meta.env.VITE_ARC_CHAIN_ID || "5042002");
const ARC_NATIVE_USDC = "0x3600000000000000000000000000000000000000";

export const DepositUI: React.FC<DepositUIProps> = ({
  vaultAddress,
  usdcAddress,
}) => {
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [yieldThreshold, setYieldThreshold] = useState("5");
  const [maxBorrow, setMaxBorrow] = useState("");
  const [strategy, setStrategy] = useState("DeFi_Yield");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [withdrawRequestedAmount, setWithdrawRequestedAmount] = useState("0");
  const [withdrawRequestedAt, setWithdrawRequestedAt] = useState<number | null>(null);
  const [withdrawPending, setWithdrawPending] = useState(false);
  const [agentManagedSui, setAgentManagedSui] = useState(false);

  // Wallet state
  const [connected, setConnected] = useState(false);
  const [userAddress, setUserAddress] = useState("");

  // Balance state
  const [walletUsdc, setWalletUsdc] = useState("0");
  const [vaultBalance, setVaultBalance] = useState("0");
  const [vaultTvl, setVaultTvl] = useState("0");
  const [totalBorrows, setTotalBorrows] = useState("0");
  const [borrowedAmount, setBorrowedAmount] = useState("0");
  const [hasPolicy, setHasPolicy] = useState(false);
  const [currentPolicy, setCurrentPolicy] = useState<string | null>(null);

  const getEthereumProvider = () => {
    const ethereum = window.ethereum;
    if (!ethereum) return null;
    const providers = (ethereum as any).providers;
    if (Array.isArray(providers)) {
      const metaMask = providers.find((p) => p.isMetaMask);
      return metaMask || providers[0];
    }
    return ethereum;
  };

  const getSigner = async () => {
    const providerSource = getEthereumProvider();
    if (!providerSource) throw new Error("No wallet found");
    const provider = new ethers.BrowserProvider(providerSource);
    return provider.getSigner();
  };

  const connectWallet = async () => {
    try {
      const providerSource = getEthereumProvider();
      if (!providerSource) {
        setStatus("error");
        setMessage("Install MetaMask to continue");
        return;
      }

      const provider = new ethers.BrowserProvider(providerSource);
      await provider.send("eth_requestAccounts", []);

      // Check/switch to Arc chain
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== ARC_CHAIN_ID) {
        try {
          await providerSource.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + ARC_CHAIN_ID.toString(16) }],
          });
        } catch (switchError: any) {
          // Chain not added — add it
          if (switchError.code === 4902) {
            await providerSource.request({
              method: "wallet_addEthereumChain",
              params: [{
                chainId: "0x" + ARC_CHAIN_ID.toString(16),
                chainName: "Arc Testnet",
                rpcUrls: [import.meta.env.VITE_ARC_RPC_URL || "https://rpc.testnet.arc.network"],
                blockExplorerUrls: ["https://testnet.arcscan.app"],
                nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
              }],
            });
          }
        }
      }

      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      setUserAddress(address);
      setConnected(true);
      setMessage("");
    } catch (error) {
      console.error("Connect failed:", error);
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Failed to connect");
    }
  };

  const switchAccount = async () => {
    try {
      const providerSource = getEthereumProvider();
      if (!providerSource) {
        setStatus("error");
        setMessage("Install MetaMask to continue");
        return;
      }

      await providerSource.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });

      await connectWallet();
    } catch (error) {
      console.error("Switch account failed:", error);
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Failed to switch account");
    }
  };

  const disconnectWallet = () => {
    setConnected(false);
    setUserAddress("");
    setWalletUsdc("0");
    setVaultBalance("0");
    setVaultTvl("0");
    setTotalBorrows("0");
    setBorrowedAmount("0");
    setHasPolicy(false);
    setCurrentPolicy(null);
    setWithdrawPending(false);
    setWithdrawRequestedAmount("0");
    setWithdrawRequestedAt(null);
    setStatus("idle");
    setMessage("");
  };

  const fetchBalances = useCallback(async () => {
    if (!connected || !userAddress) return;
    try {
      const signer = await getSigner();
      const provider = signer.provider;

      // Verify we're on the right chain
      if (provider) {
        const network = await provider.getNetwork();
        const chainId = Number(network.chainId);
        if (chainId !== ARC_CHAIN_ID) {
          console.error(`Wrong chain: connected to ${chainId}, expected ${ARC_CHAIN_ID}`);
          setMessage(`Wrong network (chain ${chainId}). Please switch to Arc Testnet.`);
          setStatus("error");
          return;
        }

        // Verify contract exists
        const code = await provider.getCode(vaultAddress);
        if (code === "0x" || code === "0x0" || !code) {
          console.error(`No contract at vault address ${vaultAddress} on chain ${chainId}`);
          setMessage(`Vault contract not found at ${vaultAddress.slice(0, 10)}... on Arc Testnet. Check the RPC URL in MetaMask.`);
          setStatus("error");
          return;
        }
      }

      const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
      const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);

      // Fetch each independently so one failure doesn't block all
      const [userDeposit, stats, borrowed, policy, withdrawRequest] = await Promise.all([
        vault.userDeposits(userAddress).catch((e: any) => { console.error("userDeposits:", e.message); return [0n, 0n, false]; }),
        vault.getVaultStats().catch((e: any) => { console.error("getVaultStats:", e.message); return [0n, 0n, 0n]; }),
        vault.getBorrowedRWA(userAddress).catch((e: any) => { console.error("getBorrowedRWA:", e.message); return [0n, 0n, ethers.ZeroAddress]; }),
        vault.getPolicy(userAddress).catch((e: any) => { console.error("getPolicy:", e.message); return { yieldThreshold: 0n, maxBorrowAmount: 0n, enabled: false, strategy: "" }; }),
        vault.getWithdrawRequest(userAddress).catch((e: any) => { console.error("getWithdrawRequest:", e.message); return { amount: 0n, requestTime: 0n, pending: false }; }),
      ]);

      // Wallet balance: try ERC20 balanceOf first, then native getBalance as fallback
      let walletBalanceFormatted = "0";
      try {
        const erc20Bal = await usdc.balanceOf(userAddress);
        if (erc20Bal > 0n) {
          const decimals = await usdc.decimals().catch(() => 6);
          walletBalanceFormatted = ethers.formatUnits(erc20Bal, decimals);
        }
      } catch {
        // ERC20 call failed — expected if native USDC precompile doesn't support it
      }
      // If ERC20 returned 0 or failed, try native balance
      if (walletBalanceFormatted === "0" && provider) {
        try {
          const nativeBal = await provider.getBalance(userAddress);
          if (nativeBal > 0n) {
            walletBalanceFormatted = ethers.formatUnits(nativeBal, 6);
          }
        } catch (e: any) {
          console.error("getBalance:", e.message);
        }
      }

      setWalletUsdc(walletBalanceFormatted);
      setVaultBalance(ethers.formatUnits(userDeposit[0] ?? 0n, 6));
      setVaultTvl(ethers.formatUnits(stats[0] ?? 0n, 6));
      setTotalBorrows(ethers.formatUnits(stats[1] ?? 0n, 6));
      setBorrowedAmount(ethers.formatUnits(borrowed[0] ?? 0n, 6));

      if (policy.enabled) {
        setHasPolicy(true);
        setCurrentPolicy(`${Number(policy.yieldThreshold) / 100}% / ${policy.strategy}`);
      }

      setWithdrawPending(withdrawRequest.pending);
      setWithdrawRequestedAmount(ethers.formatUnits(withdrawRequest.amount || 0n, 6));
      setWithdrawRequestedAt(Number(withdrawRequest.requestTime || 0));
      setAgentManagedSui(userDeposit[2] || false);
    } catch (error) {
      console.error("Fetch balances error:", error);
    }
  }, [connected, userAddress, usdcAddress, vaultAddress]);

  useEffect(() => {
    if (connected) fetchBalances();
  }, [connected, fetchBalances]);

  const approveUSDC = async () => {
    try {
      setStatus("loading");
      setMessage("Approving USDC...");
      const signer = await getSigner();
      const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
      const amount = ethers.parseUnits(depositAmount, 6);

      const tx = await usdc.approve(vaultAddress, amount);
      setMessage("Waiting for confirmation...");
      await tx.wait();

      setStatus("success");
      setMessage("USDC approved!");
    } catch (error) {
      console.error("Approve failed:", error);
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Approval failed");
    }
  };

  const handleDeposit = async () => {
    try {
      setStatus("loading");
      setMessage("Depositing USDC...");
      const signer = await getSigner();
      const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
      const amount = ethers.parseUnits(depositAmount, 6);

      const tx = await vault.deposit(amount);
      setMessage("Waiting for confirmation...");
      const receipt = await tx.wait();

      setStatus("success");
      setMessage(`Deposited ${depositAmount} USDC! Tx: ${receipt.hash.slice(0, 10)}...`);
      setDepositAmount("");

      // Set policy if filled
      if (yieldThreshold && maxBorrow) {
        setMessage("Setting policy...");
        const threshold = Math.floor(parseFloat(yieldThreshold) * 100);
        const maxBorrowAmount = ethers.parseUnits(maxBorrow, 6);
        const policyTx = await vault.setPolicy(threshold, maxBorrowAmount, strategy);
        await policyTx.wait();
        setMessage(`Deposit + policy set! Tx: ${receipt.hash.slice(0, 10)}...`);
      }

      await fetchBalances();
    } catch (error) {
      console.error("Deposit failed:", error);
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Deposit failed");
    }
  };

  const handleWithdraw = async () => {
    try {
      setStatus("loading");
      setMessage("Requesting withdrawal...");
      const signer = await getSigner();
      const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
      const amount = ethers.parseUnits(withdrawAmount, 6);

      const tx = await vault.requestWithdraw(amount);
      setMessage("Waiting for confirmation...");
      await tx.wait();

      setStatus("success");
      setMessage(`Withdrawal requested for ${withdrawAmount} USDC`);
      setWithdrawAmount("");
      await fetchBalances();
    } catch (error) {
      console.error("Withdraw failed:", error);
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Withdraw failed");
    }
  };

  const handleCancelWithdraw = async () => {
    try {
      setStatus("loading");
      setMessage("Canceling withdrawal request...");
      const signer = await getSigner();
      const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);

      const tx = await vault.cancelWithdraw();
      setMessage("Waiting for confirmation...");
      await tx.wait();

      setStatus("success");
      setMessage("Withdrawal request canceled");
      await fetchBalances();
    } catch (error) {
      console.error("Cancel withdraw failed:", error);
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Cancel failed");
    }
  };


  // ── Not connected ──
  if (!connected) {
    return (
      <div className="w-full max-w-md mx-auto rounded-2xl border border-white/10 bg-white/5 p-8 text-center shadow-[0_0_40px_rgba(15,23,42,0.35)]">
        <h2 className="text-3xl font-semibold text-white mb-4">TreasuryForge</h2>
        <p className="text-white/60 mb-6">Connect your wallet to deposit USDC and set yield policies.</p>
        <button
          onClick={connectWallet}
          className="px-6 py-3 rounded-xl bg-emerald-400/90 text-black font-semibold hover:bg-emerald-300 transition"
        >
          Connect Wallet
        </button>
        {message && (
          <p className="mt-4 text-sm text-rose-300">{message}</p>
        )}
      </div>
    );
  }

  // ── Connected ──
  return (
    <div className="w-full max-w-md mx-auto space-y-4 text-white">
      {/* Wallet Info */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/5 shadow-[0_0_40px_rgba(15,23,42,0.35)]">
        <div className="flex justify-between items-center mb-3">
          <span className="text-sm text-white/50">Connected</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono bg-emerald-500/20 text-emerald-200 px-2 py-1 rounded">
              {userAddress.slice(0, 6)}...{userAddress.slice(-4)}
            </span>
            <button
              onClick={disconnectWallet}
              className="text-xs px-2 py-1 rounded bg-white/10 text-white/70 hover:bg-white/20 transition"
            >
              Forget Session
            </button>
            <button
              onClick={switchAccount}
              className="text-xs px-2 py-1 rounded bg-sky-400/10 text-sky-200 hover:bg-sky-400/20 transition"
            >
              Switch Account
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white/5 rounded-xl p-3 border border-white/10">
            <p className="text-xs text-white/50">Wallet USDC</p>
            <p className="text-lg font-semibold">{parseFloat(walletUsdc).toFixed(2)}</p>
          </div>
          <div className="bg-white/5 rounded-xl p-3 border border-white/10">
            <p className="text-xs text-white/50">In Vault</p>
            <p className="text-lg font-semibold">{parseFloat(vaultBalance).toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* Vault Stats */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/5 shadow-[0_0_40px_rgba(15,23,42,0.35)]">
        <h3 className="text-sm font-semibold text-white/70 mb-2">Vault Stats</h3>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-xs text-white/50">TVL</p>
            <p className="font-semibold text-sm">${parseFloat(vaultTvl).toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-white/50">Borrows</p>
            <p className="font-semibold text-sm">${parseFloat(totalBorrows).toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-white/50">Your Borrow</p>
            <p className="font-semibold text-sm">${parseFloat(borrowedAmount).toFixed(2)}</p>
          </div>
        </div>
        {hasPolicy && currentPolicy && (
          <p className="mt-2 text-xs text-white/50">Policy: {currentPolicy}</p>
        )}
      </div>

      {/* Deposit */}
      <div className="p-4 rounded-2xl border border-white/10 bg-white/5 shadow-[0_0_40px_rgba(15,23,42,0.35)]">
        <h3 className="text-sm font-semibold text-white/70 mb-3">Deposit USDC</h3>

        <input
          type="number"
          value={depositAmount}
          onChange={(e) => setDepositAmount(e.target.value)}
          placeholder="Amount (USDC)"
          className="w-full px-3 py-2 mb-3 rounded-lg border border-white/10 bg-white/5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-300/60"
        />

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-white/50 mb-1">Yield Threshold (%)</label>
            <input
              type="number"
              value={yieldThreshold}
              onChange={(e) => setYieldThreshold(e.target.value)}
              step="0.1"
              className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-300/60"
            />
          </div>
          <div>
            <label className="block text-xs text-white/50 mb-1">Max Borrow (USDC)</label>
            <input
              type="number"
              value={maxBorrow}
              onChange={(e) => setMaxBorrow(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-emerald-300/60"
            />
          </div>
        </div>

        <select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          className="w-full px-3 py-2 mb-3 rounded-lg border border-white/10 bg-white/5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-300/60"
        >
          <option value="DeFi_Yield">DeFi Yield</option>
          <option value="RWA_Loan">RWA Loan</option>
          <option value="Stablecoin_Carry">Stablecoin Carry</option>
        </select>

        <div className="flex gap-2">
          <button
            onClick={approveUSDC}
            disabled={status === "loading" || !depositAmount}
            className="flex-1 px-3 py-2 rounded-lg bg-amber-400/80 text-black font-semibold hover:bg-amber-300 disabled:bg-white/10 transition text-sm"
          >
            Approve
          </button>
          <button
            onClick={handleDeposit}
            disabled={status === "loading" || !depositAmount}
            className="flex-1 px-3 py-2 rounded-lg bg-emerald-400/90 text-black font-semibold hover:bg-emerald-300 disabled:bg-white/10 transition text-sm"
          >
            Deposit & Set Policy
          </button>
        </div>
      </div>

      {/* Withdraw */}
      {parseFloat(vaultBalance) > 0 && (
        <div className="p-4 rounded-2xl border border-white/10 bg-white/5 shadow-[0_0_40px_rgba(15,23,42,0.35)]">
          <h3 className="text-sm font-semibold text-white/70 mb-3">Withdraw (Request)</h3>
          <div className="flex gap-2">
            <input
              type="number"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              placeholder="Amount"
              className="flex-1 px-3 py-2 rounded-lg border border-white/10 bg-white/5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-rose-300/60"
            />
            <button
              onClick={handleWithdraw}
              disabled={status === "loading" || !withdrawAmount}
              className="px-4 py-2 rounded-lg bg-rose-400/90 text-black font-semibold hover:bg-rose-300 disabled:bg-white/10 transition text-sm"
            >
              Request
            </button>
          </div>
          {parseFloat(borrowedAmount) > 0 && (
            <p className="mt-2 text-xs text-amber-300">Repay borrow before withdrawing</p>
          )}
          {withdrawPending && (
            <div className="mt-3 text-xs text-white/60">
              <p>Pending request: {parseFloat(withdrawRequestedAmount).toFixed(2)} USDC</p>
              {withdrawRequestedAt ? (
                <p>Requested at: {new Date(withdrawRequestedAt * 1000).toLocaleString()}</p>
              ) : null}
              <button
                onClick={handleCancelWithdraw}
                disabled={status === "loading"}
                className="mt-2 px-3 py-1 bg-white/10 text-white/70 rounded hover:bg-white/20 transition text-xs"
              >
                Cancel Request
              </button>
            </div>
          )}
        </div>
      )}


      {/* Status */}
      {message && (
        <div className={`p-3 rounded-lg text-sm ${
          status === "success" ? "bg-emerald-400/10 text-emerald-200"
            : status === "error" ? "bg-rose-400/10 text-rose-200"
            : "bg-sky-400/10 text-sky-200"
        }`}>
          {message}
        </div>
      )}

      {agentManagedSui && (
        <div className="p-3 rounded-lg text-xs bg-indigo-400/10 text-indigo-200">
          Agent-managed Sui wallet created for this account.
        </div>
      )}

      <button
        onClick={fetchBalances}
        className="w-full px-3 py-2 bg-white/10 text-white/70 rounded-lg hover:bg-white/20 transition text-sm"
      >
        Refresh
      </button>
    </div>
  );
};

export default DepositUI;
