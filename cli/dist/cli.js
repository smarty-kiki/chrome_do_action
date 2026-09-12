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
                          <url> is a BARE URL string — not a JSON object.
                          Passing '{"url": ...}' is rejected with an error
                          (JSON params are only for page commands)
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
                              Params: {selector} / {x,y} / {backendNodeId};
                              optional {approach} = [[x,y],...] path to move
                              through progressively, triggering hover chains
                              before clicking.
                              Works in iframes, including cross-origin.
                              Same settle + waitFor semantics as click.
                              Returns a RECEIPT of what it actually hit:
                              hit {tag, class, text, backendNodeId,
                              inClosedShadowRoot} — sampled at the click point
                              after hover settles and BEFORE the button goes
                              down, so a wrong coordinate is reported instead
                              of silently clicking something else. Because the
                              hit test runs over CDP, it stays truthful inside
                              shadow roots (in-page elementFromPoint would
                              report the host). hitUnavailable explains why hit
                              is missing if it is. Also returns {x, y, navigated,
                              settledMs}; hit + x/y together let a script assert
                              "I am about to click 暂存离开" and abort otherwise.
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
                              data = {base64,filename,mime} or {url} (fetched);
                              {trusted:true} instead performs a real
                              browser-level drag of the disk file at data.path
                              (absolute path on the machine running Chrome) —
                              trusted events, passes uploaders that validate
                              isTrusted (e.g. WeChat media library); returns
                              {selector,filename,x,y,trusted,settledMs}
                              (no size/mime — no stat access)
  paste_rich <tab> <params>   Paste styled HTML into contenteditable
                              ({selector,html[,mode][,waitFor]}); mode:
                              replace(default)/append/insert;
                              uses only the browser's native editing commands —
                              the editor decides how the HTML lands;
                              no editor sniffing/adaptation
  set_cursor <tab> <params>   Place the caret at a text substring inside a
                              contenteditable editor — e.g. right after a keyword
                              to trigger its suggestion popup
                              ({selector,text[,occurrence][,position]});
                              position: after (default, right after the match) /
                              before (right before the match) / start (start of
                              the matching line) / end (end of the matching line);
                              occurrence: nth match (default 1); not found →
                              error including the total match count. Waits for
                              the editor to land the caret, then reads the ACTUAL
                              caret back — returns {row,col,text}: row 0-based,
                              col = offset inside the line text (JS string index),
                              text = full line containing the caret. The editor
                              may normalize the caret; the read-back is
                              authoritative. Same settle + waitFor semantics as
                              click.
  get_cursor <tab> <params>   Read the caret position inside a contenteditable
                              editor ({selector}): returns
                              {inEditor,row,col,text} — row 0-based, col = offset
                              inside the line text (JS string index), text = full
                              line containing the caret. Caret not inside that
                              editor → {inEditor:false, row:null, col:null,
                              text:null} (not an error). Use it to verify where a
                              set_cursor or a manual click left the caret.
  show <tab> <selector>       Force-show all matching hidden elements
                              (inline style; makes hover-only menus clickable)
  hide <tab>                  Restore all elements shown by show
                              (clears inline style back to CSS control)
  get_text <tab> [params]     Get text of element ({selector}) or entire page
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
                              ({filter,text,max,visible,closed}[,frame]); filter:
                              button|link|input|select|textarea|label|editable|upload
                              (comma-separated); text: substring match on element
                              text; max: output cap 1-200 (default 50, truncation
                              flagged); visible: true=visible only, false=hidden only.
                              Defaults to aggregating ALL frames (each element carries
                              its frame url when not in the top frame); {frame} narrows
                              to top/one frame. Pierces open shadow DOM. Use this when
                              you cannot find an element - get a map first.
                              {closed:true} ALSO lists interactive elements inside
                              CLOSED shadow roots (invisible to every in-page channel)
                              — these come back with backendNodeId + inClosedShadowRoot
                              and NO selector (a closed root has no stable path), and
                              are listed FIRST so a small max cannot silently drop
                              them; returns closedCount; if the closed pass could not
                              run, closedError says so (never a silent 0). Off by
                              default: without it the output is unchanged. If
                              truncation dropped closed items, a warning says how many.
  get_rect <tab> [params]     Authoritative element geometry, in the SAME coordinate
                              space as real_click {x,y} (top-level viewport CSS px) —
                              reading centerCss here and feeding it to real_click
                              hits that same element. {selector|text|exact|all|
                              waitStableMs|scroll}[,frame]; or {selectors:[".a",".b"]}
                              for a batch (one round trip, per-item code, one debugger
                              attach for all fallbacks); or {backendNodeId} for elements
                              inside a closed shadow root. Returns x/y/width/height
                              (unchanged) plus rectCss, centerCss, tag, class, text,
                              visible, covered, hitTest (what the center point actually
                              hits — CDP-based, so it is truthful inside shadow roots),
                              matchCount, allMatches[] (ambiguous TEXT matches; each with
                              rectCss/visible/priority, priority 0 = the one plain
                              {text} would click), waitStable {waited,stable},
                              backendNodeId, inClosedShadowRoot, source.
                              Closed shadow roots are pierced automatically when the
                              in-page channels find nothing (no opt-in needed).
                              Errors are distinguishable by code: not-found (really
                              absent) / unreachable-subtree (exists, but has no usable
                              geometry) / cdp-unavailable (another debugger client is
                              attached). Being covered is NOT an error: see covered.
  get_viewport <tab>          Viewport truth for screenshot math: {viewportCss:{w,h},
                              dpr, scrollCss:{x,y}, screenCss:{w,h}, devicePixelRatio,
                              isTop, url}. dpr agrees with screenshot's (imagePx.w /
                              viewportCss.w). Reads the frame you route to (default:
                              top frame) and reports isTop honestly.
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

  screenshot <tab> <params>   Capture a page screenshot ({path} saves the PNG there).
                              CLI prints JSON, not just the path:
                              {path, bytes, imagePx:{w,h}, viewportCss:{w,h}, dpr,
                              scale, chromeInsetCss:{top,left}, scrollCss:{x,y},
                              mapping}. imagePx is the PNG's real pixel size and
                              mapping tells you how to convert image pixels to
                              CSS px (divide by dpr) — the same space real_click
                              takes. imagePx.w / dpr === viewportCss.w always
                              holds, and chromeInsetCss is {0,0}: the capture
                              contains the page viewport only, no browser UI.
                              If those invariants ever fail at runtime, a
                              warning field says so instead of a wrong mapping.
                              Without {path} it writes ./screenshot.png.
  scroll <tab> <params>       Scroll window/iframe ({y} or {x,y}; {frame} picks iframe),
                              or to an element / inside a scrollable container
                              ({selector}[,y][,block]) — pierces shadow DOM

