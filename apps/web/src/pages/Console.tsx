import { useEffect, useMemo, useState } from 'react';
import DepositUI from '../components/DepositUI';

function Console() {
  const vaultAddress = import.meta.env.VITE_VAULT_ADDRESS || '0x0000000000000000000000000000000000000000';
  const usdcAddress = import.meta.env.VITE_USDC_ADDRESS || '0x0000000000000000000000000000000000000000';
  const agentApiUrl = import.meta.env.VITE_AGENT_API_URL || 'http://localhost:3001';
  const arcExplorerBase = import.meta.env.VITE_ARC_EXPLORER || 'https://testnet.arcscan.app';

  type FeedItem = { time: string; title: string; detail: string; tag: string; relevant?: boolean };
  type Signal = { label: string; value: string; meta: string; tone: 'emerald' | 'amber' | 'rose' | 'sky' };
  type Position = { name: string; status: string; detail: string; tone: 'emerald' | 'amber' | 'rose' | 'sky' };

  const toneBarClass: Record<Signal['tone'], string> = {
    emerald: 'bg-[#A8C7FF]',
    amber: 'bg-[#F6C453]',
    rose: 'bg-[#FF6B6B]',
    sky: 'bg-[#7BAFFF]',
  };

  const toneTextClass: Record<Position['tone'], string> = {
    emerald: 'text-[#A8C7FF]',
    amber: 'text-[#F6C453]',
    sky: 'text-[#7BAFFF]',
    rose: 'text-[#FF8F8F]',
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
            className="text-[#A8C7FF] underline break-all hover:text-[#A8C7FF]"
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
                <div className="text-xs text-white/50">Live ops console</div>
              </div>
            </div>
            <nav className="flex flex-wrap items-center gap-4 text-xs text-white/60">
              <a className="hover:text-white" href="/">
                Back to landing
              </a>
              <a
                className="rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:border-white/40"
                href={vaultExplorerUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Arc Explorer
              </a>
              <div className="text-xs text-white/40">Agent API: {agentApiUrl}</div>
            </nav>
          </header>

          <section className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
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
                  <h2 className="text-xl font-semibold">Deposit + policy</h2>
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
                    <h2 className="text-xl font-semibold">Agent feed</h2>
                    <div className="mt-1 text-xs text-white/50">
                      Toggle between balance-impacting actions and every thought.
                    </div>
                  </div>
                  <button
                    className={`rounded-full border px-4 py-2 text-xs font-semibold transition ${
                      showOnlyRelevant
                        ? 'border-[#A8C7FF]/60 bg-[#A8C7FF]/10 text-[#A8C7FF]'
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
                <h2 className="text-xl font-semibold">Last action</h2>
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
                <h2 className="text-xl font-semibold">Positions</h2>
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
                <h2 className="text-xl font-semibold">Black box → glass box</h2>
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

          <footer className="mt-12 flex flex-col items-center gap-2 text-xs text-white/40">
            <div>Built for ETHGlobal HackMoney 2026</div>
            <div>Glass-box USDC treasury automation for Arc, Circle Gateway, and Sui.</div>
          </footer>
        </div>
      </div>
    </div>
  );
}

export default Console;
