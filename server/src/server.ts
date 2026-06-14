#!/usr/bin/env node
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";

// --- protocol types ---

type MessageType =
  | "register"
  | "register_ack"
  | "command"
  | "command_result"
  | "cli"
  | "cli_result"
  | "ping"
  | "pong"
  | "error";

interface BaseMessage {
  type: MessageType;
  id?: string;
}

interface RegisterMessage extends BaseMessage {
  type: "register";
  payload: { nodeName: string };
}

interface CommandResultMessage extends BaseMessage {
  type: "command_result";
  payload: { commandId: string; success: boolean; data?: unknown; error?: string };
}

interface CliMessage extends BaseMessage {
  type: "cli";
  payload: {
    action: "list" | "send";
    target?: string;
    command?: string;
    tabId?: string;
    params?: Record<string, unknown>;
  };
}

type AnyMessage =
  | RegisterMessage
  | { type: "register_ack"; id?: string; payload: { nodeId: string } }
  | { type: "command"; id?: string; payload: { command: string; params?: Record<string, unknown> } }
  | CommandResultMessage
  | CliMessage
  | { type: "cli_result"; id?: string; payload: { success: boolean; data?: unknown; error?: string } }
  | { type: "ping"; id?: string; payload: { timestamp: number } }
  | { type: "pong"; id?: string; payload: { timestamp: number } }
  | { type: "error"; id?: string; payload: { message: string } };

// --- client record ---

interface ClientRecord {
  ws: WebSocket;
  nodeId: string;
  nodeName: string;
  connectedAt: number;
  remoteAddr: string;
}

// --- argument parsing ---

function parseArgs(argv: string[]): { port: number; logDir: string } {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const m = argv[i].match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) {
      args[m[1]] = m[2] ?? argv[++i] ?? "";
    }
  }
  const port = parseInt(args.port, 10);
  if (!port || port < 1 || port > 65535) {
    console.error("Usage: npm start -- --port <port> --log-dir <dir>");
    console.error("Example: npm start -- --port 8080 --log-dir ./logs");
    process.exit(1);
  }
  const logDir = args["log-dir"] || args.logDir || args.logdir;
  if (!logDir) {
    console.error("Usage: npm start -- --port <port> --log-dir <dir>");
    console.error("Example: npm start -- --port 8080 --log-dir ./logs");
    process.exit(1);
  }
  return { port, logDir };
}

const { port, logDir } = parseArgs(process.argv);

// --- logging ---

const logPath = path.resolve(logDir, `server-${dateStamp()}.log`);

function dateStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ts(): string {
  return new Date().toISOString();
}

function log(line: string): void {
  const entry = `${ts()} ${line}`;
  console.log(entry);
  try {
    fs.appendFileSync(logPath, entry + "\n", "utf-8");
  } catch {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logPath, entry + "\n", "utf-8");
    } catch (err) {
      console.error(`${ts()} [error] failed to write log: ${err}`);
    }
  }
}

// --- server ---

const clients = new Map<string, ClientRecord>();

interface PendingEntry {
  command: string;
  target: string;
  tabId: string;
  startedAt: number;
  cliWs?: WebSocket;
  cliMsgId?: string;
  cliConnId?: number;
}
const pending = new Map<string, PendingEntry>();

const BROWSER_CMDS = new Set(["open", "list_tabs", "close_tab"]);

const wss = new WebSocketServer({ port });