frame param (optional, for element commands that search iframes):
  {frame: "auto"}             (default) top frame first, then all iframes
  {frame: "top"}              top frame only
  {frame: 0}                  first top-level iframe (0-based index)
  {frame: {url: "substring"}} first frame whose url contains the substring
                              (most reliable for cross-origin iframes)

Coordinates — ONE space, promised in four places:
  real_click {x,y}  =  get_rect.centerCss  =  list_elements coordinates  =
  screenshot math (imagePx / dpr) — all top-level viewport CSS px, the unit
  getBoundingClientRect() uses in the top frame. Read a center here, feed it
  there, hit that element; an offset that comes from anywhere else (a raw
  screenshot pixel, a page-absolute position) must be divided by dpr and/or
  have the scroll subtracted first. Elements inside iframes are reported in
  the SAME top-level space (frame offsets already added), so a coordinate
  never needs adjusting by hand.

Settle — impact-aware returns (click/type/keyboard/trigger/upload_file/
upload_dragdrop/paste_rich/set_cursor/scroll/real_click):
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
  cda send abc set_cursor current '{"selector":".rich-editor","text":"#发布","position":"after"}'
  cda send abc get_cursor current '{"selector":".rich-editor"}'
  cda send abc upload_file current '{"selector":"input[type=file]","base64":"<b64>","filename":"a.jpg","mime":"image/jpeg"}'
  cda send abc upload_dragdrop current '{"selector":".upload-area","data":{"base64":"<b64>","filename":"a.jpg","mime":"image/jpeg"}}'
  cda send abc scroll current '{"y":500}'
  cda send abc trigger current '{"selector":"#username","event":"blur"}'
  cda send abc trigger current '{"selector":"#category","event":"change","value":"2"}'
  cda send abc get_prop current '{"selector":"#title","prop":"innerHTML"}'
  cda send abc list_elements current '{"filter":"upload","visible":true}'
  cda send abc list_elements current '{"text":"发布","max":10}'
  cda send abc list_elements current '{"closed":true}'          # also list buttons inside closed shadow roots
  cda send abc get_rect current '{"text":"暂存离开"}'
  cda send abc get_rect current '{"selectors":[".a",".b",".c"]}'  # batch, one round trip
  cda send abc get_rect current '{"selector":".x"}' --field "centerCss"   # -> {centerCss:{x,y}} feed straight to real_click
  cda send abc get_rect current '{"backendNodeId":1234}'        # element found via list_elements {closed:true}
  cda send abc get_viewport current
  cda send abc real_click current '{"selector":"#submit"}' --field "hit.text"   # confirm what you are about to click
  cda send abc screenshot current '{"path":"/tmp/shot.png"}'
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
// open/show 收裸字符串参数（URL / selector），而页面命令收 JSON params——agent 常
// 按页面命令习惯传 '{"url":...}' / '{"selector":...}'。原样塞给扩展只会开垃圾 tab
// 或找不到元素且无提示，这里检测 JSON 对象形态，让调用方报纠正错误而非静默失败
function jsonObjectArg(raw) {
    const s = stripQuotes(raw).trim();
    if (!s.startsWith("{"))
        return null;
    try {
        const v = JSON.parse(s);
        return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
    }
    catch {
        return null;
    }
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
            console.error("Page commands (tab required): click | real_click | type | keyboard | trigger | upload_file | upload_dragdrop | paste_rich | set_cursor | get_cursor | show | hide | get_text | get_prop | get_rect | get_viewport | get_page_info | list_elements | get_js_errors | clear_js_errors | screenshot | scroll");
            console.error("Troubleshooting only (needs plugin option enabled): exec");
            console.error("");
            console.error("Example: cda send abc123 get_page_info current");
            process.exit(1);
        }
        if (BROWSER_CMDS.has(command)) {
            let params = {};
            const raw = args[2] || "";
            switch (command) {
                case "open": {
                    // open 缺 url 不再静默开 about:blank——报 usage 错误
                    if (!raw) {
                        console.error("Error: open requires a URL argument.");
                        console.error(`Usage: cda --server <url> send <nodeId> open <url>`);
                        process.exit(1);
                    }
                    // open 的参数是裸 URL 字符串，不是页面命令那种 JSON params——检测到 JSON
                    // 对象就报纠正错误（附解析出的 url，告诉对方直接传它），不开垃圾 tab
                    const openJson = jsonObjectArg(raw);
                    if (openJson) {
                        const u = typeof openJson.url === "string" ? openJson.url : "";
                        console.error("Error: open takes a bare URL string, not JSON params (JSON params are only for page commands).");
                        if (u)
                            console.error(`The url inside your JSON is: ${u} — pass it directly:`);
                        console.error(`Usage: cda --server <url> send <nodeId> open <url>`);
                        process.exit(1);
                    }
                    params = { url: raw };
                    break;
                }
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
        if (command === "show") {
            const selector = args[3];
            if (!selector) {
                console.error(`Error: "${command}" requires a selector argument.`);
                console.error(`Usage: cda --server <url> send ${nodeId} ${command} <tabId> <selector>`);
                process.exit(1);
            }
            // show 与 open 同型：selector 是裸字符串而非 JSON params，检测到即报纠正错误
            const showJson = jsonObjectArg(selector);
            if (showJson) {
                const sel = typeof showJson.selector === "string" ? showJson.selector : "";
                console.error(`Error: "${command}" takes a bare selector string, not JSON params (JSON params are only for page commands).`);
                if (sel)
                    console.error(`The selector inside your JSON is: ${sel} — pass it directly:`);
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
    // screenshot 例外：base64 是 CLI 写盘用的原料，裁剪在扩展侧发生 → 必须强制带上它，
    // 否则 `screenshot --field "imagePx,..."` 会把 data 一起裁掉，文件静默不落盘
    // （实测踩过：命令成功返回、终端打印了元数据、磁盘上什么都没有）。
    // 打印前 CLI 会把 data 剔掉，几 MB 的 base64 依旧不会进终端
    const wanted = cmdName === "screenshot" && !fields.includes("data") ? ["data", ...fields] : fields;
    sendPayload.params._field = wanted;
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
    // code：机器可读错误码（not-found / unreachable-subtree / cdp-unavailable …），
    // 让脚本能区分「不存在」「存在但不可达」——不再从人类可读文案里猜
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
        // screenshot：扩展回 {data:<base64 PNG>, imagePx, viewportCss, dpr, scale,
        // chromeInsetCss, scrollCss, mapping}（老版本扩展回裸 base64 字符串，两条都支持）。
        // 写盘后打印 JSON——含 path、**不含 base64**：调用方要的是 mapping（图像素→CSS px），
        // 几 MB 的 base64 打出来只会淹没它
        const shotMeta = cmdName === "screenshot" && data !== null && typeof data === "object" ? data : null;
        const shotB64 = cmdName !== "screenshot" ? ""
            : typeof data === "string" ? data
                : typeof shotMeta?.data === "string" ? shotMeta.data
                    : "";
        if (shotB64.length > 0) {
            const outPath = cmdParams.path || "screenshot.png";
            const fs = require("fs");
            const buf = Buffer.from(shotB64, "base64");
            fs.writeFileSync(outPath, buf);
            if (shotMeta) {
                const meta = {};
                for (const [k, v] of Object.entries(shotMeta))
                    if (k !== "data")
                        meta[k] = v;
                console.log(JSON.stringify({ path: outPath, bytes: buf.length, ...meta }, null, 2));
            }
            else {
                console.log(`Screenshot saved: ${outPath} (${buf.length} bytes)`);
            }
        }
        else if (cmdName === "screenshot") {
            // 没拿到 base64 = 没有图可写。**绝不静默**：调用方以为存了图、磁盘上却没有，
            // 是这条命令最坏的失败方式（后面的图像分析会拿着一份旧文件跑）
            console.error("Error: screenshot returned no image data — nothing was written");
            process.exit(1);
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
        // 错误码放前面，脚本/agent 一眼能看出失败类别（not-found / unreachable-subtree /
        // cdp-unavailable …）——「元素不存在」和「存在但对所有通道不可寻址」不该长得一样
        console.error(`Error${res.payload.code ? ` [${res.payload.code}]` : ""}: ${res.payload.error || "unknown"}`);
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
