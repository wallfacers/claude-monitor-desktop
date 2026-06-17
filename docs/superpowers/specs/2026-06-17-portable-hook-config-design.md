# claude-monitor-desktop — 钩子配置可移植化 · 设计文档

日期：2026-06-17
状态：待评审

## 背景与问题

Windows 侧要让 Claude Code 把状态上报到本地 monitor server，必须在 `%USERPROFILE%\.claude\settings.json` 的 `hooks` 块配置 6 个事件，各指向 `report-status.ps1`。当前 `HANDOFF-WINDOWS.md` 给出的配置把 ps1 路径写死成 `D:\develop\java\source\claude-monitor-desktop\hooks\report-status.ps1`，存在两个问题：

1. **路径不可移植**：换台机器、换个人、项目搬家，路径全部失效，hook 找不到脚本，Windows 侧 claude 不上报。
2. **全靠人工**：用户要手动复制 JSON、手动合并进自己的 settings.json、手动改路径，易错。

**根因**：`report-status.ps1` 没有被打包进应用 resources，也没有一个稳定可移植的落点；应用本身（`ensure_server`）已具备动态定位资源的能力，但配置钩子完全没用到。

## 目标 / 非目标

**目标**

- 应用启动时自动完成 Windows 侧钩子配置，用户下载安装后**无需手动改任何路径**。
- 配置路径与项目位置、安装位置完全解耦，换机 / 搬家 / 重装 / 升级都不破坏已生效的 hook。
- 幂等、安全：不破坏用户 settings.json 里已有的其他配置；失败不影响应用启动。

**非目标**

- 本次**不**自动配置 WSL 侧（`report-status.sh`，已手动配好）。Windows 原生进程配 WSL 的 `~/.claude/settings.json` 需跨 `wsl.exe`，成本不划算，留作后续可选项。
- 不改动前端渲染逻辑、`/state` 契约、server 逻辑。

## 方案概览

ps1 打包进应用 resources；启动时拷贝到固定用户目录 `%USERPROFILE%\.claude-monitor\report-status.ps1`；启动时（及托盘「重配钩子」）幂等合并配置进 `~/.claude/settings.json`，6 个事件的 command 指向该固定绝对路径。

用户每台机器的 settings.json 里写的是**该用户自己的绝对路径**（`C:\Users\<他>\.claude-monitor\report-status.ps1`），由应用启动时按当前用户展开写入 —— 天然可移植。

## 详细设计

### 1. ps1 打包进 resources

`tauri.conf.json` 的 `bundle.resources` 增加：

```json
"../hooks/report-status.ps1": "hooks/report-status.ps1"
```

（可顺带把 `report-status.sh` 也打包，为未来 WSL 自动配置预留，但本次不消费它。）

### 2. `ensure_hooks(app)`：落脚本

新增函数，在 `setup()` 中与 `ensure_server(app)` 并列调用：

- **目标路径**：`%USERPROFILE%\.claude-monitor\report-status.ps1`（用 `std::env::var("USERPROFILE")` 取，目录不存在则建）。
- **源**：release 用 `app.path().resolve("hooks/report-status.ps1", BaseDirectory::Resource)`；dev 回退到项目相对路径 `../hooks/report-status.ps1`（沿用 `ensure_server` 的回退模式）。
- **更新策略**：目标已存在且内容一致（字节比对）则跳过；内容不同则覆盖（保证升级后用新脚本）。

### 3. `ensure_hooks`：合并 settings.json

目标文件：`%USERPROFILE%\.claude\settings.json`。

**纯函数（便于单测）：**

```rust
fn merge_hooks(existing: serde_json::Value, ps1_path: &str) -> serde_json::Value
```

行为：

