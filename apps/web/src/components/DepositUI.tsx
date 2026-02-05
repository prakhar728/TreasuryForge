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
];

const ARC_CHAIN_ID = parseInt(import.meta.env.VITE_ARC_CHAIN_ID || "5042002");

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

  const getSigner = async () => {
    if (!window.ethereum) throw new Error("No wallet found");
    const provider = new ethers.BrowserProvider(window.ethereum);
    return provider.getSigner();
  };

  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        setStatus("error");
        setMessage("Install MetaMask to continue");
        return;
      }

      const provider = new ethers.BrowserProvider(window.ethereum);
      await provider.send("eth_requestAccounts", []);

      // Check/switch to Arc chain
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== ARC_CHAIN_ID) {
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x" + ARC_CHAIN_ID.toString(16) }],
          });
        } catch (switchError: any) {
          // Chain not added — add it
          if (switchError.code === 4902) {
            await window.ethereum.request({
              method: "wallet_addEthereumChain",
              params: [{
                chainId: "0x" + ARC_CHAIN_ID.toString(16),
                chainName: "Arc Testnet",
                rpcUrls: [import.meta.env.VITE_ARC_RPC_URL || "https://rpc.testnet.arc.network"],
                blockExplorerUrls: ["https://testnet.arcscan.app"],
                nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
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

  const fetchBalances = useCallback(async () => {
    if (!connected || !userAddress) return;
    try {
      const signer = await getSigner();
      const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, signer);
      const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);

      const [walletBal, userDeposit, stats, borrowed, policy] = await Promise.all([
        usdc.balanceOf(userAddress),
        vault.userDeposits(userAddress),
        vault.getVaultStats(),
        vault.getBorrowedRWA(userAddress),
        vault.getPolicy(userAddress),
      ]);

      setWalletUsdc(ethers.formatUnits(walletBal, 6));
      setVaultBalance(ethers.formatUnits(userDeposit[0], 6));
      setVaultTvl(ethers.formatUnits(stats[0], 6));
      setTotalBorrows(ethers.formatUnits(stats[1], 6));
      setBorrowedAmount(ethers.formatUnits(borrowed[0], 6));

      if (policy.enabled) {
        setHasPolicy(true);
        setCurrentPolicy(`${Number(policy.yieldThreshold) / 100}% / ${policy.strategy}`);
      }
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
      setMessage("Withdrawing USDC...");
      const signer = await getSigner();
      const vault = new ethers.Contract(vaultAddress, VAULT_ABI, signer);
      const amount = ethers.parseUnits(withdrawAmount, 6);

      const tx = await vault.withdraw(amount);
      setMessage("Waiting for confirmation...");
      await tx.wait();

      setStatus("success");
      setMessage(`Withdrawn ${withdrawAmount} USDC!`);
      setWithdrawAmount("");
      await fetchBalances();
    } catch (error) {
      console.error("Withdraw failed:", error);
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Withdraw failed");
    }
  };

  // ── Not connected ──
  if (!connected) {
    return (
      <div className="w-full max-w-md mx-auto p-6 bg-white rounded-lg shadow-lg text-center">
        <h2 className="text-3xl font-bold mb-4">TreasuryForge</h2>
        <p className="text-gray-600 mb-6">Connect your wallet to deposit USDC and set yield policies.</p>
        <button
          onClick={connectWallet}
          className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition font-medium"
        >
          Connect Wallet
        </button>
        {message && (
          <p className="mt-4 text-sm text-red-600">{message}</p>
        )}
      </div>
    );
  }

  // ── Connected ──
  return (
    <div className="w-full max-w-md mx-auto space-y-4">
      {/* Wallet Info */}
      <div className="p-4 bg-white rounded-lg shadow-lg">
        <div className="flex justify-between items-center mb-3">
          <span className="text-sm text-gray-500">Connected</span>
          <span className="text-xs font-mono bg-green-100 text-green-800 px-2 py-1 rounded">
            {userAddress.slice(0, 6)}...{userAddress.slice(-4)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-gray-50 rounded p-3">
            <p className="text-xs text-gray-500">Wallet USDC</p>
            <p className="text-lg font-bold">{parseFloat(walletUsdc).toFixed(2)}</p>
          </div>
          <div className="bg-blue-50 rounded p-3">
            <p className="text-xs text-gray-500">In Vault</p>
            <p className="text-lg font-bold">{parseFloat(vaultBalance).toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* Vault Stats */}
      <div className="p-4 bg-white rounded-lg shadow-lg">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">Vault Stats</h3>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-xs text-gray-500">TVL</p>
            <p className="font-bold text-sm">${parseFloat(vaultTvl).toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Borrows</p>
            <p className="font-bold text-sm">${parseFloat(totalBorrows).toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Your Borrow</p>
            <p className="font-bold text-sm">${parseFloat(borrowedAmount).toFixed(2)}</p>
          </div>
        </div>
        {hasPolicy && currentPolicy && (
          <p className="mt-2 text-xs text-gray-500">Policy: {currentPolicy}</p>
        )}
      </div>

      {/* Deposit */}
      <div className="p-4 bg-white rounded-lg shadow-lg">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">Deposit USDC</h3>

        <input
          type="number"
          value={depositAmount}
          onChange={(e) => setDepositAmount(e.target.value)}
          placeholder="Amount (USDC)"
          className="w-full px-3 py-2 mb-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
        />

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Yield Threshold (%)</label>
            <input
              type="number"
              value={yieldThreshold}
              onChange={(e) => setYieldThreshold(e.target.value)}
              step="0.1"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Max Borrow (USDC)</label>
            <input
              type="number"
              value={maxBorrow}
              onChange={(e) => setMaxBorrow(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
        </div>

        <select
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          className="w-full px-3 py-2 mb-3 border border-gray-300 rounded-lg text-sm"
        >
          <option value="DeFi_Yield">DeFi Yield</option>
          <option value="RWA_Loan">RWA Loan</option>
          <option value="Stablecoin_Carry">Stablecoin Carry</option>
        </select>

        <div className="flex gap-2">
          <button
            onClick={approveUSDC}
            disabled={status === "loading" || !depositAmount}
            className="flex-1 px-3 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 disabled:bg-gray-300 transition text-sm"
          >
            Approve
          </button>
          <button
            onClick={handleDeposit}
            disabled={status === "loading" || !depositAmount}
            className="flex-1 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 transition text-sm"
          >
            Deposit & Set Policy
          </button>
        </div>
      </div>

      {/* Withdraw */}
      {parseFloat(vaultBalance) > 0 && (
        <div className="p-4 bg-white rounded-lg shadow-lg">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Withdraw</h3>
          <div className="flex gap-2">
            <input
              type="number"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              placeholder="Amount"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <button
              onClick={handleWithdraw}
              disabled={status === "loading" || !withdrawAmount}
              className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:bg-gray-300 transition text-sm"
            >
              Withdraw
            </button>
          </div>
          {parseFloat(borrowedAmount) > 0 && (
            <p className="mt-2 text-xs text-amber-600">Repay borrow before withdrawing</p>
          )}
        </div>
      )}

      {/* Status */}
      {message && (
        <div className={`p-3 rounded-lg text-sm ${
          status === "success" ? "bg-green-100 text-green-800"
            : status === "error" ? "bg-red-100 text-red-800"
            : "bg-blue-100 text-blue-800"
        }`}>
          {message}
        </div>
      )}

      <button
        onClick={fetchBalances}
        className="w-full px-3 py-2 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition text-sm"
      >
        Refresh
      </button>
    </div>
  );
};

export default DepositUI;
