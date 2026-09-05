<p align="center">
  <img src="chrome-extension/icons/icon128.png" width="80" alt="chrome-do-action logo"/>
</p>

<h1 align="center">chrome-do-action</h1>

<p align="center">
  <strong>Control a real Chrome browser with a single command.</strong><br/>
  No scripts to write, no test frameworks to install — drive click, type, upload, screenshot and data scraping on any machine running the extension, straight from your terminal.
</p>

<p align="center">
  <a href="https://github.com/smarty-kiki/chrome_do_action/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"/></a>
  <img src="https://img.shields.io/badge/Chrome-MV3-green.svg" alt="Chrome Manifest V3"/>
  <img src="https://img.shields.io/badge/TypeScript-5-blue.svg" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/transport-WebSocket-orange.svg" alt="WebSocket"/>
  <img src="https://img.shields.io/badge/dependencies-ws%20only-brightgreen.svg" alt="Single runtime dependency"/>
</p>

<p align="center"><a href="README.md">简体中文</a> · English</p>

---

## Why use this project?

For these situations, writing a Playwright / Selenium script often feels like overkill — here it's just **one command**:

- Drive a browser on someone else's / a remote machine — open pages, fill forms, click buttons, grab screenshots
- Admin backends where **synthetic clicks don't work** — where you need to **paste styled rich text** or **upload cover images** without a native file dialog
- Scrape page content, lazy-loaded lists, and **listen for JavaScript errors** in the page
- Get operation results back as **structured JSON** — ready to feed into scripts or an LLM agent

It turns the idea of "the browser as a programmable robot" into a simple pipeline:

```
your command → server → Chrome extension → execute in the page → structured result
```

- Command-line only, **zero scripting**; composes with pipes (`| grep`, `| xargs`)
- **Structured JSON** output, a natural fit for automation pipelines and LLM agents
- **One server, many browsers** — remotely drive Chrome on any machine
- Handles the genuinely hard parts of browser automation: real clicks, rich text, file uploads, hover toolbars

---

## Highlights

| Capability | What it does |
|---|---|
| 🖱️ Page actions | Open / refresh / close tabs, click, type, scroll, screenshot — most interactions a browser can do |
| 🔥 Real clicks (`real_click`) | Sends a complete, genuine mouse event chain, breaking through sites that ignore synthetic events (a synthetic click that looks successful but never fires); supports multi-level hover paths |
| 📝 Rich text | `type` writes plain text verbatim (no auto paragraphing); `paste_rich` pastes styled HTML — font size / color / bold / layout live in the markup, handed to the page as-is |
| 🖼️ File uploads | `upload_file` injects a base64 image into a file input and triggers upload, bypassing the native file dialog |
| 🎯 Drag-drop uploads (`upload_dragdrop`) | Drags a file into an upload area that has no file input and only accepts drops, dispatching dragenter/dragover/drop |
| 📸 Page screenshots | Pixel-accurate "what you see" screenshot, saved to a local PNG — spot overlays, floating layers, scroll position |
| 🐛 JS error collection | Keeps collecting `error` + `unhandledrejection` from page load; query or clear anytime |
| ⚡ Selective fields (`--field`) | Every command returning an object supports dot-path projection (`--field "clickDesc.selector,settledMs,currentTab.url"`) — only requested fields are collected and returned; faster commands, leaner output |
| ⏳ Impact-aware returns | Action commands wait for their impact to land before returning (event-driven via DOM mutations/long tasks, no fixed sleep; `settledMs` reports the wait). For late-arriving effects, pass a `waitFor` predicate (50ms polling, returns the moment the condition holds — reliable even on background tabs) |
| 🗺️ Element map (`list_elements`) | One command lists every interactive element on the page — generated selectors ready to reuse, visibility, coordinates, `accept` and more; run it first when you can't find an element |
| 🔍 Read-only property (`get_prop`) | Read an element property's exact raw value (`value` / `checked` / `innerHTML` / …); read-only, never executes — verify a type really landed, check a checkbox state, compare raw content |
| 🔎 State-aware | Detects page navigations, newly opened tabs, and iframe changes, so a command returns the world *after* the action, not a bare event |
| 🌘 Shadow DOM support | Every element command transparently pierces open shadow roots (DevTools `#shadow-root` paths / `>>>` / bare-selector fallback); `get_page_info` html includes shadow content by default |
| 🔁 High availability | Auto-reconnect, per-tab serial command queue, automatic content-script re-injection |
| 🌐 Multi-browser | One server connects to multiple browser clients; target any one by node name |

