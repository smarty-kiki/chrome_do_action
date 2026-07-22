#!/usr/bin/env node
import WebSocket from "ws";

// --- argument parsing ---

const FULL_HELP = `Usage: cda --server <ws_url> <action> [args...]

Actions:
  list                              List connected clients
  send <id> <cmd> [tab] [params]    Send command to a client

Options:
  --field <paths>        Comma-separated field paths to filter response
                          (e.g. --field "currentTab.url,newTabs")
                          Supported commands: open, click, get_page_info

Browser commands (no tab):
  open <url>              Open URL in new tab (supports --field)
  list_tabs               List all tabs
  close_tab <id>          Close tab ("current" for active, or numeric tabId)
  refresh <id>            Reload tab ("current" for active, or numeric tabId)

Page commands (tab required):
  click <tab> [params]    Click by selector, text, or {x,y}
                           selector prefixes: "css:" for CSS, "xpath:" for XPath
  type <tab> <params>     Type text into input ({selector,text})
  get_text <tab> [params] Get text of element ({selector}) or entire page
  get_css <tab> <selector> Get computed CSS of element ({selector})
  get_page_info <tab>     Get page info (url, title, iframes), supports --field
  get_js_errors <tab>     Get accumulated JS errors
  clear_js_errors <tab>   Clear accumulated JS errors
  scroll <tab> <params>   Scroll page ({y} or {x,y})

Examples:
  cda list
  cda send abc open https://example.com
  cda send abc list_tabs
  cda send abc close_tab current
  cda send abc close_tab 456
  cda send abc get_page_info current
  cda send abc click current '{"text":"登录"}'
  cda send abc click current --field "currentTab.url,newTabs"
  cda send abc scroll current '{"y":500}'
  cda send abc get_css current "h1.title"`;

function parseArgs(argv: string[]): { server: string; action: string; args: string[]; raw: Record<string, string> } {
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

  const server = raw.server || "ws://127.0.0.1:12345";

  return { server, action: positional[0] || "", args: positional.slice(1), raw };
}

function stripQuotes(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

const BROWSER_CMDS = new Set(["open", "list_tabs", "close_tab", "refresh"]);

// --- build CLI message ---

function buildMessage(action: string, args: string[]): Record<string, unknown> {
  if (action === "list") {
    return { type: "cli", id: genId(), payload: { action: "list" } };
  }

  if (action === "send") {
    const nodeId = args[0];
    const command = args[1];
    if (!nodeId || !command) {
      console.error("Usage: cda --server <url> send <nodeId> <command> [tabId] [params]");
      console.error("");
      console.error("Browser commands (no tab): open <url> | list_tabs | close_tab <id> | refresh <id>");
      console.error("Page commands (tab required): click | type | get_text | get_css | get_page_info | get_js_errors | clear_js_errors | scroll");
      console.error("");
      console.error("Example: cda send abc123 get_page_info current");
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
          case "refresh":
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
      console.error(`Usage: cda --server <url> send ${nodeId} ${command} current|<tabId> [params]`);
      console.error(`Example: cda --server ws://127.0.0.1:12345 send ${nodeId} ${command} current`);
      process.exit(1);
    }
    if (tabId !== "current" && !/^\d+$/.test(tabId)) {
      console.error(`tabId must be "current" or a number, got: ${tabId}`);
      process.exit(1);
    }

    let params: Record<string, unknown> = {};
    if (command === "get_css") {
      const selector = args[3];
      if (!selector) {
        console.error(`Error: "get_css" requires a selector argument.`);
        console.error(`Usage: cda --server <url> send ${nodeId} get_css <tabId> <selector>`);
        process.exit(1);
      }
      params = { selector };
    } else {
      const raw = args[3] || "";
      if (raw) {
        try {
          params = JSON.parse(stripQuotes(raw));
        } catch {
          console.error(`Invalid params JSON: ${raw}`);
          process.exit(1);
        }
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
if (fields.length > 0 && msg.type === "cli" && (msg.payload as { action?: string } | undefined)?.action === "send") {
  const sendPayload = msg.payload as { params?: Record<string, unknown> };
  if (!sendPayload.params) sendPayload.params = {};
  sendPayload.params._field = fields;
}

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
          if (data.length === 0) {
            console.log("(empty)");
          } else if (typeof data[0] === "object" && "nodeId" in data[0]) {
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