- 若 `existing` 非合法对象（null / 损坏 / 数组等），降级为空对象 `{}`（不抛错）。
- 顶层保留所有非 `hooks` 字段原样。
- `hooks`（对象）内，对 6 个目标事件键（`SessionStart` / `UserPromptSubmit` / `PostToolUse` / `Notification` / `Stop` / `SessionEnd`）：
  - 事件值为数组，形如 `[{ "hooks": [ { "type":"command", "command":"..." } ] }]`。
  - 遍历该事件的 hooks 列表，**command 含 `report-status.ps1` 的条目 → 更新其 command 为新固定路径**（迁移旧写死路径）；若没有这样的条目 → 追加一个。
  - 其他 command 的条目原样保留。
- 写出的 command 模板：

  ```
  powershell -NoProfile -ExecutionPolicy Bypass -File "<ps1_path>"
  ```

  其中 `<ps1_path>` = 当前用户的 `.claude-monitor\report-status.ps1` 绝对路径。

**IO 流程（非纯，做薄封装）：**

1. 读 settings.json（不存在 → 视为 `{}`；读取/解析失败 → 降级 `{}` 并记日志）。
2. **备份**：把读到的原始内容写 `settings.json.monitorbak`。
3. `merged = merge_hooks(existing, ps1_path)`。
4. 写回 settings.json（序列化保持 2 空格缩进，与 Claude Code 习惯一致）。

**幂等性**：相同输入产出相同输出；已配新路径的事件不被改动、无重复条目。

### 4. 触发：启动自动 + 托盘「重配钩子」

- **启动**：`setup()` 调 `ensure_hooks(app)`（在 `ensure_server` 之后）。
- **托盘**：菜单加一项 `MenuItem "重配 Claude 钩子"`，点击调 `ensure_hooks(app)`；成功 emit `hooks-configured(true)`、失败 emit `hooks-configured(false)` 给前端 toast 提示（前端监听该事件，可选小改动）。

### 5. 错误处理

所有文件 / JSON 操作捕获错误，失败记日志（`eprintln` 或 tracing），**不 panic、不阻断启动**。哲学同 `ensure_server`（"失败不致命"）。settings 未配好的最坏情况 = Windows 侧 claude 不计数，应用本身照常运行。

### 6. dev vs release

- release：`BaseDirectory::Resource` 指向安装目录 resources。
- dev：resources 不存在 → 回退 `../hooks/report-status.ps1`；settings.json 仍指向真实用户目录（开发者本机生效）。

## 测试策略（cargo test）

`merge_hooks` 纯函数 fixture：

1. 空 / 不存在 settings.json → 6 事件齐全，command 指向新路径。
2. 已有其他事件 / 其他 command 的 hook → 全部保留。
3. 已有旧写死路径（`D:\develop\...`）的 hook → command 被迁移成新固定路径，无重复。
4. 已有新路径 hook（幂等输入）→ 输出与输入一致，无重复条目。
5. 损坏 JSON / 非对象 → 降级为只含 6 事件的新结构，不 panic。

IO 层抽薄，核心逻辑靠纯函数单测覆盖；dev 手动验证落盘与 settings.json 合并的真实效果。

## 文档更新

- `HANDOFF-WINDOWS.md`：把「手动配 hooks」段落改为「应用启动自动配置，无需手动改路径；若 claude 未上报，点托盘『重配 Claude 钩子』」。旧的手动 JSON 可保留为「高级 / 排查」参考，但路径示例改用固定目录。
- `README.md`：补充「Windows 侧钩子开箱即用，首次启动自动配置」。

## 验收标准

1. 全新机器安装应用后，启动 `tauri dev` / 安装版：`%USERPROFILE%\.claude-monitor\report-status.ps1` 存在；`%USERPROFILE%\.claude\settings.json` 含 6 事件指向该路径；Windows 侧 claude 正常上报。
2. settings.json 原有非本应用 hooks / 配置完整保留；写前有 `settings.json.monitorbak` 备份。
3. 重复启动不产生重复 hook 条目（幂等）。
4. 若用户 settings.json 已有旧 `D:\develop\...` 写死路径，启动后被自动迁移成固定路径。
5. settings.json 损坏时，应用仍能启动（不 panic），日志记录。
6. `cargo test` 全绿。
