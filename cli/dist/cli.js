#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = __importDefault(require("ws"));
// --- argument parsing ---
const FULL_HELP = `Usage: chrome-do-action --server <ws_url> <action> [args...]

Actions:
  list                                          List connected clients
  send <id> <cmd> [tab] [params]                Send command to a client

Options:
  --field <paths>        Comma-separated field paths to extract from response
                         (e.g. --field "current.url,newTabs")
                         Supported commands: click, get_page_info, open

Page commands (require tab):
  click <tab> [params]        Click by selector, text, or {x,y}
                              selector supports "css:..." and "xpath:..." prefixes
  type  <tab> {selector,text} Type text into input
  get_text   <tab> [selector] Get text content of element or page
  get_page_info <tab> [--field ...] Get page info (url, title, iframes)
  get_js_errors <tab>         Get accumulated JS errors since page open
  clear_js_errors <tab>       Clear accumulated JS errors
  scroll     <tab> {y}        Scroll page (supports x for horizontal)

Browser commands (no tab needed):
  open <url>       Open URL in new tab (supports --field)
  list_tabs        List all tabs
  close_tab <id>   Close tab (use "current" for active, or numeric tabId)

Examples:
  chrome-do-action --server ws://127.0.0.1:12345 list
  chrome-do-action --server ws://127.0.0.1:12345 send abc open https://example.com
  chrome-do-action --server ws://127.0.0.1:12345 send abc list_tabs
  chrome-do-action --server ws://127.0.0.1:12345 send abc close_tab current
  chrome-do-action --server ws://127.0.0.1:12345 send abc close_tab 456
  chrome-do-action --server ws://127.0.0.1:12345 send abc get_page_info current
  chrome-do-action --server ws://127.0.0.1:12345 send abc click current '{"text":"登录"}'
  chrome-do-action --server ws://127.0.0.1:12345 send abc click current --field "current.url,newTabs"
  chrome-do-action --server ws://127.0.0.1:12345 send abc scroll current '{"y":500}'`;
function parseArgs(argv) {
    const raw = {};
    const positional = [];
    let i = 2;
    while (i < argv.length) {
        const m = argv[i].match(/^--(\w[\w-]*)(?:=(.+))?$/);
        if (m) {
            raw[m[1]] = m[2] ?? argv[++i] ?? "";
        }
        else {
            positional.push(argv[i]);
        }
        i++;
    }
    // --help / -h
    if ("help" in raw || positional.includes("help") || positional.includes("-h") || positional.includes("--help")) {
        console.error(FULL_HELP);
        process.exit(0);
    }
    const server = raw.server;
    if (!server) {
        console.error("Error: --server <ws_url> is required. Use --help for usage.");
        console.error("");
        console.error("Example: chrome-do-action --server ws://127.0.0.1:12345 list");
        console.error("         chrome-do-action --help");
        process.exit(1);
    }
    return { server, action: positional[0] || "", args: positional.slice(1), raw };
}
function stripQuotes(s) {
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
        return s.slice(1, -1);
    }
    return s;
}
const BROWSER_CMDS = new Set(["open", "list_tabs", "close_tab"]);
// --- build CLI message ---
function buildMessage(action, args) {
    if (action === "list") {
        return { type: "cli", id: genId(), payload: { action: "list" } };
    }
    if (action === "send") {
        const nodeId = args[0];
        const command = args[1];
        if (!nodeId || !command) {
            console.error("Usage: chrome-do-action --server <url> send <nodeId> <command> [tabId] [params]");
            console.error("");
            console.error("Browser commands (no tab): open <url> | list_tabs | close_tab <id>");
            console.error("Page commands (tab required): click | type | get_text | get_page_info | get_js_errors | clear_js_errors | scroll");
            console.error("");
            console.error("Example: chrome-do-action --server ws://127.0.0.1:12345 send abc123 get_page_info current");
            process.exit(1);
        }
        if (BROWSER_CMDS.has(command)) {
            let params = {};
            const raw = args[2] || "";
            if (raw) {
                switch (command) {
                    case "open":
                        params = { url: raw };
                        break;
                    case "close_tab":
                        params = { tabId: parseInt(raw, 10) || raw };
                        break;
                }
            }
            return {
                type: "cli", id: genId(),
                payload: { action: "send", target: nodeId, command, params },
            };
        }
        // Page command
        const tabId = args[2];
        if (!tabId) {
            console.error(`Error: page command "${command}" requires a tab.`);
            console.error(`Usage: chrome-do-action --server <url> send ${nodeId} ${command} current|<tabId> [params]`);
            console.error(`Example: chrome-do-action --server ws://127.0.0.1:12345 send ${nodeId} ${command} current`);
            process.exit(1);
        }
        if (tabId !== "current" && !/^\d+$/.test(tabId)) {
            console.error(`tabId must be "current" or a number, got: ${tabId}`);
            process.exit(1);
        }
        let params = {};
        const raw = args[3] || "";
        if (raw) {
            try {
                params = JSON.parse(stripQuotes(raw));
            }
            catch {
                console.error(`Invalid params JSON: ${raw}`);
                process.exit(1);
            }
        }
        return {
            type: "cli", id: genId(),
            payload: { action: "send", target: nodeId, command, tabId, params },
        };
    }
    console.error(`Unknown action: ${action}. Valid actions: list, send`);
    console.error("Use --help for full usage.");
    process.exit(1);
}
// --- main ---
const { server, action, args, raw } = parseArgs(process.argv);
if (!action) {
    console.error("Error: no action specified. Use --help for usage.");
    process.exit(1);
}
const fields = raw.field ? raw.field.split(",").map(f => f.trim()).filter(Boolean) : [];
const msg = buildMessage(action, args);
// Inject _field into params so the browser extension can filter at the source
if (fields.length > 0 && msg.type === "cli" && msg.payload?.action === "send") {
    const sendPayload = msg.payload;
    if (!sendPayload.params)
        sendPayload.params = {};
    sendPayload.params._field = fields;
}
const ws = new ws_1.default(server);
ws.on("open", () => {
    ws.send(JSON.stringify(msg));
});
ws.on("message", (raw) => {
    let res;
    try {
        res = JSON.parse(raw.toString());
    }
    catch {
        console.error("Invalid response from server");
        process.exit(1);
    }
    if (res.type === "cli_result" && res.payload) {
        if (res.payload.success) {
            const data = res.payload.data;
            if (data !== undefined && data !== null) {
                if (Array.isArray(data)) {
                    if (data.length === 0) {
                        console.log("(empty)");
                    }
                    else if (typeof data[0] === "object" && "nodeId" in data[0]) {
                        for (const c of data) {
                            console.log(`${c.nodeId}  ${c.nodeName}  ${c.remoteAddr}  online ${c.uptime}s`);
                        }
                    }
                    else {
                        console.log(JSON.stringify(data, null, 2));
                    }
                }
                else if (typeof data === "string") {
                    console.log(data);
                }
                else {
                    console.log(JSON.stringify(data, null, 2));
                }
            }
        }
        else {
            console.error(`Error: ${res.payload.error || "unknown"}`);
            process.exit(1);
        }
    }
    ws.close();
});
ws.on("error", (err) => {
    console.error(`WebSocket error: ${err.message || err.code || "unknown"}`);
    process.exit(1);
});
ws.on("close", () => {
    // normal exit after receiving result
});
function genId() {
    return Math.random().toString(36).slice(2, 10);
}