---

## Architecture

```
┌─────────────┐   WebSocket    ┌──────────┐   WebSocket   ┌──────────────┐
│  CLI tool    │ ◄────────────► │  server  │ ◄───────────► │ Chrome ext   │
│  cda         │  cli / result │  (Node)  │  command/ack │ (Service     │
└─────────────┘                └──────────┘              │  Worker)     │
                                                         └──────┬───────┘
                                                                │ chrome.tabs.sendMessage
                                                                ▼
                                                      ┌──────────────────────┐
                                                      │    Content Script    │
                                                      │  (real actions in    │
                                                      │        the page)     │
                                                      └──────────────────────┘
```

- **CLI tool (`cda`)** — command-line client; sends a command, blocks until the result arrives, then exits (drops straight into any script / pipeline)
- **Server (Node.js)** — WebSocket hub that keeps a registry of connected browsers, forwards CLI commands, relays results back, and writes a rolling daily log
- **Chrome extension (Manifest V3)** — Service Worker maintains the long-lived connection and dispatches commands to the target tab via `chrome.tabs.sendMessage`
- **Content Script** — injected into the page; performs the real work (clicking, typing, reading content, collecting errors)

> One server supports **multiple browsers**. Run `cda list` to see who's online and `cda send <nodeName> ...` to target one.

---

## Quick start

Bring up three pieces in order: **server → Chrome extension → CLI**. A local demo takes about 3 minutes.

### 1. Start the server

```bash
cd server
npm install
npm run build

node dist/server.js --port 12345 --log-dir /tmp/chrome/
```

For production, a supervisor config is included: `supervisord -c server/supervisord.conf`.

### 2. Load the Chrome extension

```bash
cd chrome-extension
npm install
npm run build
```

1. Open `chrome://extensions/` and enable **Developer mode**
2. Click **Load unpacked** and select the `chrome-extension/dist/` folder
3. Click the extension icon (or right-click → Options) and fill in:
   - **Node name**: a label for this browser, e.g. `OfficePC`
   - **Server URL**: `ws://127.0.0.1:12345`
   - **Auto-connect**: reconnect automatically on startup / disconnect

### 3. Install the CLI

```bash
cd cli
npm install
npm run build
npm link          # makes the `cda` command globally available
```

Confirm the browser is online:

```bash
cda list
# OfficePC  Chrome  192.168.1.5  online 123s
```

Note the node name and start driving:

```bash
cda send OfficePC open https://example.com
```

> `--server` defaults to `ws://127.0.0.1:12345`, so you can omit it when running locally.

---

## Documentation & integration

Two documents in the repo complement this README:

- **`SKILL.md`** — a **Skill definition** for AI assistants (Claude Code / WorkBuddy, …). Once wired into an AI tool, the AI can drive your local Chrome through `cda` directly — reusing your logged-in session to open pages, fill forms, edit & publish web content, upload files, and confirm with screenshots. Setup and the self-check flow live in the "安装 / Install" section inside.
- **`cli/help.md`** — the **complete CLI reference**: parameter formats, return structures, `--field` paths, plus the **design rationale** behind `show`/`hide`, `real_click` and other commands.

> ⚠️ **Planning to install this project as a skill for your agent? Read both files thoroughly first.** `SKILL.md` defines the skill's trigger scenarios and standard flow (server self-check, node ID lookup, command syntax); `cli/help.md` captures hard-won field experience (confirm coordinates with a screenshot, use `show` for hover menus, the edge cases of rich text and uploads, …). Jumping in with only the README, an agent is likely to trip on the same pitfalls. For everyday manual use, the command reference below covers it.

