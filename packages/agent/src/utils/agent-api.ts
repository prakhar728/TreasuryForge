import http from "node:http";
import { URL } from "node:url";

export interface LogEntry {
  time: string;
  title: string;
  detail: string;
  tag: string;
  relevant?: boolean;
  user?: string;
}

export interface Signal {
  label: string;
  value: string;
  meta: string;
  tone: "emerald" | "amber" | "rose" | "sky";
}

export interface Position {
  name: string;
  status: string;
  detail: string;
  tone: "emerald" | "amber" | "rose" | "sky";
  user?: string;
}

export interface AgentState {
  signals: Signal[];
  positions: Position[];
  lastAction?: LogEntry | null;
}

const LOG_BUFFER_SIZE = Number(process.env.AGENT_LOG_BUFFER || "200");
const logBuffer: LogEntry[] = [];
let state: AgentState = { signals: [], positions: [], lastAction: null };

function parseLog(line: string, options?: { relevant?: boolean; user?: string }): LogEntry {
  const time = new Date().toISOString();
  let trimmed = line.trim();
  let explicitRelevant = false;
  if (trimmed.startsWith("[RELEVANT]")) {
    explicitRelevant = true;
    trimmed = trimmed.replace("[RELEVANT]", "").trim();
  }
  const tagMatch = trimmed.match(/^\[([^\]]+)\]/);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : "agent";

  let title = trimmed;
  let detail = "";
  if (trimmed.includes(" - ")) {
    const [t, ...rest] = trimmed.split(" - ");
    title = t;
    detail = rest.join(" - ");
  } else if (trimmed.includes(": ")) {
    const [t, ...rest] = trimmed.split(": ");
    title = t;
    detail = rest.join(": ");
  }

  return {
    time,
    title,
    detail,
    tag,
    relevant: options?.relevant ?? explicitRelevant,
    user: options?.user,
  };
}

export function pushLog(line: string, options?: { relevant?: boolean; user?: string }): void {
  if (!line) return;
  const entry = parseLog(line, options);
  logBuffer.unshift(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.pop();
  state.lastAction = entry;
}

export function setAgentState(next: AgentState): void {
  state = { ...next, lastAction: state.lastAction || null };
}

export function getAgentState(): AgentState {
  return state;
}

function normalizeUser(value?: string | null): string {
  return value ? value.toLowerCase() : "";
}

export function getLogs(user?: string): LogEntry[] {
  if (!user) return [...logBuffer];
  const normalized = normalizeUser(user);
  return logBuffer.filter((entry) => !entry.user || normalizeUser(entry.user) === normalized);
}

export function getAgentStateForUser(user?: string): AgentState {
  if (!user) return state;
  const normalized = normalizeUser(user);
  const positions = state.positions.filter((p) => !p.user || normalizeUser(p.user) === normalized);
  const lastAction = getLogs(user)[0] ?? null;
  return { ...state, positions, lastAction };
}

export function initAgentApi(): void {
  const port = Number(process.env.AGENT_API_PORT || "3001");

  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }).end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }).end();
      return;
    }

    if (url.pathname === "/logs") {
      const user = url.searchParams.get("user") || undefined;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ entries: getLogs(user) }));
      return;
    }

    if (url.pathname === "/state") {
      const user = url.searchParams.get("user") || undefined;
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(getAgentStateForUser(user)));
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, {
      "Access-Control-Allow-Origin": "*",
    }).end();
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[AgentAPI] Port ${port} already in use. Set AGENT_API_PORT to a free port.`);
      return;
    }
    console.error("[AgentAPI] Server error:", err);
  });

  server.listen(port, () => {
    // use console.log so it gets captured as a log entry
    console.log(`[AgentAPI] Listening on :${port}`);
  });
}
