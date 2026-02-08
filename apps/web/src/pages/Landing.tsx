function Landing() {
  const vaultAddress = import.meta.env.VITE_VAULT_ADDRESS || '0x0000000000000000000000000000000000000000';
  const usdcAddress = import.meta.env.VITE_USDC_ADDRESS || '0x0000000000000000000000000000000000000000';
  const arcExplorerBase = import.meta.env.VITE_ARC_EXPLORER || 'https://testnet.arcscan.app';
  const vaultExplorerUrl = `${arcExplorerBase}/address/${vaultAddress}`;

  const steps = [
    {
      title: 'Deposit USDC on Arc',
      copy: 'Users lock funds in the Arc vault and choose a strategy policy.',
    },
    {
      title: 'Agent watches yields',
      copy: 'Signals from Stork, DeFi routes, and DeepBook decide next moves.',
    },
    {
      title: 'Borrow, deploy, return',
      copy: 'The agent borrows, routes liquidity, then repays with proof.',
    },
  ];

  const layers = [
    { title: 'Arc Vault', detail: 'Solidity vault handles deposits, policies, borrows, and withdrawals.' },
    { title: 'Agent Core', detail: 'Plugin system evaluates yields and executes rebalances.' },
    { title: 'Ops Console', detail: 'Live feed of signals, positions, and transaction hashes.' },
    { title: 'Sui Module', detail: 'DeepBook liquidity deployment with non-EVM reach.' },
  ];

  const integrations = [
    'Arc Testnet',
    'Circle Gateway',
    'Wormhole CCTP',
    'DeepBook',
    'Stork Oracle',
    'USYC',
    'DefiLlama + Aave fallback',
  ];

  return (
    <div className="min-h-screen bg-[#071426] text-[#F5F8FF]">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-[radial-gradient(120%_100%_at_50%_-20%,#2a4c7b_0%,#112846_50%,#071426_100%)]" />
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,20,38,0)_0%,rgba(7,20,38,0.6)_65%,#071426_100%)]" />
          <div className="absolute -right-64 top-10 h-[720px] w-[720px] rounded-full border border-white/10 opacity-70" />
          <div className="absolute -right-40 top-32 h-[520px] w-[520px] rounded-full border border-white/10 opacity-60" />
          <div className="absolute -left-40 bottom-[-300px] h-[520px] w-[720px] rounded-[100%] bg-[radial-gradient(60%_60%_at_50%_50%,rgba(196,214,255,0.35)_0%,rgba(7,20,38,0)_70%)] opacity-70" />
        </div>

        <div className="relative max-w-7xl mx-auto px-6 py-10">
          <header className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#A8C7FF]/20 text-[#A8C7FF]">
                TF
              </div>
              <div>
                <div className="text-sm uppercase tracking-[0.3em] text-white/50">TreasuryForge</div>
                <div className="text-xs text-white/50">Glass-box USDC treasury automation</div>
              </div>
            </div>
            <nav className="flex flex-wrap items-center gap-4 text-xs text-white/60">
              <a className="hover:text-white" href="#overview">
                Overview
              </a>
              <a className="hover:text-white" href="#how">
                How it works
              </a>
              <a className="hover:text-white" href="#strategies">
                Strategies
              </a>
              <a className="hover:text-white" href="#integrations">
                Integrations
              </a>
              <a
                className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:border-white/40"
                href="/app"
              >
                Launch console
              </a>
            </nav>
          </header>

          <section className="mt-20 grid grid-cols-1 gap-10 lg:grid-cols-[1.2fr_0.8fr]" id="overview">
            <div className="space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-xs uppercase tracking-[0.3em] text-white/70">
                Arc + Circle Gateway + Sui
              </div>
              <h1 className="text-4xl lg:text-6xl font-semibold leading-tight tracking-tight">
                The glass-box USDC treasury that always shows its work.
              </h1>
              <p className="text-lg text-white/70 max-w-2xl">
                TreasuryForge is a glass-box USDC treasury system built for risk-off markets. Deposit on Arc Testnet,
                choose a policy, and let the agent route liquidity across RWA and DeFi venues without losing
                transparency.
              </p>
              <div className="flex flex-wrap gap-3">
                <a
                  className="rounded-full bg-[#A8C7FF] px-6 py-3 text-sm font-semibold text-[#0B1220] shadow-lg shadow-[#A8C7FF]/25"
                  href="/app"
                >
                  Enter live ops
                </a>
                <a
                  className="rounded-full border border-white/30 px-6 py-3 text-sm font-semibold text-white/80 hover:text-white"
                  href="#how"
                >
                  See the flow
                </a>
              </div>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <div className="text-xs uppercase tracking-[0.25em] text-white/50">Vault snapshot</div>
                <div className="text-2xl font-semibold break-words">{vaultAddress.slice(0, 10)}...</div>
                <div className="text-sm text-white/60 break-words">USDC {usdcAddress.slice(0, 10)}...</div>
                <a
                  className="inline-flex items-center gap-2 text-xs font-semibold text-[#A8C7FF] transition hover:text-[#C7DAFF]"
                  href={vaultExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Arc Explorer →
                </a>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs text-white/60">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-[10px] uppercase text-white/40">Strategy</div>
                  <div className="mt-2 text-sm">RWA + DeFi</div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-[10px] uppercase text-white/40">Agent loop</div>
                  <div className="mt-2 text-sm">Every 5 min</div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-[10px] uppercase text-white/40">Ops mode</div>
                  <div className="mt-2 text-sm">Live logs</div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                  <div className="text-[10px] uppercase text-white/40">Bridge</div>
                  <div className="mt-2 text-sm">CCTP + Gateway</div>
                </div>
              </div>
            </div>
          </section>

          <section className="mt-28" id="how">
            <h2 className="text-3xl font-semibold">How it works</h2>
            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
              {steps.map((step, index) => (
                <div key={step.title} className="flex gap-4 rounded-2xl border border-white/10 bg-white/5 p-5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#A8C7FF]/20 text-sm text-[#A8C7FF]">
                    0{index + 1}
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{step.title}</div>
                    <div className="mt-1 text-xs text-white/60">{step.copy}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-24">
            <h2 className="text-3xl font-semibold">Architecture layers</h2>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {layers.map((layer) => (
                <div key={layer.title} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-[0.25em] text-white/40">Layer</div>
                  <div className="mt-2 text-sm font-semibold">{layer.title}</div>
                  <div className="mt-2 text-xs text-white/60">{layer.detail}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-24" id="integrations">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-3xl font-semibold">Integrations in play</h2>
                <p className="mt-2 text-sm text-white/70">
                  TreasuryForge stitches together Arc, Circle infrastructure, and Sui liquidity so you do not rebuild
                  bridges or wallets.
                </p>
              </div>
              <a className="text-xs text-white/60 hover:text-white" href="/app">
                Launch console →
              </a>
            </div>
            <div className="mt-6 flex flex-wrap gap-3 text-sm text-white/70">
              {integrations.map((item) => (
                <span key={item} className="rounded-full border border-white/10 bg-white/5 px-4 py-2">
                  {item}
                </span>
              ))}
            </div>
          </section>

          <section className="mt-28">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-3xl font-semibold">Ready to deploy a glass-box treasury?</h2>
                <p className="mt-2 text-sm text-white/70">
                  Deposit on Arc, choose a policy, and let TreasuryForge move USDC across chains with clarity.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <a
                  className="rounded-full bg-[#A8C7FF] px-6 py-3 text-sm font-semibold text-[#0B1220]"
                  href="/app"
                >
                  Start live demo
                </a>
                <a
                  className="rounded-full border border-white/20 px-6 py-3 text-sm font-semibold text-white/80"
                  href="#overview"
                >
                  Back to top
                </a>
              </div>
            </div>
          </section>

          <footer className="mt-12 flex flex-col items-center gap-2 text-xs text-white/40">
            <div>Built for ETHGlobal HackMoney 2026</div>
            <div>Glass-box USDC treasury automation for Arc, Circle Gateway, and Sui.</div>
          </footer>
        </div>
      </div>
    </div>
  );
}

export default Landing;
