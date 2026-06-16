# claude-monitor-desktop

桌面端 **Claude Code 监控悬浮窗**（Tauri v2 + WebView2）。像 360 那样的置顶小窗，让你摸鱼上网时也能一眼看到后台多个 Claude Code 实例**跑没跑完、当前什么状态、跑了多久、是不是卡住了**。

![状态](https://img.shields.io/badge/status-WIP-yellow)

## 它解决什么

后台同时挂着好几个 Claude Code，切来切去很烦：哪个跑完了？哪个在等你确认权限？哪个看着在跑其实卡了十几分钟？这个悬浮窗把它们收口到一个置顶小窗：

- **收起态**：一条小药丸，显示「运行中 / 待确认 / 完成」三状态计数。
- **展开态**：半透明面板，逐条列出每个实例的名称、状态、计时。
- **提醒**：出现「待确认」时黄色闪烁 + 提示音 + 自动展开；可对单条**消音**。
- **卡住检测**：运行中且超过 10 分钟没有任何 hook 回调 → 计时变黄并提示「疑似卡住」。

## 平台支持

| 平台 | 状态 | 说明 |
|---|---|---|
| **Windows** | ✅ 支持（主力）| WebView2，开发/构建/验证均在此 |
| **macOS** | 🚧 实验性 | 理论可行、接口已留好，需在 Mac 真机验证（见 [docs/macos-support.md](docs/macos-support.md)）|
| **Linux** | ❌ 不支持 | 桌面环境碎片化、透明/置顶/穿透行为不一，不投入 |

## 架构

被监控的 Claude Code（WSL / Windows）通过 hook 把状态 POST 到本地 server（Windows 原生运行，`127.0.0.1:8787`）；Tauri 悬浮窗轮询 `GET /state` 渲染。三者通过 `/state` JSON 契约解耦。

```
Claude Code(WSL/Windows)  ──hook POST 8787──▶  monitor_server.py(Windows 原生)
                                                   ▲ GET /state
                                               Tauri 悬浮窗(本项目)
```

会话生命周期映射（计数准确性的关键）：

| Hook 事件 | 上报状态 | 含义 |
|---|---|---|
| `SessionStart` | start | 登记（就绪） |
| `UserPromptSubmit` | running | 新一轮开始，重锚计时 |
| `PostToolUse` | heartbeat | 心跳（兜底识别新一轮 / 卡住判定基准）|
| `Notification`(`permission_prompt`) | waiting | 需批准工具调用 = 待确认 |
| `Notification`(`idle_prompt`) | done | 空闲等待输入 = 已完成一轮 |
| `Stop` | done | 一轮结束 |
| `SessionEnd` | end | 会话结束，移除 |

> `run_sec`（当前轮时长，对齐 Claude Code 自己的计时）与 `idle_sec`（距最近一次 hook 回调）双时间戳：区分「跑得久但在干活」与「真卡住」。

## 目录

```
server/            纯 stdlib HTTP 服务 + 单测（GET /state, POST /api/window-status）
hooks/             上报脚本：report-status.sh(WSL) / report-status.ps1(Windows)
src/               前端：index.html / styles.css / app.js + 纯函数 render.js(+单测)
src-tauri/         Tauri 外壳：透明置顶窗口、托盘菜单、开机自启、原生拉起 server
docs/              设计 spec 与实现计划
HANDOFF-WINDOWS.md Windows 侧构建/验证/配 hook 指南
```

## 开发与构建（Windows）

```powershell
npm install
npm run tauri dev      # 开发运行（自动原生拉起 server + 弹出悬浮窗）
npm run tauri build    # 打包 .msi/.exe -> src-tauri\target\release\bundle\
```

## 测试

```bash
# 后端
python3 -m unittest discover -s server
bash hooks/test_report_status.sh
# 前端
npm test
```

详见 [HANDOFF-WINDOWS.md](HANDOFF-WINDOWS.md)。
