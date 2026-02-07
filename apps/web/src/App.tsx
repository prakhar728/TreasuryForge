import { useEffect, useMemo, useState } from 'react';
import DepositUI from './components/DepositUI';

function App() {
  // These would typically come from .env variables
  const vaultAddress = import.meta.env.VITE_VAULT_ADDRESS || '0x0000000000000000000000000000000000000000';
  const usdcAddress = import.meta.env.VITE_USDC_ADDRESS || '0x0000000000000000000000000000000000000000';
  const agentApiUrl = import.meta.env.VITE_AGENT_API_URL || 'http://localhost:3001';

  type FeedItem = { time: string; title: string; detail: string; tag: string };
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
        const res = await fetch(`${agentApiUrl}/logs`);
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
        const res = await fetch(`${agentApiUrl}/state`);
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
  }, [agentApiUrl]);

  const agentFeed = liveFeed;
  const signals = liveSignals;
  const positions = livePositions;

  const lastAction = useMemo(() => agentFeed[0] ?? null, [agentFeed]);

  return (
    <div className="min-h-screen bg-[#0a0b10] text-white">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0">
          <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-[#1b2341] blur-3xl opacity-70" />
          <div className="absolute top-40 right-0 h-[420px] w-[420px] rounded-full bg-[#0f3b2a] blur-3xl opacity-50" />
          <div className="absolute bottom-0 left-0 h-[420px] w-[420px] rounded-full bg-[#3b1930] blur-3xl opacity-40" />
        </div>

        <div className="relative max-w-7xl mx-auto px-6 py-12">
          <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-4">
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.2em] text-white/70">
                TreasuryForge Ops Console
              </div>
              <h1 className="text-4xl lg:text-6xl font-semibold leading-tight">
                A sleek vault for a chaotic yield universe.
              </h1>
              <p className="text-lg text-white/70 max-w-2xl">
                Deposit on Arc, let the agent hunt yield across chains, and watch every decision in a clear,
                presentable timeline. Zero black box.
              </p>
              <div className="flex flex-wrap gap-3 text-xs text-white/60">
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Arc Testnet</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Circle Gateway</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">Stork Oracle</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">LI.FI Bridge</span>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-[0_0_50px_rgba(15,23,42,0.35)]">
              <div className="text-xs uppercase text-white/50">Vault</div>
              <div className="mt-2 text-2xl font-semibold">{vaultAddress.slice(0, 10)}...</div>
              <div className="mt-1 text-sm text-white/60">USDC {usdcAddress.slice(0, 10)}...</div>
              <div className="mt-4 text-xs text-white/40">Agent API: {agentApiUrl}</div>
            </div>
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
                  <h2 className="text-xl font-semibold">Deposit + Policy</h2>
                  <span className="text-xs text-white/50">Arc Testnet</span>
                </div>
                <div className="mt-4">
                  <DepositUI
                    vaultAddress={vaultAddress}
                    usdcAddress={usdcAddress}
                    agentApiUrl={agentApiUrl}
                  />
                </div>
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold">Agent Feed</h2>
                  <span className="text-xs text-white/50">Live-thinking summary</span>
                </div>
                <div className="mt-4 space-y-4">
                  {agentFeed.length === 0 ? (
                    <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-6 text-sm text-white/60">
                      {liveReady ? 'No live log events yet.' : 'Connecting to agent...'}
                    </div>
                  ) : (
                    agentFeed.map((item) => (
                      <div key={`${item.time}-${item.title}`} className="flex gap-4 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                        <div className="text-xs text-white/50">{formatTime(item.time)}</div>
                        <div className="flex-1">
                          <div className="text-sm font-medium">{item.title}</div>
                          <div className="text-xs text-white/60">{item.detail}</div>
                        </div>
                        <div className="text-[10px] uppercase tracking-widest text-white/40">{item.tag}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <h2 className="text-xl font-semibold">Last Action</h2>
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
                <div className="mt-4 space-y-3">
                  {positions.length === 0 ? (
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white/60">
                      {liveReady ? 'No live positions yet.' : 'Connecting to agent...'}
                    </div>
                  ) : (
                    positions.map((position) => (
                      <div key={position.name} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-semibold">{position.name}</div>
                          <div className={`text-xs ${toneTextClass[position.tone]}`}>{position.status}</div>
                        </div>
                        <div className="mt-2 text-xs text-white/60">{position.detail}</div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-3xl border border-white/10 bg-white/5 p-6">
                <h2 className="text-xl font-semibold">Strategies</h2>
                <div className="mt-4 space-y-3 text-sm text-white/70">
                  <div>DeFi Yield: cross-chain routing and pool selection.</div>
                  <div>RWA Loan: Stork-informed USYC lending.</div>
                  <div>Stablecoin Carry: rate differentials across chains.</div>
                </div>
              </div>

              <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 to-white/5 p-6">
                <h2 className="text-xl font-semibold">Black Box → Glass Box</h2>
                <div className="mt-3 text-sm text-white/70">
                  Every decision the agent makes is surfaced as a signal, a position, and a timeline event.
                  No hidden logic, no unknown routing.
                </div>
                <div className="mt-4 text-xs text-white/50">
                  Demo note: DeepBook liquidity is mocked if bids/asks are empty.
                </div>
              </div>
            </div>
          </div>

          <footer className="mt-12 flex flex-col items-center gap-2 text-xs text-white/40">
            <div>Built for ETHGlobal HackMoney 2026</div>
            <div>Deadline Feb 8 • TreasuryForge</div>
          </footer>
        </div>
      </div>
    </div>
  );
}

export default App;
