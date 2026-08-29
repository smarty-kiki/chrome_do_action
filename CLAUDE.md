# CLAUDE.md

## 版本号维护规则（每次迭代必须遵守）

版本号格式 `X.Y.Z`（major.minor.patch），**三处来源必须同步更新**：

| 文件 | 说明 |
| --- | --- |
| `chrome-extension/manifest.json` | 浏览器插件版本（Chrome 商店版本号，**只增不减**，务必同步） |
| `chrome-extension/package.json` | 插件构建配置 |
| `cli/package.json` | CLI 工具 |
| `server/package.json` | WebSocket 服务端 |

> `chrome-extension/dist/manifest.json` 是构建产物（`npm run build` 自动 copy + 改路径），**不要手动改**，只改 `chrome-extension/manifest.json` 源文件。

### 什么时候升哪一位

- **每次修改**（代码、配置或三模块内文档的任何改动）：`patch`（第三位）+1
  - 同一次会话内多次修改：每改一次 +1（0.1.0 → 0.1.1 → 0.1.2 → …）
- **每次 commit 前**：`minor`（第二位）+1，且 `patch` 归零（0.1.5 → 0.2.0）
- **major**（第一位）：**只有用户人工明确要求时**才 +1，不要自行推断
- 用户明确说「只改版本号 / bump 版本」时，按用户指定，不走上述自动规则
- **例外**：三模块（cli / server / chrome-extension）**之外**的文档改动（如仓库根目录的 SKILL.md、README、CLAUDE.md 等）**不 bump 版本号**——文档不随模块产物发布，不影响任何发布物

### 操作流程

1. 任何改动落地后，立刻同步更新上述 4 处版本号
2. commit 前再次核对 4 处版本号一致，且已按规则升到 `Y+1.0`
3. 若改动涉及插件（大概率涉及），`chrome-extension/manifest.json` 必须同步——漏掉会导致 Chrome 商店上传失败或扩展不更新

### 示例

- 修复一个 bug（改动一次）：0.1.0 → 0.1.1（4 处同步）
- 同一批工作又改了两次：0.1.1 → 0.1.2 → 0.1.3
- commit 前：0.1.3 → 0.2.0
- 用户说「升级大版本」：0.2.0 → 1.0.0

## 构建流程（改完插件源码必须执行）

1. 修改 `chrome-extension/src/` 下的源码（或 bump 版本号）后，**必须**在 `chrome-extension/` 下执行 `npm run build`
   - 浏览器加载的是 `chrome-extension/dist/` 构建产物，不重新构建的话，即使 reload 扩展，跑的还是旧代码、旧版本号
2. `dist/` 是 **git 跟踪**的构建产物（历史 commit 均包含），重新构建后改动要一并 commit
3. 构建后测试：在 `chrome://extensions` 页面点击 Chrome Do Action 卡片上的 ⟳ 重新加载扩展（unpacked 扩展不会热更新）
