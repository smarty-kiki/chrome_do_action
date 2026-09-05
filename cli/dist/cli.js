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
  real_click <tab> <params>   Genuine real click (works on sites that ignore
                              synthetic events — use it when click reports
                              success but nothing actually happens).
                              Params: {selector} or {x,y}; optional {approach} =
                              [[x,y],...] path to move through progressively,
                              triggering hover chains before clicking.
                              Works in iframes, including cross-origin.
                              Same settle + waitFor semantics as click
  type <tab> <params>         Insert text into input/textarea/contenteditable
                              ({selector,text[,mode][,waitFor]}); mode:
                              replace(default)/append/insert;
                              text is inserted exactly as given — no trimming,
                              no line splitting, no reformatting;
                              contenteditable receives the text through the
                              browser's native editing pipeline (same behavior
                              as pasting — the editor decides how it lands)
  keyboard <tab> <params>     Send key press to element ({selector,key[,ctrl|shift|alt|meta][,waitFor]});
                              selector optional (defaults to focused element); key e.g.
                              Enter, Escape, Tab, ArrowDown, or a single char
  trigger <tab> <params>      Dispatch an event on an element
                              ({selector,event}[,value][,options][,waitFor]);
                              event e.g. blur/change/input/focus/select/custom name;
                              {value} sets the property first (select option,
                              input value, checkbox checked — React controlled
                              components included); focus/blur move real focus
                              (form validation works); {options} passes through
                              to the event (bubbles/detail/etc.)
  upload_file <tab> <params>  Inject base64 image into file input
                              ({selector,base64,filename,mime[,waitFor]}), triggers change;
                              pre-checks input accept (type mismatch fails loudly
                              instead of silently no-op)
  upload_dragdrop <tab> <params>
                              Drag-drop a file into an upload area that has no
                              file input and only accepts drops: dispatches
                              dragenter/dragover/drop carrying the file
                              ({selector,data}[,waitFor]);
                              data = {base64,filename,mime} or {url} (fetched)
  paste_rich <tab> <params>   Paste styled HTML into contenteditable
                              ({selector,html[,mode][,waitFor]}); mode:
                              replace(default)/append/insert;
                              uses only the browser's native editing commands —
                              the editor decides how the HTML lands;
                              no editor sniffing/adaptation
  show <tab> <selector>       Force-show all matching hidden elements
                              (inline style; makes hover-only menus clickable)
  hide <tab>                  Restore all elements shown by show
                              (clears inline style back to CSS control)
  get_text <tab> [params]     Get text of element ({selector}) or entire page
  get_css <tab> <selector>    Get computed CSS of element ({selector})
  get_prop <tab> <params>     Read a property of an element and return its exact
                              value ({selector|text, prop}); prop e.g. "innerHTML",
                              "value", "checked", "src". Read-only: reads the real
                              property, never calls methods. Object values return
                              only when they survive JSON untouched — anything that
                              would come back silently empty errors instead.
  get_page_info <tab>         Get page info (url, title, iframes), supports --field.
                              iframes include url/html for same-origin AND
                              cross-origin frames
  list_elements <tab> [params]
                              List interactive elements with generated selectors
                              ({filter,text,max,visible}[,frame]); filter:
                              button|link|input|select|textarea|label|editable|upload
                              (comma-separated); text: substring match on element
                              text; max: output cap 1-200 (default 50, truncation
                              flagged); visible: true=visible only, false=hidden only.
                              Defaults to aggregating ALL frames (each element carries
                              its frame url when not in the top frame); {frame} narrows
                              to top/one frame. Pierces open shadow DOM. Use this when
                              you cannot find an element - get a map first.
  get_js_errors <tab>         Get accumulated JS errors (aggregated across frames)
  clear_js_errors <tab>       Clear accumulated JS errors

Troubleshooting only (enabled per session):
  exec <tab> <params>         Execute arbitrary JavaScript in the page's MAIN
                              world and return the result — for inspecting real
                              page state (page JS globals etc.) when no
                              built-in command fits. HIGH RISK: requires the
                              plugin option "允许 exec 命令（仅排查问题）" to be
                              ENABLED first (extension options page), else an
                              explicit rejection error is returned. Params:
                              {code} string, evaluated like the DevTools
                              console — global scope, returns the last
                              expression's completion value; Promise results
                              are awaited; only JSON-serializable values
                              return (cyclic/BigInt data must be stringified
                              by your code first). {frame} targets an iframe
                              (same values as the frame param below; default
                              top frame). Turn the option back off after
                              troubleshooting.

  screenshot <tab> <params>   Capture a page screenshot
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

