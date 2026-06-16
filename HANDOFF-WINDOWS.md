# Windows 侧说明 —— 构建与验证

WSL 侧已完成**全部代码**（后端 + 前端逻辑 + Tauri 外壳）。Windows 侧只需 **构建、验证、打包**。

- 设计：`docs/superpowers/specs/2026-06-16-claude-monitor-desktop-design.md`
- 计划：`docs/superpowers/plans/2026-06-16-claude-monitor-desktop.md`

## 架构（一句话）

被监控的 Claude Code（WSL + Windows）经 hook 把状态 POST 到本地 server（Windows 原生跑，`127.0.0.1:8787`）；
Tauri 透明置顶悬浮窗轮询 `GET /state` 渲染。三者通过 `/state` JSON 契约解耦。

```
Claude Code(WSL/Windows)  ──hook POST 8787──▶  monitor_server.py(Windows 原生)
                                                   ▲ GET /state
                                               Tauri 悬浮窗(本项目)
```

> 后端原生跑在 Windows（不放 WSL）：原 `wsl.exe ... &` 拉起的后台进程会随 wsl 会话被回收，故改为 Tauri 原生 spawn python（同机进程不断）。镜像网络下 WSL 的 hook POST 到 `127.0.0.1:8787` 已实测可达。

## 环境实值

| 项 | 值 |
|---|---|
| 项目位置(Windows) | `D:\project\java\source\claude-monitor-desktop` |
| 后端脚本 | 随项目 `server\monitor_server.py`（纯 stdlib，Tauri 会原生 spawn） |
| 服务地址 | `127.0.0.1:8787` |
| Windows python | 已验证 3.13.5；Tauri 用命令名 `python`（若你用 Python Launcher，把 `src-tauri/src/lib.rs` 的 `python_bin()` 改成 `"py"`） |
| WSL 发行版 | `Ubuntu`（现已无需 wsl.exe，仅记录） |

## 前置安装（Windows）

- Node ≥ 18（`node --version`）
- Rust 工具链 rustup（`cargo --version`）
- WebView2 Runtime（Win10/11 多自带）
- Python 在 PATH（`python --version`）

## 已实现（代码已就绪，勿重写）

- **后端** `server/monitor_server.py`（双时间戳 run_sec/idle_sec、会话生命周期、CORS、25 unittest）
- **前端逻辑** `src/render.js`（formatDuration/buildViewModel/newlyWaiting/statusLabel，12 node:test）
- **前端界面** `src/index.html` `src/styles.css` `src/app.js`（收起三状态计数条 / 展开半透明列表 / 计时 / WAITING 闪烁+声音+自动展开 / 离线兜底 / 穿透淡显监听）
- **Tauri 外壳** `src-tauri/`：
  - `tauri.conf.json`：无边框 + 透明 + 置顶 + 不进任务栏 + `frontendDist=../src` + 把 server 打包进 resources
  - `src/lib.rs`：毛玻璃(acrylic) + 启动探端口并原生 spawn python + 开机自启 + 托盘菜单（鼠标穿透 / 始终置顶 / 退出）
  - `capabilities/default.json`：`core:default` + `core:event:default`（前端 listen 穿透事件）
- **Windows hook** `hooks/report-status.ps1`（PowerShell 版上报脚本）

## 构建与验证（Windows）

```powershell
cd D:\project\java\source\claude-monitor-desktop
git fetch origin; git reset --hard origin/feat/desktop-monitor   # 同步最新
npm install          # 装 @tauri-apps/cli

# 开发运行（会原生拉起 server + 弹出悬浮窗）
npm run tauri dev

# 打包安装包（.msi/.exe 在 src-tauri\target\release\bundle\）
npm run tauri build
```

**交互说明（重要，已按反馈重做）：** 窗口**尺寸自适应内容**（收起=小药丸，展开=面板），不再是固定大矩形/灰框。收起态：左边 `⠿` 手柄**按住拖动**移动窗口，点右边**计数区展开**；展开态：标题栏拖动，`✕` 收起。已去掉 acrylic 改用纯透明（圆角干净）。

**先确认这些点**（首次 `tauri dev` 时）：
1. 窗口无边框、随内容自适应（收起就一个小药丸，无大灰框）、背景透明、置顶、任务栏无图标。
2. 几秒内 server 被原生拉起（不再「离线」）；`curl http://localhost:8787/healthz` 得 `{"ok":true}`。
3. 收起态三状态计数条随真实 claude 跳动；点计数区展开看列表+计时，点 `✕` 收起。
4. `⠿` 手柄 / 标题栏可拖动移动窗口；关闭重开位置保持（window-state）。
5. 托盘菜单：鼠标穿透（点击穿过窗口、窗口变淡）/ 始终置顶 / 退出。
6. WAITING 出现时：黄色闪烁 + 声音 + 自动展开。把 `src/ding.mp3`（当前占位空文件）换成真实短提示音。

若 Rust 编译报某 API 名/权限 id 不符（Tauri 小版本差异），按报错微调；逻辑结构已就绪。

## 让 Windows 侧的 Claude Code 也计数（WSL N + Windows M）

WSL 的 claude 已上报。Windows 的 claude 要单独配 hooks，用 `hooks/report-status.ps1`。
在 **`%USERPROFILE%\.claude\settings.json`** 的 `hooks` 块**合并**（保留已有项），六个事件都指向 ps1：

```json
{
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\project\\java\\source\\claude-monitor-desktop\\hooks\\report-status.ps1\"" } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\project\\java\\source\\claude-monitor-desktop\\hooks\\report-status.ps1\"" } ] } ],
    "PostToolUse":      [ { "hooks": [ { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\project\\java\\source\\claude-monitor-desktop\\hooks\\report-status.ps1\"" } ] } ],
    "Notification":     [ { "hooks": [ { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\project\\java\\source\\claude-monitor-desktop\\hooks\\report-status.ps1\"" } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\project\\java\\source\\claude-monitor-desktop\\hooks\\report-status.ps1\"" } ] } ],
    "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"D:\\project\\java\\source\\claude-monitor-desktop\\hooks\\report-status.ps1\"" } ] } ]
  }
}
```

配好后重启 claude 窗口加载新 hooks。WSL 侧 hooks 已由我配进 WSL `~/.claude/settings.json`（备份在 `settings.json.monitorbak`）。

## 计数准确性（会话生命周期，已修复）

旧实现把 `Stop` 当「完成」并按时间清理 → 空闲会话 10min 消失（少算）+ 非正常退出卡 running（多算）。已按真实生命周期重做：

- `SessionStart`→登记(就绪 done) / `UserPromptSubmit`→running / `PostToolUse`→心跳 / `Notification`→waiting / `Stop`→done(保留) / `SessionEnd`→移除
- `SessionEnd` 覆盖 `/exit`、Ctrl+C、Ctrl+D、超时、`/clear`
- 兜底 `MONITOR_STALE_SEC`（默认 6h）专杀 `kill -9`/关终端/崩溃残留，不影响分钟级「卡住」判定
- 已知局限：点终端 X / `kill -9` 不触发 SessionEnd，残留到 6h 兜底；日常用 Ctrl+C 或 `/exit` 即时移除

## 待核实

1. acrylic/mica 在本机 Windows 版本上的表现（不支持自动回退 CSS 半透明）。
2. Tauri 小版本的 API/permission id 差异（编译报错按提示微调）。
3. `python` 是否在 PATH（否则改 `python_bin()` 为 `py` 或绝对路径）。
