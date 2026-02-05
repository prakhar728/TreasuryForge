import DepositUI from './components/DepositUI';

function App() {
  // These would typically come from .env variables
  const vaultAddress = import.meta.env.VITE_VAULT_ADDRESS || '0x0000000000000000000000000000000000000000';
  const usdcAddress = import.meta.env.VITE_USDC_ADDRESS || '0x0000000000000000000000000000000000000000';
  const agentApiUrl = import.meta.env.VITE_AGENT_API_URL || 'http://localhost:3001';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 py-12 px-4">
      <div className="max-w-6xl mx-auto">
        <header className="text-center mb-12">
          <h1 className="text-5xl font-bold text-gray-900 mb-2">TreasuryForge</h1>
          <p className="text-xl text-gray-600">RWA-Backed Treasury Optimizer for ETHGlobal HackMoney 2026</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Deposit UI */}
          <div className="lg:col-span-2">
            <DepositUI
              vaultAddress={vaultAddress}
              usdcAddress={usdcAddress}
              agentApiUrl={agentApiUrl}
            />
          </div>

          {/* Info Panel */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">How It Works</h2>
            
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold text-gray-800 mb-2">1. Deposit</h3>
                <p className="text-gray-600 text-sm">
                  Deposit USDC to the vault and set your yield policy.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-gray-800 mb-2">2. Monitor</h3>
                <p className="text-gray-600 text-sm">
                  Agent monitors Stork oracle and evaluates your policy.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-gray-800 mb-2">3. Rebalance</h3>
                <p className="text-gray-600 text-sm">
                  Automatically borrow RWA, bridge to Sui, optimize yields.
                </p>
              </div>

              <div>
                <h3 className="font-semibold text-gray-800 mb-2">4. Earn</h3>
                <p className="text-gray-600 text-sm">
                  Profits returned via Circle Gateway to your wallet.
                </p>
              </div>
            </div>

            <hr className="my-6" />

            <div className="bg-blue-50 rounded p-4">
              <h3 className="font-semibold text-gray-800 mb-2">Strategies</h3>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>🎯 <strong>DeFi Yield</strong> - Yield farm optimization</li>
                <li>📋 <strong>RWA Loan</strong> - Real-world asset lending</li>
                <li>💰 <strong>Stablecoin Carry</strong> - Interest rate arbitrage</li>
              </ul>
            </div>

            <div className="mt-6 p-4 bg-amber-50 border-l-4 border-amber-400 rounded">
              <p className="text-xs text-gray-600">
                <strong>Testnet:</strong> Arc Sepolia<br />
                <strong>Vault:</strong> {vaultAddress.slice(0, 10)}...
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className="mt-12 text-center text-gray-600 text-sm">
          <p>Built for ETHGlobal HackMoney 2026 | Deadline Feb 8</p>
        </footer>
      </div>
    </div>
  );
}

export default App;
