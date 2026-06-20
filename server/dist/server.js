#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// --- argument parsing ---
function parseArgs(argv) {
    const args = {};
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
function dateStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function ts() {
    return new Date().toISOString();
}
function log(line) {
    const entry = `${ts()} ${line}`;
    console.log(entry);
    try {
        fs.appendFileSync(logPath, entry + "\n", "utf-8");
    }
    catch {
        try {
            fs.mkdirSync(logDir, { recursive: true });
            fs.appendFileSync(logPath, entry + "\n", "utf-8");
        }
        catch (err) {
            console.error(`${ts()} [error] failed to write log: ${err}`);
        }
    }
}
// --- server ---
const clients = new Map();
const pending = new Map();
const wss = new ws_1.WebSocketServer({ port });
function sendWs(ws, msg) {
    if (ws.readyState === ws_1.WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}
function genId() {
    return Math.random().toString(36).slice(2, 10);
}
function listClients() {
    const entries = [];
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
wss.on("connection", (ws, req) => {
    const connId = ++connSeq;
    const remoteAddr = req.socket.remoteAddress || "unknown";
    log(`[connect #${connId}] ${remoteAddr}`);
    let client = null;
    let registered = false;
    ws.on("message", (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
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
                const nodeName = msg.payload.nodeName || nodeId;
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
                const result = msg;
                const p = pending.get(result.payload.commandId);
                const elapsed = p ? `${Date.now() - p.startedAt}ms` : "";
                const desc = p ? p.command : `cmd=${result.payload.commandId}`;
                const who = p?.cliConnId ? `#${p.cliConnId}` : "";
                if (result.payload.success) {
                    const data = result.payload.data != null ? ` | ${JSON.stringify(result.payload.data)}` : "";
                    log(`[result] ${who} ${desc} ✓${elapsed ? ` (${elapsed})` : ""}${data}`);
                }
                else {
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
                const cliMsg = msg;
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
                    let params = { ...cliParams };
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
                    const PENDING_TIMEOUT = 60000;
                    setTimeout(() => {
                        const p = pending.get(cmdId);
                        if (!p)
                            return;
                        log(`[timeout] ${p.command} → ${p.target} (no response after ${PENDING_TIMEOUT}ms)`);
                        if (p.cliWs && p.cliMsgId) {
                            sendWs(p.cliWs, { type: "cli_result", id: p.cliMsgId, payload: { success: false, error: "Command timed out" } });
                        }
                        pending.delete(cmdId);
                    }, PENDING_TIMEOUT);
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
    ws.on("close", (code) => {
        if (client) {
            // Clean up pending commands for this browser
            for (const [cmdId, p] of pending) {
                if (p.target.startsWith(`${client.nodeId}(`)) {
                    log(`[cleanup] ${p.command} → ${p.target} (browser offline)`);
                    if (p.cliWs && p.cliMsgId) {
                        sendWs(p.cliWs, { type: "cli_result", id: p.cliMsgId, payload: { success: false, error: "Browser went offline" } });
                    }
                    pending.delete(cmdId);
                }
            }
            clients.delete(client.nodeId);
            const uptime = Math.round((Date.now() - client.connectedAt) / 1000);
            log(`[offline #${connId}] ${client.nodeId}=${client.nodeName} code=${code} uptime=${uptime}s | online=${clients.size}`);
        }
        else {
            log(`[close #${connId}] ${remoteAddr} code=${code} (unregistered/CLI)`);
        }
    });
    ws.on("error", (err) => {
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
