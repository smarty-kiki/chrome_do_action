#!/usr/bin/env node
import WebSocket from "ws";

// --- argument parsing ---

const FULL_HELP = `Usage: chrome-do-action --server <ws_url> <action> [args...]

Actions:
  list                                          List connected clients
  send <id> <cmd> [tab] [params]                Send command to a client

Page commands (require tab):
  click <tab> [params]        Click by selector, text, or {x,y}
  type  <tab> {selector,text} Type text into input
  get_text   <tab> [selector] Get text content of element or page
  get_title  <tab>            Get page title
  get_html   <tab> [selector] Get rendered HTML
  get_url    <tab>            Get current URL
  scroll     <tab> {y}        Scroll page

Browser commands (no tab needed):
  open <url>       Open URL in new tab
  list_tabs        List all tabs
  close_tab <id>   Close tab (use "current" for active)

Examples:
  chrome-do-action --server ws://127.0.0.1:12345 list
  chrome-do-action --server ws://127.0.0.1:12345 send abc open https://example.com
  chrome-do-action --server ws://127.0.0.1:12345 send abc list_tabs
  chrome-do-action --server ws://127.0.0.1:12345 send abc close_tab current
  chrome-do-action --server ws://127.0.0.1:12345 send abc close_tab 456
  chrome-do-action --server ws://127.0.0.1:12345 send abc get_title current
  chrome-do-action --server ws://127.0.0.1:12345 send abc click current '{"text":"登录"}'
  chrome-do-action --server ws://127.0.0.1:12345 send abc scroll current '{"y":500}'`;

function parseArgs(argv: string[]): { server: string; action: string; args: string[] } {
  const raw: Record<string, string> = {};
  const positional: string[] = [];

  let i = 2;
  while (i < argv.length) {
    const m = argv[i].match(/^--(\w[\w-]*)(?:=(.+))?$/);
    if (m) {
      raw[m[1]] = m[2] ?? argv[++i] ?? "";
    } else {
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

  return { server, action: positional[0] || "", args: positional.slice(1) };
}

function stripQuotes(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

const BROWSER_CMDS = new Set(["open", "list_tabs", "close_tab"]);

// --- build CLI message ---

function buildMessage(action: string, args: string[]): Record<string, unknown> {
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
      console.error("Page commands (tab required): click | type | get_text | get_title | get_html | get_url | scroll");
      console.error("");
      console.error("Example: chrome-do-action --server ws://127.0.0.1:12345 send abc123 get_title current");
      process.exit(1);
    }

    if (BROWSER_CMDS.has(command)) {
      let params: Record<string, unknown> = {};
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

    let params: Record<string, unknown> = {};
    const raw = args[3] || "";
    if (raw) {
      try {
        params = JSON.parse(stripQuotes(raw));
      } catch {
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

const { server, action, args } = parseArgs(process.argv);

if (!action) {
  console.error("Error: no action specified. Use --help for usage.");
  process.exit(1);
}

const msg = buildMessage(action, args);

const ws = new WebSocket(server);

ws.on("open", () => {
  ws.send(JSON.stringify(msg));
});

ws.on("message", (raw: Buffer) => {
  let res: { type: string; id?: string; payload?: { success: boolean; data?: unknown; error?: string } };
  try {
    res = JSON.parse(raw.toString());
  } catch {
    console.error("Invalid response from server");
    process.exit(1);
  }

  if (res.type === "cli_result" && res.payload) {
    if (res.payload.success) {
      const data = res.payload.data;
      if (data !== undefined && data !== null) {
        if (Array.isArray(data)) {
          // list_tabs / list
          if (data.length === 0) {
            console.log("(empty)");
          } else if (typeof data[0] === "object" && "nodeId" in data[0]) {
            // list clients
            for (const c of data as Record<string, unknown>[]) {
              console.log(`${c.nodeId}  ${c.nodeName}  ${c.remoteAddr}  online ${c.uptime}s`);
            }
          } else {
            console.log(JSON.stringify(data, null, 2));
          }
        } else if (typeof data === "string") {
          console.log(data);
        } else {
          console.log(JSON.stringify(data, null, 2));
        }
      }
    } else {
      console.error(`Error: ${res.payload.error || "unknown"}`);
      process.exit(1);
    }
  }

  ws.close();
});

ws.on("error", (err: Error & { code?: string }) => {
  console.error(`WebSocket error: ${err.message || err.code || "unknown"}`);
  process.exit(1);
});

ws.on("close", () => {
  // normal exit after receiving result
});

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}