function sendWs(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function listClients(): { nodeId: string; nodeName: string; remoteAddr: string; uptime: number }[] {
  const entries: { nodeId: string; nodeName: string; remoteAddr: string; uptime: number }[] = [];
  clients.forEach((c) => {
    entries.push({
      nodeId: c.nodeId,
      nodeName: c.nodeName,
      remoteAddr: c.remoteAddr,
      uptime: Math.round((Date.now() - c.connectedAt) / 1000),
    });
  });
  return entries;
}

let connSeq = 0;

wss.on("connection", (ws: WebSocket, req) => {
  const connId = ++connSeq;
  const remoteAddr = req.socket.remoteAddress || "unknown";
  log(`[connect #${connId}] ${remoteAddr}`);

  let client: ClientRecord | null = null;
  let registered = false;

  ws.on("message", (raw: Buffer) => {
    let msg: AnyMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      log(`[error #${connId}] invalid JSON from ${remoteAddr}`);
      sendWs(ws, { type: "error", payload: { message: "Invalid JSON" } });
      return;
    }

    switch (msg.type) {
      // --- browser registration ---
      case "register": {
        if (registered) {
          log(`[warn #${connId}] duplicate register attempt`);
          sendWs(ws, { type: "error", id: msg.id, payload: { message: "Already registered" } });
          return;
        }
        const nodeId = genId();
        const nodeName = (msg as RegisterMessage).payload.nodeName || nodeId;
        registered = true;

        client = { ws, nodeId, nodeName, connectedAt: Date.now(), remoteAddr };
        clients.set(nodeId, client);

        sendWs(ws, { type: "register_ack", id: msg.id, payload: { nodeId } });
        log(`[register #${connId}] ${nodeId} = ${nodeName} (${remoteAddr}) | online=${clients.size}`);
        break;
      }

      // --- ping/pong ---
      case "ping": {
        sendWs(ws, { type: "pong", id: msg.id, payload: { timestamp: Date.now() } });
        break;
      }

      // --- command result from browser ---
      case "command_result": {
        const result = msg as CommandResultMessage;
        const p = pending.get(result.payload.commandId);
        const elapsed = p ? `${Date.now() - p.startedAt}ms` : "";
        const desc = p ? p.command : `cmd=${result.payload.commandId}`;

        const who = p?.cliConnId ? `#${p.cliConnId}` : "";
        if (result.payload.success) {
          const data = result.payload.data != null ? ` | ${JSON.stringify(result.payload.data)}` : "";
          log(`[result] ${who} ${desc} ✓${elapsed ? ` (${elapsed})` : ""}${data}`);
        } else {
          log(`[result] ${who} ${desc} ✗ ${result.payload.error}${elapsed ? ` (${elapsed})` : ""}`);
        }

        // Forward result to waiting CLI
        if (p?.cliWs && p.cliMsgId) {
          sendWs(p.cliWs, {
            type: "cli_result",
            id: p.cliMsgId,
            payload: {
              success: result.payload.success,
              data: result.payload.data,
              error: result.payload.error,
            },
          });
        }

        pending.delete(result.payload.commandId);
        break;
      }

      // --- CLI command ---
      case "cli": {
        const cliMsg = msg as CliMessage;
        const { action, target, command, tabId: cliTabId, params: cliParams } = cliMsg.payload;

        if (action === "list") {
          const entries = listClients();
          sendWs(ws, { type: "cli_result", id: cliMsg.id, payload: { success: true, data: entries } });
          log(`[cli #${connId}] list → ${entries.length} clients`);
          break;
        }

        if (action === "send") {
          if (!target || !command) {
            sendWs(ws, { type: "cli_result", id: cliMsg.id, payload: { success: false, error: "Missing target or command" } });
            return;
          }
          const c = clients.get(target);
          if (!c) {
            sendWs(ws, { type: "cli_result", id: cliMsg.id, payload: { success: false, error: `Client "${target}" not found` } });
            return;
          }

          // Build params: merge explicit params with tabId
          let params: Record<string, unknown> = { ...cliParams };
          if (cliTabId && cliTabId !== "current") {
            params.tabId = parseInt(cliTabId, 10);
          }

          const cmdId = genId();
          sendWs(c.ws, { type: "command", id: cmdId, payload: { command, params } });
          pending.set(cmdId, {
            command,
            target: `${target}(${c.nodeName})`,
            tabId: cliTabId || "-",
            startedAt: Date.now(),
            cliWs: ws,
            cliMsgId: cliMsg.id,
            cliConnId: connId,
          });
          log(`[send #${connId}] ${command} → ${c.nodeName}${cliTabId ? ` tab=${cliTabId}` : ""}`);
          // result will be sent back when command_result arrives
          break;
        }

        sendWs(ws, { type: "cli_result", id: cliMsg.id, payload: { success: false, error: `Unknown action: ${action}` } });
        break;
      }

      default:
        log(`[warn #${connId}] unknown message type "${msg.type}" from ${remoteAddr}`);
        sendWs(ws, { type: "error", id: msg.id, payload: { message: `Unknown message type: ${msg.type}` } });
    }
  });

  ws.on("close", (code: number) => {
    if (client) {
      clients.delete(client.nodeId);
      const uptime = Math.round((Date.now() - client.connectedAt) / 1000);
      log(`[offline #${connId}] ${client.nodeId}=${client.nodeName} code=${code} uptime=${uptime}s | online=${clients.size}`);
    } else {
      log(`[close #${connId}] ${remoteAddr} code=${code} (unregistered/CLI)`);
    }
  });

  ws.on("error", (err: Error) => {
    log(`[error #${connId}] ${remoteAddr} ${err.message}`);
  });

  // 10s timeout for browser registration; CLI connections won't register
  const regTimeout = setTimeout(() => {
    if (!registered) {
      // It's fine — could be a CLI client that doesn't register
      log(`[info #${connId}] ${remoteAddr} connected without registration (CLI?)`);
    }
  }, 10000);
  ws.once("close", () => clearTimeout(regTimeout));
});

log(`[server] listening on ws://0.0.0.0:${port} | log=${logPath}`);