---

## Common examples

### Open a page & confirm it loaded

```bash
cda send OfficePC open https://example.com
# → { url: "https://example.com", title: "Example", iframes: [...] }

# Only the URL and title
cda send OfficePC open https://example.com --field "currentTab.url,currentTab.title"
# → { url: "https://example.com", title: "Example" }
```

### Sign in (type + click)

```bash
cda send OfficePC type current '{"selector":"#username","text":"admin"}'
cda send OfficePC type current '{"selector":"#password","text":"secret"}'
cda send OfficePC click current '{"text":"Login"}' --field "currentTab.url,navigated"
# after a successful login: navigated: true + the post-redirect page info
```

### Rich text layout + image upload

```bash
# Paste styled markup into a rich-text editor
cda send OfficePC paste_rich current '{"selector":".rich-editor","html":"<section style=\"text-align:center\"><span style=\"font-weight:bold\">Heading</span></section>"}'

# Inject a local image (converted to base64) into a file input and trigger upload
B64=$(base64 -i cover.jpg | tr -d '\n')
cda send OfficePC upload_file current "{\"selector\":\"input[type=file]\",\"base64\":\"$B64\",\"filename\":\"cover.jpg\",\"mime\":\"image/jpeg\"}"
```

### Real click on sites that ignore synthetic events

```bash
# A backend that ignores synthetic events: genuine click
cda send OfficePC real_click current '{"selector":"#submit"}'

# Multi-level hover: sweep through the trigger point first (open the hover
# menu), then click the menu item
cda send OfficePC real_click current '{"selector":".toolbar-menu","approach":[[720,224],[767,201],[811,200],[830,240]]}'
```

### Screenshot to confirm page state

```bash
cda send OfficePC screenshot current '{"path":"/tmp/shot.png"}'
# Screenshot saved: /tmp/shot.png (… bytes)
```

### Scroll, scrape a table, check for errors

```bash
cda send OfficePC open https://example.com/data
cda send OfficePC scroll current '{"y":99999}'               # scroll to bottom, wait for DOM to settle
cda send OfficePC get_text current '{"selector":"table"}'    # extract the table text
cda send OfficePC get_js_errors current                      # any JS errors on the page?
cda send OfficePC clear_js_errors current                    # reset the counter
```

---

## Command reference

Page commands need a tab (`current` or a numeric tabId); browser commands don't.

### Browser commands

| Command | Usage | Description |
|---|---|---|
| `open <url>` | `send <id> open <url>` | Open a URL in a new tab (auto-grouped), waits for load, returns page info |
| `list_tabs` | `send <id> list_tabs` | List all tabs |
| `close_tab <id>` | `send <id> close_tab current` | Close a tab (`current` or numeric tabId) |
| `refresh <id>` | `send <id> refresh current` | Reload a tab, waits for load |

### Page commands

