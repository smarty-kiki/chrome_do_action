#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = __importDefault(require("ws"));
// --- argument parsing ---
const FULL_HELP = `Usage: cda --server <ws_url> <action> [args...]

Actions:
  list                              List connected clients
  send <id> <cmd> [tab] [params]    Send command to a client

Options:
  --field <paths>        Comma-separated dot-paths to filter the response of any
                          page/browser command returning an object
                          (e.g. --field "clickDesc.selector,settledMs,currentTab.url"
                          -> {clickDesc:{selector},settledMs,currentTab:{url}};
                          --field newTabs.url -> {newTabs:[url,...]}).
                          get_text returns a plain string and has nothing to filter.

Browser commands (no tab):
  open <url>              Open URL in new tab (supports --field)
  list_tabs               List all tabs
  close_tab <id>          Close tab ("current" for active, or numeric tabId)
  refresh <id>            Reload tab ("current" for active, or numeric tabId)

Page commands (tab required):
  click <tab> [params]        Click by selector, text, or {x,y}
                              selector prefixes: "css:" for CSS, "xpath:" for XPath
                              Searches top frame then all iframes automatically;
                              use {frame} to target a specific frame.
                              Pierces open shadow DOM: DevTools path with
                              #shadow-root, ">>>", or bare selector fallback
                              Optional {waitFor: {selector|text}} waits until the
                              condition appears before returning (see Settle below)
  real_click <tab> <params>   Trusted click chain via CDP (isTrusted=true) for sites
                              that ignore synthetic events (e.g. WeChat MP).
                              Params: {selector} or {x,y}; optional {approach} =
                              [[x,y],...] path to move through progressively,
                              triggering hover chains before clicking.
                              Works in iframes: same-origin via coordinate
                              translation, cross-origin via CDP
                              Same settle + waitFor semantics as click
  type <tab> <params>         Type text ({selector,text[,waitFor]}); supports
                              input/textarea and contenteditable (rich text,
                              splits by newline)
  keyboard <tab> <params>     Send key press to element ({selector,key[,ctrl|shift|alt|meta][,waitFor]});
                              selector optional (defaults to focused element); key e.g.
                              Enter, Escape, Tab, ArrowDown, or a single char
  upload_file <tab> <params>  Inject base64 image into file input
                              ({selector,base64,filename,mime[,waitFor]}), triggers change
  paste_rich <tab> <params>   Paste styled HTML into contenteditable
                              ({selector,html[,waitFor]}); clears existing content first
  show <tab> <selector>       Force-show all matching hidden elements
                              (inline style; makes hover-only menus clickable)
  hide <tab>                  Restore all elements shown by show
                              (clears inline style back to CSS control)
  get_text <tab> [params]     Get text of element ({selector}) or entire page
  get_css <tab> <selector>    Get computed CSS of element ({selector})
  get_page_info <tab>         Get page info (url, title, iframes), supports --field.
                              iframes include url/html for same-origin AND
                              cross-origin frames
  get_js_errors <tab>         Get accumulated JS errors (aggregated across frames)
  clear_js_errors <tab>       Clear accumulated JS errors
  screenshot <tab> <params>   Capture page screenshot via CDP
                              ({path: "/tmp/shot.png"} saves PNG locally)
  scroll <tab> <params>       Scroll window/iframe ({y} or {x,y}; {frame} picks iframe),
                              or to an element / inside a scrollable container
                              ({selector}[,y][,block]) — pierces shadow DOM

frame param (optional, for element commands that search iframes):
  {frame: "auto"}             (default) top frame first, then all iframes
  {frame: "top"}              top frame only
  {frame: 0}                  first top-level iframe (0-based index)
  {frame: {url: "substring"}} first frame whose url contains the substring
                              (most reliable for cross-origin iframes)

Settle — impact-aware returns (click/type/keyboard/upload_file/paste_rich/
scroll/real_click):
  Commands wait for the action's impact to land before returning. Event-driven
  (DOM mutations + long tasks, no fixed sleep), returns {settledMs} (ms waited):
  no-impact actions return ~0.6s; impacted actions return once the DOM is quiet
  for 250ms after the last activity. Impact that arrives late (network round
  trip, long debounce) is beyond settle — pass {waitFor: {selector|text}} to
  poll (50ms, throttle-proof) until the condition holds; returns
  {waitFor: {settled, waited}}.
  Background tabs: Chrome throttles timers/MutationObserver while hidden (1s
  alignment, minutes-level after 5min hidden) — settle then waits an extra 1s
  confirmation window (~1.6s for no-impact actions); deep-background tabs may
  need waitFor or a focused tab.

Examples:
  cda list
  cda send abc open https://example.com
  cda send abc list_tabs
  cda send abc close_tab current
  cda send abc close_tab 456
  cda send abc get_page_info current
  cda send abc click current '{"text":"登录"}'
  cda send abc click current --field "currentTab.url,newTabs"
  cda send abc type current '{"selector":"#title","text":"hello"}'
  cda send abc paste_rich current '{"selector":".ProseMirror","html":"<section><span>hi</span></section>"}'
  cda send abc upload_file current '{"selector":"input[type=file]","base64":"<b64>","filename":"a.jpg","mime":"image/jpeg"}'
  cda send abc scroll current '{"y":500}'
  cda send abc get_css current "h1.title"`;
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
    const server = raw.server || "ws://127.0.0.1:12345";
    return { server, action: positional[0] || "", args: positional.slice(1), raw };
}
function stripQuotes(s) {
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
        return s.slice(1, -1);
    }
    return s;
}
const BROWSER_CMDS = new Set(["open", "list_tabs", "close_tab", "refresh"]);
// --- build CLI message ---
function buildMessage(action, args) {
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
            console.error("Page commands (tab required): click | real_click | type | keyboard | upload_file | paste_rich | show | hide | get_text | get_css | get_page_info | get_js_errors | clear_js_errors | screenshot | scroll");
            console.error("");
            console.error("Example: cda send abc123 get_page_info current");
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
        let params = {};
        if (command === "get_css" || command === "show") {
            const selector = args[3];
            if (!selector) {
                console.error(`Error: "${command}" requires a selector argument.`);
                console.error(`Usage: cda --server <url> send ${nodeId} ${command} <tabId> <selector>`);
                process.exit(1);
            }
            params = { selector };
        }
        else {
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
// Extract command name + params for special handling (e.g. screenshot file save)
const cmdName = msg.payload?.command;
const cmdParams = (msg.payload?.params || {});
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
            // screenshot 命令：data 是 base64 PNG，解码写文件
            if (cmdName === "screenshot" && typeof data === "string" && data.length > 0) {
                const outPath = cmdParams.path || "screenshot.png";
                const fs = require("fs");
                const buf = Buffer.from(data, "base64");
                fs.writeFileSync(outPath, buf);
                console.log(`Screenshot saved: ${outPath} (${buf.length} bytes)`);
            }
            else if (data !== undefined && data !== null) {
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
