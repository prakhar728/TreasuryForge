import { useEffect, useMemo, useState } from 'react';
import DepositUI from './components/DepositUI';

function App() {
  const vaultAddress = import.meta.env.VITE_VAULT_ADDRESS || '0x0000000000000000000000000000000000000000';
  const usdcAddress = import.meta.env.VITE_USDC_ADDRESS || '0x0000000000000000000000000000000000000000';
  const agentApiUrl = import.meta.env.VITE_AGENT_API_URL || 'http://localhost:3001';
  const arcExplorerBase = import.meta.env.VITE_ARC_EXPLORER || 'https://testnet.arcscan.app';

  type FeedItem = { time: string; title: string; detail: string; tag: string; relevant?: boolean };
  type Signal = { label: string; value: string; meta: string; tone: 'emerald' | 'amber' | 'rose' | 'sky' };
  type Position = { name: string; status: string; detail: string; tone: 'emerald' | 'amber' | 'rose' | 'sky' };

  const toneBarClass: Record<Signal['tone'], string> = {
    emerald: 'bg-emerald-400/80',
    amber: 'bg-amber-400/80',
    rose: 'bg-rose-400/80',
    sky: 'bg-sky-400/80',
  };

  const toneTextClass: Record<Position['tone'], string> = {
    emerald: 'text-emerald-300',
    amber: 'text-amber-300',
    sky: 'text-sky-300',
    rose: 'text-rose-300',
  };

  const [liveFeed, setLiveFeed] = useState<FeedItem[]>([]);
  const [liveSignals, setLiveSignals] = useState<Signal[]>([]);
  const [livePositions, setLivePositions] = useState<Position[]>([]);
  const [liveReady, setLiveReady] = useState(false);
  const [showOnlyRelevant, setShowOnlyRelevant] = useState(true);
  const [connectedUser, setConnectedUser] = useState<string>('');

  const formatTime = (input: string) => {
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleTimeString();
    }
    return input;
  };

  useEffect(() => {
    let cancelled = false;

    const normalizeLines = (lines: string[]): FeedItem[] =>
      lines.slice(0, 8).map((line, idx) => ({
        time: new Date().toLocaleTimeString(),
        title: line.slice(0, 64),
        detail: line.length > 64 ? line.slice(64) : '—',
        tag: `log-${idx + 1}`,
      }));

    const poll = async () => {
      try {
        const logUrl = connectedUser
          ? `${agentApiUrl}/logs?user=${encodeURIComponent(connectedUser)}`
          : `${agentApiUrl}/logs`;
        const res = await fetch(logUrl);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            if (Array.isArray(data?.entries)) {
              setLiveFeed(data.entries.slice(0, 8));
            } else if (Array.isArray(data?.lines)) {
              setLiveFeed(normalizeLines(data.lines));
            }
          }
        }
      } catch {
        // ignore if agent API not running
      }

      try {
        const stateUrl = connectedUser
          ? `${agentApiUrl}/state?user=${encodeURIComponent(connectedUser)}`
          : `${agentApiUrl}/state`;
        const res = await fetch(stateUrl);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) {
            if (Array.isArray(data?.signals)) setLiveSignals(data.signals);
            if (Array.isArray(data?.positions)) setLivePositions(data.positions);
          }
        }
      } catch {
        // ignore if agent API not running
      }

      if (!cancelled) {
        setLiveReady(true);
      }
    };

    poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [agentApiUrl, connectedUser]);

  const agentFeed = liveFeed;
  const signals = liveSignals;
  const positions = livePositions;

  const isRelevantLog = (item: FeedItem) => {
    if (item.relevant) return true;
    const text = `${item.title} ${item.detail}`.toLowerCase();
    const keywords = [
      'borrow',
      'repay',
      'deposit',
      'redeem',
      'withdraw',
      'bridge',
      'gateway',
      'lifi',
      'deepbook',
      'balance',
      'position',
      'minted',
      'transfer',
      'liquidity',
    ];
    return keywords.some((word) => text.includes(word));
  };

  const displayedFeed = useMemo(() => {
    if (!showOnlyRelevant) return agentFeed;
    return agentFeed.filter(isRelevantLog);
  }, [agentFeed, showOnlyRelevant]);

  const derivePositionName = (item: FeedItem) => {
    const text = `${item.title} ${item.detail}`.toLowerCase();
    if (text.includes('deepbook')) return 'DeepBook Liquidity';
    if (text.includes('bridge') || text.includes('lifi')) return 'Bridge Routing';
    if (text.includes('gateway')) return 'Gateway Transfer';
    if (text.includes('base') && text.includes('deposit')) return 'Base Vault Deposit';
    if (text.includes('borrow')) return 'Vault Borrow';
    if (text.includes('repay')) return 'Vault Repay';
    if (text.includes('withdraw')) return 'Withdraw Processing';
    if (text.includes('deposit')) return 'Vault Deposit';
    return item.title;
  };

  const renderedPositions = useMemo<Position[]>(() => {
    if (positions.length > 0) return positions;
    const relevantLogs = agentFeed.filter(isRelevantLog).slice(0, 5);
    return relevantLogs.map<Position>((item, index) => ({
      name: derivePositionName(item),
      status: 'Recorded',
      detail: item.detail || item.title,
      tone: index === 0 ? 'emerald' : 'sky',
    }));
  }, [agentFeed, positions]);

  const lastAction = useMemo(() => agentFeed[0] ?? null, [agentFeed]);
  const vaultExplorerUrl = `${arcExplorerBase}/address/${vaultAddress}`;

  const renderDetailWithLinks = (detail: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = detail.split(urlRegex);
    return parts.map((part, index) => {
      if (part.startsWith('http://') || part.startsWith('https://')) {
        return (
          <a
            key={`link-${index}`}
            className="text-emerald-300 underline break-all hover:text-emerald-200"
            href={part}
            target="_blank"
            rel="noreferrer"
          >
            Open tx
          </a>
        );
      }
      return <span key={`text-${index}`}>{part}</span>;
    });
  };

  const highlights = [
    { title: 'Glass-box automation', copy: 'Every move logged, labeled, and replayable in real time.' },
    { title: 'Unified USDC balance', copy: 'Arc + Circle Gateway keep liquidity chain-abstracted.' },
    { title: 'DeFi + RWA rotation', copy: 'Switch between USYC yield and DeepBook liquidity without guesswork.' },
  ];

  const capabilities = [
    { title: 'Policy-driven vault', copy: 'Deposit on Arc, set a policy, and keep withdrawal control.' },
    { title: 'Signal-first agent', copy: 'Stork and DeepBook yield signals guide every rebalance.' },
    { title: 'Cross-chain routing', copy: 'Move USDC across Arc, Base, Ethereum, and Avalanche.' },
    { title: 'Sui liquidity layer', copy: 'DeepBook spreads become first-class yield opportunities.' },
  ];

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

  const controls = [
    'Policy limits for borrow size and risk tier',
    'Access control: agent-only borrow/repay',
    'Mock mode when allowlists are unavailable',
    'Every action streamed to live ops feed',
  ];

  return (
    <div className="min-h-screen bg-[#0a0b10] text-white">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[#1b2341] blur-3xl opacity-70" />
          <div className="absolute top-40 right-0 h-[520px] w-[520px] rounded-full bg-[#124036] blur-3xl opacity-55" />
          <div className="absolute bottom-0 left-0 h-[520px] w-[520px] rounded-full bg-[#3b1930] blur-3xl opacity-40" />
          <div className="absolute right-1/3 top-10 h-[320px] w-[320px] rounded-full bg-[#1c2f52] blur-3xl opacity-40" />
        </div>

        <div className="relative max-w-7xl mx-auto px-6 py-10">
          <header className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/20 text-emerald-200">
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
              <a className="hover:text-white" href="#ops">
                Live ops
              </a>
              <a className="hover:text-white" href="#integrations">
                Integrations
              </a>
              <a
                className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:border-white/40"
                href="#ops"
              >
                Launch console
              </a>
            </nav>
          </header>

          <section className="mt-12 grid grid-cols-1 gap-10 lg:grid-cols-[1.2fr_0.8fr]" id="overview">
            <div className="space-y-6">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-4 py-2 text-xs uppercase tracking-[0.2em] text-white/70">
                Arc + Circle Gateway + Sui
              </div>
              <h1 className="text-4xl lg:text-6xl font-semibold leading-tight">
                The glass-box USDC treasury that always shows its work.
              </h1>
              <p className="text-lg text-white/70 max-w-2xl">
                TreasuryForge is a glass-box USDC treasury system built for risk-off markets. Deposit on Arc Testnet,
                choose a policy, and let the agent route liquidity across RWA and DeFi venues without losing
                transparency.
              </p>
              <div className="flex flex-wrap gap-3">
                <a
                  className="rounded-full bg-emerald-400/90 px-6 py-3 text-sm font-semibold text-[#08110d] shadow-lg shadow-emerald-500/20"
                  href="#ops"
                >
                  Enter live ops
                </a>
                <a
                  className="rounded-full border border-white/20 px-6 py-3 text-sm font-semibold text-white/80 hover:text-white"
                  href="#how"
                >
                  See the flow
                </a>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-white/60">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Unified USDC balance</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Explainable agent</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Live decision feed</span>
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_0_60px_rgba(15,23,42,0.45)]">
                <div className="text-xs uppercase tracking-[0.25em] text-white/50">Vault snapshot</div>
                <div className="mt-4 text-2xl font-semibold break-words">{vaultAddress.slice(0, 10)}...</div>
                <div className="mt-1 text-sm text-white/60 break-words">USDC {usdcAddress.slice(0, 10)}...</div>
                <a
                  className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-emerald-300 transition hover:text-emerald-200"
                  href={vaultExplorerUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Arc Explorer →
                </a>
                <div className="mt-6 grid grid-cols-2 gap-3 text-xs text-white/60">
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

              <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-400/10 via-white/5 to-transparent p-6">
                <div className="text-xs uppercase tracking-[0.25em] text-white/50">Live signal strip</div>
                <div className="mt-4 grid grid-cols-3 gap-3 text-xs text-white/70">
                  <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/10 p-3">
                    <div className="text-[10px] uppercase text-white/40">Arc RWA</div>
                    <div className="mt-2 text-sm">USYC yield</div>
                  </div>
                  <div className="rounded-2xl border border-sky-400/30 bg-sky-400/10 p-3">
                    <div className="text-[10px] uppercase text-white/40">Gateway</div>
                    <div className="mt-2 text-sm">Cross-chain</div>
                  </div>
                  <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-3">
                    <div className="text-[10px] uppercase text-white/40">Sui</div>
                    <div className="mt-2 text-sm">DeepBook</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-3">
            {highlights.map((item) => (
              <div key={item.title} className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <div className="text-xs uppercase tracking-[0.3em] text-white/40">Highlight</div>
                <h3 className="mt-3 text-xl font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm text-white/70">{item.copy}</p>
              </div>
            ))}
          </section>

          <section className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.1fr]">
            <div className="rounded-3xl border border-white/10 bg-white/5 p-8">
              <h2 className="text-2xl font-semibold">Why this exists</h2>
              <p className="mt-4 text-sm text-white/70">
                Risk-off markets push teams into stables, but yields move too fast to chase manually. TreasuryForge
                keeps the vault intentionally simple while the agent does the hard work across chains and venues.
              </p>
              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
                  Fragmented liquidity makes best-rate routing hard.
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
                  Opaque automation turns yield ops into a black box.
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
                  Teams need observable, policy-bound automation.
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
                  Unified USDC keeps capital mobile without rebuilds.
                </div>
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 via-white/5 to-transparent p-8">
              <h2 className="text-2xl font-semibold">What TreasuryForge ships today</h2>
              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {capabilities.map((item) => (
                  <div key={item.title} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="text-xs uppercase tracking-[0.25em] text-white/40">Capability</div>
                    <div className="mt-2 text-sm font-semibold">{item.title}</div>
                    <div className="mt-2 text-xs text-white/60">{item.copy}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1fr]" id="how">
            <div className="rounded-3xl border border-white/10 bg-white/5 p-8">
              <h2 className="text-2xl font-semibold">How it works</h2>
              <div className="mt-6 space-y-4">
                {steps.map((step, index) => (
                  <div key={step.title} className="flex gap-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-400/20 text-sm text-emerald-200">
                      0{index + 1}
                    </div>
                    <div>
                      <div className="text-sm font-semibold">{step.title}</div>
                      <div className="mt-1 text-xs text-white/60">{step.copy}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-white/5 p-8">
              <h2 className="text-2xl font-semibold">Architecture layers</h2>
              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {layers.map((layer) => (
                  <div key={layer.title} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    <div className="text-xs uppercase tracking-[0.25em] text-white/40">Layer</div>
                    <div className="mt-2 text-sm font-semibold">{layer.title}</div>
                    <div className="mt-2 text-xs text-white/60">{layer.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="mt-16 rounded-3xl border border-white/10 bg-white/5 p-8" id="strategies">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-2xl font-semibold">Strategy suite</h2>
                <p className="mt-2 text-sm text-white/70">
                  Choose a policy, then let the agent rotate between risk-off yield sources with full transparency.
                </p>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-white/60">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">RWA yield</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">DeFi carry</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">DeepBook liquidity</span>
              </div>
            </div>
            <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-emerald-400/10 via-white/5 to-transparent p-6">
                <div className="text-xs uppercase tracking-[0.25em] text-white/40">RWA</div>
                <div className="mt-3 text-lg font-semibold">USYC on Arc</div>
                <div className="mt-2 text-sm text-white/70">
                  Stork-informed USYC yield that borrows from the vault and repays with proof.
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-sky-400/10 via-white/5 to-transparent p-6">
                <div className="text-xs uppercase tracking-[0.25em] text-white/40">Gateway</div>
                <div className="mt-3 text-lg font-semibold">Cross-chain carry</div>
                <div className="mt-2 text-sm text-white/70">
                  Circle Gateway routes USDC to the best rate across Arc, Base, Ethereum, and Avalanche.
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-amber-400/10 via-white/5 to-transparent p-6">
                <div className="text-xs uppercase tracking-[0.25em] text-white/40">Sui</div>
                <div className="mt-3 text-lg font-semibold">DeepBook spreads</div>
                <div className="mt-2 text-sm text-white/70">
                  The agent can bridge to Sui, deploy into DeepBook liquidity, and return capital when rates shift.
                </div>
              </div>
            </div>
          </section>

          <section className="mt-16 grid grid-cols-1 gap-6 lg:grid-cols-[1.1fr_0.9fr]" id="integrations">
            <div className="rounded-3xl border border-white/10 bg-white/5 p-8">
              <h2 className="text-2xl font-semibold">Integrations in play</h2>
              <p className="mt-2 text-sm text-white/70">
                TreasuryForge stitches together Arc, Circle infrastructure, and Sui liquidity so you do not rebuild
                bridges or wallets.
              </p>
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {integrations.map((item) => (
                  <div key={item} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/70">
                    {item}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 via-white/5 to-transparent p-8">
              <h2 className="text-2xl font-semibold">Safety + control</h2>
              <div className="mt-6 space-y-3 text-sm text-white/70">
                {controls.map((item) => (
                  <div key={item} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                    {item}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="mt-16 rounded-3xl border border-white/10 bg-white/5 p-8" id="ops">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-2xl font-semibold">Live ops console</h2>
                <p className="mt-2 text-sm text-white/70">
                  Watch the agent think, execute, and repay in real time. Connect a wallet to deposit and set a policy.
                </p>
              </div>
              <div className="text-xs text-white/50">Agent API: {agentApiUrl}</div>
            </div>

            <section className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              {signals.length === 0 ? (
                <div className="col-span-full rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-white/60">
                  {liveReady ? 'No live signals yet. Start the agent or wait for the next cycle.' : 'Connecting to agent...'}
                </div>
              ) : (
                signals.map((signal) => (
                  <div key={signal.label} className="rounded-2xl border border-white/10 bg-white/5 p-5">
                    <div className="text-xs uppercase text-white/50">{signal.label}</div>
                    <div className="mt-3 text-2xl font-semibold">{signal.value}</div>
                    <div className="mt-2 text-sm text-white/60">{signal.meta}</div>
                    <div className={`mt-4 h-1.5 w-12 rounded-full ${toneBarClass[signal.tone]}`} />
                  </div>
                ))
              )}
            </section>

            <div className="mt-10 grid grid-cols-1 gap-8 lg:grid-cols-3">
              <div className="lg:col-span-2 space-y-6">
                <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-semibold">Deposit + policy</h3>
                    <span className="text-xs text-white/50">Arc Testnet</span>
                  </div>
                  <div className="mt-4">
                    <DepositUI
                      vaultAddress={vaultAddress}
                      usdcAddress={usdcAddress}
                      agentApiUrl={agentApiUrl}
                      onAddressChange={setConnectedUser}
                    />
                  </div>
                </div>

                <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-xl font-semibold">Agent feed</h3>
                      <div className="mt-1 text-xs text-white/50">
                        Toggle between balance-impacting actions and every thought.
                      </div>
                    </div>
                    <button
                      className={`rounded-full border px-4 py-2 text-xs font-semibold transition ${
                        showOnlyRelevant
                          ? 'border-emerald-400/60 bg-emerald-400/10 text-emerald-200'
                          : 'border-white/10 bg-white/5 text-white/70 hover:text-white'
                      }`}
                      onClick={() => setShowOnlyRelevant((prev) => !prev)}
                    >
                      {showOnlyRelevant ? 'Only relevant logs' : 'All logs'}
                    </button>
                  </div>
                  <div className="mt-4 space-y-4">
                    {displayedFeed.length === 0 ? (
                      <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-6 text-sm text-white/60">
                        {liveReady
                          ? showOnlyRelevant
                            ? 'No relevant log events yet. Switch to all logs to see every thought.'
                            : 'No live log events yet.'
                          : 'Connecting to agent...'}
                      </div>
                    ) : (
                      displayedFeed.map((item) => (
                        <div
                          key={`${item.time}-${item.title}`}
                          className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 sm:flex-row"
                        >
                          <div className="text-xs text-white/50 whitespace-nowrap">{formatTime(item.time)}</div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium break-words">{item.title}</div>
                            <div className="text-xs text-white/60 break-all">{renderDetailWithLinks(item.detail)}</div>
                          </div>
                          <div className="text-[10px] uppercase tracking-widest text-white/40 break-words">{item.tag}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                  <h3 className="text-xl font-semibold">Last action</h3>
                  {lastAction ? (
                    <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
                      <div className="text-xs text-white/50">{formatTime(lastAction.time)}</div>
                      <div className="mt-2 text-sm font-semibold">{lastAction.title}</div>
                      <div className="mt-1 text-xs text-white/60">{lastAction.detail}</div>
                      <div className="mt-2 text-[10px] uppercase tracking-widest text-white/40">{lastAction.tag}</div>
                    </div>
                  ) : (
                    <div className="mt-4 text-sm text-white/60">
                      {liveReady ? 'No actions yet.' : 'Connecting to agent...'}
                    </div>
                  )}
                </div>

                <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                  <h3 className="text-xl font-semibold">Positions</h3>
                  <div className="mt-1 text-xs text-white/50">
                    Shows what the agent has executed for your balance or positions.
                  </div>
                  <div className="mt-4 space-y-3">
                    {renderedPositions.length === 0 ? (
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white/60">
                        {liveReady ? 'No live positions yet.' : 'Connecting to agent...'}
                      </div>
                    ) : (
                      renderedPositions.map((position) => (
                        <div key={position.name} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-semibold break-words">{position.name}</div>
                            <div className={`text-xs ${toneTextClass[position.tone]}`}>{position.status}</div>
                          </div>
                          <div className="mt-2 text-xs text-white/60 break-words">
                            {renderDetailWithLinks(position.detail)}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 p-6">
                  <h3 className="text-xl font-semibold">Black box → glass box</h3>
                  <div className="mt-3 text-sm text-white/70">
                    Every decision the agent makes is surfaced as a signal, a position, and a timeline event. No hidden
                    logic, no unknown routing.
                  </div>
                  <div className="mt-4 text-xs text-white/50">
                    Demo note: DeepBook liquidity is mocked if bids or asks are empty.
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="mt-16 rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-400/10 via-white/5 to-transparent p-8">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-2xl font-semibold">Ready to deploy a glass-box treasury?</h2>
                <p className="mt-2 text-sm text-white/70">
                  Deposit on Arc, choose a policy, and let TreasuryForge move USDC across chains with clarity.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <a
                  className="rounded-full bg-emerald-400/90 px-6 py-3 text-sm font-semibold text-[#08110d]"
                  href="#ops"
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

export default App;