| Command | Usage | Description |
|---|---|---|
| `click` | `send <id> click <tab> <params>` | Click an element (selector / text / coordinates) |
| `real_click` | `send <id> real_click <tab> <params>` | Genuine real click (works on sites that ignore synthetic events); supports an `approach` hover path |
| `type` | `send <id> type <tab> <params>` | Type text; supports input/textarea and rich-text editing areas |
| `keyboard` | `send <id> keyboard <tab> <params>` | Send a key press to an element (`{selector,key}`; selector optional, defaults to the focused element); optional `ctrl`/`shift`/`alt`/`meta` modifiers |
| `trigger` | `send <id> trigger <tab> <params>` | Dispatch an event on an element (`{selector,event}`): `blur` for form validation, `change`+`value` to pick a `<select>` option (React controlled components included), custom events; `focus`/`blur` move real focus (form validation works); settle + waitFor semantics |
| `upload_file` | `send <id> upload_file <tab> <params>` | Inject a base64 image into a file input and trigger upload |
| `upload_dragdrop` | `send <id> upload_dragdrop <tab> <params>` | Drag a file into an upload area with no file input that only accepts drops: `{selector,data}` where data is `{base64,filename,mime}` or `{url}` |
| `paste_rich` | `send <id> paste_rich <tab> <params>` | Paste styled HTML into a rich-text editor |
| `get_text` | `send <id> get_text <tab> [selector]` | Get an element's / the page's text |
| `get_css` | `send <id> get_css <tab> <selector>` | Get computed styles of all matching elements |
| `get_prop` | `send <id> get_prop <tab> <params>` | Read an element property's exact raw value (`{selector\|text, prop}`); read-only, never calls methods; scalars returned as-is; non-JSON-safe object values error loudly instead of silently turning empty |
| `get_page_info` | `send <id> get_page_info <tab> [--field ...]` | Get page info (url / title / iframes) |
| `list_elements` | `send <id> list_elements <tab> <params>` | Page element map: list interactive elements (generated selector / visibility / coordinates / accept) with filter/text/max/visible; pierces shadow DOM, aggregates all frames by default — run it first when you can't find an element |
| `get_js_errors` | `send <id> get_js_errors <tab>` | Get accumulated JS errors |
| `clear_js_errors` | `send <id> clear_js_errors <tab>` | Clear accumulated JS errors |
| `screenshot` | `send <id> screenshot <tab> <params>` | Page screenshot; `{"path":"/tmp/s.png"}` saves locally |
| `scroll` | `send <id> scroll <tab> <params>` | Scroll: window/iframe (via `frame`) or `{"selector":...}` to an element (scrollable container / scrollIntoView, pierces shadow DOM); smooth, returns once the DOM settles |
| `exec` | `send <id> exec <tab> <params>` | ⚠ **Troubleshooting only, high risk**: run arbitrary JS in the page's MAIN world (`{"code":"document.title"}`) — can read the page's own JS globals; console semantics (returns the last statement's value), Promises auto-awaited, only JSON-serializable values come back. Disabled by default — you must first tick the plugin option "允许 exec 命令（仅排查问题）" on the extension options page, otherwise the command is rejected with a clear error. Turn the option back off after troubleshooting; details in `cli/help.md` |

### Locating an element for click / real_click

```json
{"selector": "#submit"}              // CSS selector
{"text": "Login"}                    // by visible text (buttons/links preferred)
{"x": 100, "y": 200}                 // by coordinates
{"selector": "css:button"}           // explicit CSS prefix
{"selector": "xpath://btn"}          // XPath prefix
{"selector": "xhs-btn > #shadow-root > div > button"}  // DevTools shadow path
{"selector": "xhs-btn >>> button"}   // pierce all shadow levels
```

All element commands automatically pierce **open shadow roots**: if a bare selector (or `xpath:` / `text`) misses in light DOM, cda searches every open shadow root in document order (nested included). `real_click` works on shadow-DOM elements too. Closed shadow roots stay inaccessible — fall back to coordinate clicks (`real_click {"x":..., "y":...}`). `get_page_info --field html` includes shadow content by default: open roots appear inline as `<template shadowrootmode="open">` inside their hosts; pages without shadow DOM output exactly as before.

### Params for the other commands

```json
// type — text is inserted verbatim, never split on newlines
// (for paragraph structure send one paragraph per call, appending with mode:"append")
{"selector": ".rich-editor", "text": "Paragraph one"}

// upload_file — inject base64 into a file input
{"selector": "input[type=file]", "base64": "<base64>", "filename": "a.jpg", "mime": "image/jpeg"}

// paste_rich — paste styled HTML (mode like type: default replace clears the editor first)
{"selector": ".rich-editor", "html": "<section><span>hi</span></section>"}

// scroll — vertical / horizontal
{"y": 500}                       // or {"x": 300, "y": 500}
```

---

## Features in depth

### 1. `real_click` — for sites that ignore synthetic events

Many admin backends ignore synthesized clicks (the click looks successful but never fires). `real_click` sends a **complete, genuine mouse event chain**:

- Mouse movement is **incremental** rather than teleported, so it genuinely fires the hover chain along the path
- After the click the mouse **stays on the target**, keeping hover state for the next action
- The `approach` param simulates "move to a trigger point first, then to the target" for multi-level hover scenarios (e.g. a hover toolbar over a cover image)
- Side effect: Chrome briefly shows the "This browser is being debugged" banner while executing, then it disappears

### 2. Rich text & file uploads — bypassing the two hardest interactions

- **`type`**: regular inputs get their value written plus `input`/`change` events; rich-text editing areas get the text inserted **verbatim in one piece — no trimming, no newline splitting, no rewriting**; how it ends up formatted is the editor's own behaviour — cda adapts to no editor (send one paragraph per call for exact structure, appending with `mode:"append"`)
- **`paste_rich`**: pastes HTML with inline styles into a rich-text editor, preserving font size / color / bold / spacing; `mode` matches `type` (default `replace` is equivalent to "select all, delete, paste a formatted document"; `append`/`insert` available). HTML goes through the browser's native paste pipeline — no editor sniffing or adaptation
- **`upload_file`**: injects a base64 image into `input[type=file]` and fires `change`, so the page uploads it — no native file dialog needed (works even without accessibility permission, e.g. uploading article covers)
- **`upload_dragdrop`**: when there is no file input — only a drag-drop zone — dispatches dragenter/dragover/drop carrying the file at the target area, and the page's drop handler uploads it; complements `upload_file`

### 3. `--field` selective collection

The field list is evaluated inside the browser *before* running the command, so **unnecessary DOM work is skipped** — and the response is trimmed via dot-path projection at the exit — faster and lighter.

```bash
cda send OfficePC click current '{"text":"Login"}' --field "clickDesc.selector,settledMs,currentTab.url"
cda send OfficePC click current '{"text":"Open"}' --field "newTabs.url"
cda send OfficePC click current '{"selector":"#refresh"}' --field "iframeChanges"
cda send OfficePC type current '{"selector":"#title","text":"hi"}' --field "settledMs"
```

Supported by **every command returning an object**: `click`/`type`/`keyboard`/`trigger`/`upload_file`/`upload_dragdrop`/`paste_rich`/`scroll`/`show`/`hide`/`get_css`/`get_prop`/`get_page_info`/`list_elements`/`get_js_errors`/`real_click`/`open` (for `get_prop`, when the value is a plain object). Paths are comma-separated, dotted for nested projection: `--field a.b` returns `{a: {b: value}}` (so `res.a.b` always works in scripts); array segments project per item (`newTabs.url` → `{newTabs: [url, ...]}`); missing paths are ignored. `get_text` returns a plain string and `get_prop` scalar values pass through as-is — neither has fields to filter.

### 4. State awareness — commands return the world after the action

- **Navigation detection**: if a click causes navigation, the command **waits for the new page to finish loading** and returns its full info (with a `navigated` flag)
- **New-tab detection**: the tab list is compared before/after a click to catch `target="_blank"` popups, and each new tab is awaited until loaded
- **iframe change detection**: all iframe `src`s are captured before/after a click and diffed into `iframeChanges` (`srcChanged` / `beforeSrc` / `afterSrc`)
- **DOM-settling wait**: after scrolling, the command waits for the page to be quiet before returning (3s timeout cap)

### 5. Reliability

- **Auto-reconnect**: per round, 3 immediate retries, then a 15s pause before the next round
- **Keepalive**: ping/pong every 30s, with a Service Worker alarm as a backstop
- **Per-tab queue**: commands to the same tab run serially, avoiding races
- **Content-script self-healing**: if the script is lost, it is re-injected automatically via `chrome.scripting.executeScript` and retried
- **Tab grouping**: tabs opened with `open` are grouped under a grey `chrome_do_action` group, cleaned up automatically when empty
- **Command timeout**: the server reports a timeout after 60s with no response; if the browser goes offline, the CLI is notified immediately

### 6. JS error collection

Persistent collection starts on page load (`window.onerror` + `unhandledrejection`) and never blocks commands. Errors accumulate until you query them with `get_js_errors` or clear them with `clear_js_errors`; you can also pass `jsErrors` through any `--field`-enabled command to get them alongside the result.

---

## Return formats

### `open` / `get_page_info`

```json
{
  "url": "https://example.com",
  "title": "Example Domain",
  "iframes": [
    { "index": 0, "src": "https://ads.example.com", "sameOrigin": false },
    { "index": 1, "src": "/embedded", "sameOrigin": true, "url": "/embedded" }
  ]
}
```

Cross-origin iframes expose only `src` and `sameOrigin: false`; same-origin ones also return their inner URL.

### `click` (no navigation)

```json
{
  "navigated": false,
  "clickDesc": { "text": "Login", "tag": "button", "visible": true },
  "currentTab": { "url": "...", "title": "...", "iframes": [...] },
  "iframeChanges": [],
  "newTabs": []
}
```

- `clickDesc`: what was clicked (`text`/`selector`/`x,y` + `tag`). For `selector`/`text` targets it carries a **clickability report**: `visible: true|false` (is the element actually visible and clickable); when it is covered it adds `coveredBy: {tag, class, text}` (an overlay/dialog sits on the target point), or `offscreen: true` when the target point is outside the viewport. `visible: false` / `coveredBy` / `offscreen` mean **this synthetic click most likely never reached the page** (the command still succeeds) — screenshot first to see the real state: dismiss the overlay / `show` the element / `waitFor` the condition, or fall back to a coordinate `real_click`
- `navigated`: whether the page navigated; when `true`, the new page info is returned (including the post-redirect `currentTab`)
- `newTabs`: tabs opened via `target="_blank"` (with tabId, url, title, iframes)
- `iframeChanges`: `[{index, srcChanged, beforeSrc, afterSrc}]`, present only when a change was detected

### Other commands

| Command | Returns |
|---|---|
| `get_text` | a string, e.g. `"Login"` |
| `get_css` | `{ selector, count, results: [{index, css: {display, …}}] }` |
| `get_prop` | the exact property value (string/number/boolean as-is; plain objects returned with the matched frame; values that can't survive JSON error loudly) |
| `list_elements` | `{ count, truncated, elements: [{tag, text, visible, x, y, w, h, selector, …}] }` |
| `type` / `clear_js_errors` | `{ success: true }` |
| `upload_file` / `upload_dragdrop` | `{ success: true, data: { filename, size, mime } }` |
| `scroll` | `{ success: true, data: { scrollX, scrollY } }` |
| `get_js_errors` | `{ errors: [{message, source, lineno}], count }` |
| `close_tab` | `{ success: true, data: { tabId } }` |
| `list_tabs` | `[{ id, title, url, active }]` |
| `screenshot` | saved locally as PNG; prints the path and byte count |

---

## Wire protocol

All messages are JSON over WebSocket. The protocol is minimal — three core round trips:

| Message | Direction | Purpose |
|---|---|---|
| `register` / `register_ack` | extension ↔ server | browser registers a node; server assigns a `nodeId` |
| `command` / `command_result` | server ↔ extension | command and result (correlated by `commandId`) |
| `cli` / `cli_result` | CLI ↔ server | command-line request and answer |

Every message carries a unique `id` for request–response correlation; `ping`/`pong` keepalives run every 30s. Any language that speaks this JSON protocol can act as the CLI end.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cda list` is empty / errors | Server not running or wrong address; is the extension connected? (✕ badge = disconnected) |
| `Client "xxx" not found` | Target node offline — confirm with `cda list` |
| `no content script loaded` | The page is a `chrome://` page or not fully loaded; after updating the extension, refresh it at `chrome://extensions` and reload open pages |
| `No active tab` on click | No usable tab in the current window |
| Extension won't connect | Open `chrome://extensions` → click this extension's **service worker** to view its logs |
| Command hangs | Check the server log in `--log-dir`; follow the `[connect]` / `[send]` / `[result]` trail |

---

## License

[MIT](LICENSE) © 2026 kiki

---

*A browser remote control, built with love. Next time you need to drive a real browser — try `cda`.*