Settle — impact-aware returns (click/type/keyboard/trigger/upload_file/
upload_dragdrop/paste_rich/scroll/real_click):
  Commands wait for the action's impact to land before returning. Event-driven
  (DOM mutations + long tasks, no fixed sleep), returns {settledMs} (ms waited):
  no-impact actions return ~0.6s; impacted actions return once the DOM is quiet
  for 250ms after the last activity. Impact that arrives late (network round
  trip, long debounce) is beyond settle — pass {waitFor: {selector|text}} to
  poll (50ms, throttle-proof) until the condition holds; returns
  {waitFor: {settled, waited}}.
  Background tabs: Chrome throttles page activity while the tab is hidden
  (1s alignment, minutes-level after 5min hidden) — settle then waits an
  extra 1s confirmation window (~1.6s for no-impact actions);
  deep-background tabs may need waitFor or a focused tab.
  The server cuts any command at its 60s pending timeout — commands that chain
  long waits (slow pages, long waitFor) can hit this ceiling.

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
  cda send abc paste_rich current '{"selector":".rich-editor","html":"<section><span>hi</span></section>"}'
  cda send abc upload_file current '{"selector":"input[type=file]","base64":"<b64>","filename":"a.jpg","mime":"image/jpeg"}'
  cda send abc upload_dragdrop current '{"selector":".upload-area","data":{"base64":"<b64>","filename":"a.jpg","mime":"image/jpeg"}}'
  cda send abc scroll current '{"y":500}'
  cda send abc trigger current '{"selector":"#username","event":"blur"}'
  cda send abc trigger current '{"selector":"#category","event":"change","value":"2"}'
  cda send abc get_css current "h1.title"
  cda send abc get_prop current '{"selector":"#title","prop":"innerHTML"}'
  cda send abc list_elements current '{"filter":"upload","visible":true}'
  cda send abc list_elements current '{"text":"发布","max":10}'
  cda send abc exec current '{"code":"document.title"}'
  cda send abc exec current '{"code":"window.__INITIAL_STATE__.user"}'  # needs the plugin's allow-exec option enabled (troubleshooting only)`;
function parseArgs(argv) {
    const raw = {};
    const positional = [];
    let i = 2;
    while (i < argv.length) {
        const m = argv[i].match(/^--(\w[\w-]*)(?:=(.+))?$/);
        if (m) {
            // 未知 --flag 静默收进 raw 是隐藏行为：拼错的 --filed 不会报错，--field 静默失效
            if (!["server", "field", "help"].includes(m[1])) {
                console.error(`Unknown option: --${m[1]}`);
                console.error("Use --help for full usage.");
                process.exit(1);
            }
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
            console.error("Page commands (tab required): click | real_click | type | keyboard | trigger | upload_file | upload_dragdrop | paste_rich | show | hide | get_text | get_css | get_prop | get_page_info | list_elements | get_js_errors | clear_js_errors | screenshot | scroll");
            console.error("Troubleshooting only (needs plugin option enabled): exec");
            console.error("");
            console.error("Example: cda send abc123 get_page_info current");
            process.exit(1);
        }
        if (BROWSER_CMDS.has(command)) {
            let params = {};
            const raw = args[2] || "";
            switch (command) {
                case "open":
                    // open 缺 url 不再静默开 about:blank——报 usage 错误
                    if (!raw) {
                        console.error("Error: open requires a URL argument.");
                        console.error(`Usage: cda --server <url> send <nodeId> open <url>`);
                        process.exit(1);
                    }
                    params = { url: raw };
                    break;
                case "close_tab":
                case "refresh":
                    if (raw !== "current" && !/^\d+$/.test(raw)) {
                        console.error(`${command} tabId must be "current" or a number, got: ${raw}`);
                        console.error(`Usage: cda --server <url> send <nodeId> ${command} current|<tabId>`);
                        process.exit(1);
                    }
                    // 数字字符串原样传递（不 parseInt）：server 端统一转数字，"current" 保留字面
                    params = { tabId: raw };
                    break;
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
// done：是否已收到最终结果（close 时据此区分「正常结束」与「意外断开」）
let done = false;
let hangTimer;
ws.on("open", () => {
    ws.send(JSON.stringify(msg));
    // server 端 60s PENDING_TIMEOUT 会给结果；65s 仍无结果（server 崩溃/消息丢失）
    // 主动报错退出，不再无限等待
    hangTimer = setTimeout(() => {
        console.error("Error: no response within 65s — is the server running and the browser connected?");
        process.exit(1);
    }, 65000);
    hangTimer.unref?.();
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
    // server 主动 error（未知 action / 非法消息）：明确报错退出（原来静默忽略、挂到超时）
    if (res.type === "error") {
        console.error(`Error: ${res.payload?.message || "unknown"}`);
        process.exit(1);
    }
    if (!(res.type === "cli_result" && res.payload))
        return; // 无关消息忽略，继续等结果
    done = true;
    if (hangTimer)
        clearTimeout(hangTimer);
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
    ws.close();
});
ws.on("error", (err) => {
    console.error(`WebSocket error: ${err.message || err.code || "unknown"}`);
    process.exit(1);
});
ws.on("close", () => {
    // 已收到结果：上面正常退出。未收到结果就断开（server 崩溃/网络）——明确报错退出，
    // 不再让空 handler 静默挂着（65s hang timer 也会兜底，但这里能立刻告知）
    if (!done) {
        if (hangTimer)
            clearTimeout(hangTimer);
        console.error("Error: connection closed before a response was received");
        process.exit(1);
    }
});
function genId() {
    return Math.random().toString(36).slice(2, 10);
}
