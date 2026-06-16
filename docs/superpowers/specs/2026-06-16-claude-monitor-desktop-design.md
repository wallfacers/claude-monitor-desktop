# claude-monitor-desktop — 桌面悬浮窗监控 · 设计文档

- 日期：2026-06-16
- 状态：已确认，准备进入实现计划
- 关联：复用并增强既有仓库 `claude-monitor`（hook 脚本 + `monitor_server.py`，原为 ESP32 物理指示器所建）

## 1. 目标

给 Claude Code CLI 做一个 **Windows 桌面悬浮窗**（类似 360 悬浮球），在用户同时开多个
Claude Code 窗口跑长任务、并在网页上摸鱼时，**始终可见地**展示每个窗口的状态与计时：

- 三种状态实时可见：**运行中 / 待确认(WAITING) / 完成**。
- **WAITING 强提示**：用户摸鱼时必须被叫回去操作。
- **运行计时**：长任务能看到已跑多久；并能区分「跑得久但在干活」与「真卡住」。

非目标（YAGNI）：历史统计/图表、远程多机监控、进程级强制 kill、Codex 等其它工具（后续迭代）。

## 2. 架构

```
┌─ Claude Code 多窗口（WSL，任意后端 glm/kimi/qwen/cc…）
│   hooks(command):
│     UserPromptSubmit → running   (并记 run_started)
│     PostToolUse      → heartbeat (只刷新 last_seen，不改状态)   ← 新增
│     Notification     → waiting
│     Stop             → done
│        ↓ curl POST /api/window-status
│
├─ 监控服务 monitor_server.py（WSL，127.0.0.1:8787，Python stdlib，零三方依赖）
│   每 session 维护：status / run_started / last_seen
│   GET /state → {windows:[{id,name,status,run_sec,idle_sec}], aggregate, ts}   ← 字段增强
│        ↑ HTTP 轮询(约 1s)
│   ┄┄ WSL2 localhost 转发 ┄┄
│
└─ claude-monitor-desktop（Windows，Tauri）   ← 本项目主体
     - 无边框 + 透明 + 毛玻璃 + 始终置顶悬浮窗
     - 收起态：三状态计数条；展开态：半透明窗口列表 + 计时
     - 轮询 /state → 渲染 → WAITING 时闪烁/声音/自动展开
     - 托盘菜单：鼠标穿透开关、置顶开关、退出
     - 开机自启：启动时确保 WSL 后端在跑（/healthz 探测，必要时 wsl.exe 拉起）
```

四个组件通过明确接口解耦，可各自独立测试。

### 2.1 组件边界

| 组件 | 职责 | 接口 | 依赖 |
|---|---|---|---|
| hook（增强 `report-status.sh` + PostToolUse 心跳） | 事件→状态映射；心跳刷新活跃度 | stdin JSON → HTTP POST | jq、curl |
| `monitor_server.py`（增强） | 维护 run_started/last_seen 双时间戳；聚合；清理 | HTTP `/state` `/api/window-status` `/healthz` | Python stdlib |
| Tauri 前端（HTML/CSS/JS） | 渲染收起/展开两态、计时、闪烁、去抖 | 消费 `/state` JSON | WebView2 |
| Tauri 后端（Rust）+ 系统集成 | 窗口属性、托盘、穿透、自启、拉起 WSL 服务 | Tauri command / 系统 API | Tauri + 插件 |

### 2.2 代码分布

- 本仓库 `claude-monitor-desktop`：仅 Windows 端 Tauri 应用。
- 既有仓库 `claude-monitor`：在原处增强 hook 与 `monitor_server.py`（ESP32 也可复用增强后的 `/state`）。
- 两仓库通过 `/state` 契约解耦。

## 3. 技术选型

- **桌面端：Tauri（Rust + WebView2）**。复用草图的 HTML/CSS，原生支持无边框/透明/置顶/托盘/穿透，
  打包体积小（~10MB）、内存低。代价：需 Rust 工具链。
- **前端复用**：`mockup.html` 的样式与两态结构直接演进为生产前端。
- **后端：沿用 Python stdlib**（用户为 miniconda py3.13），零三方依赖。

## 4. 数据契约与状态逻辑（方案 B：双时间戳）

### 4.1 `/state` 响应

```json
{
  "windows": [
    { "id": "5b04c151", "name": "data-weave", "status": "running",
      "run_sec": 512, "idle_sec": 3 },
    { "id": "85f51e25", "name": "eimosp-integration-data-web", "status": "waiting",
      "run_sec": 0, "idle_sec": 42 }
  ],
  "aggregate": "waiting",
  "ts": 1750000000
}
```

字段语义：
- `status` ∈ `running | waiting | done`。
- `run_sec` = `now - run_started`，仅 running 有意义 → 显示「已跑 8:32」。
- `idle_sec` = `now - last_seen`（最近任何 hook 事件）→ 卡住判据。
- `name` = cwd 末级目录名，重名加 session 短前缀（沿用现有逻辑）。
- `aggregate` 优先级：waiting > running > done > idle。

### 4.2 状态机（后端按事件更新）

| hook 事件 | 动作 |
|---|---|
| `UserPromptSubmit` | status=running；置 `run_started=now`；`last_seen=now` |
| `PostToolUse`（新增心跳） | `last_seen=now`；status 不变（仍 running） |
| `Notification` | status=waiting；`last_seen=now` |
| `Stop` | status=done；`last_seen=now` |

### 4.3 卡住判定（阈值默认 600s，可配）

- 正常长任务：status=running 且 `idle_sec` 小 → 绿色，计时正常色。
- 疑似卡住：status=running 且 `idle_sec ≥ 阈值` → 计时数字变黄 + 行标「疑似卡住」。
- 待确认：status=waiting → 行高亮 + 收起条黄闪 + 声音 + 自动展开。
- 计时数字默认展示 `run_sec`。

### 4.4 死窗口清理（修正既有冲突）

- **只清理 done 窗口**：done 且超过 `STALE_SEC` 才从 `/state` 移除。
- **running / waiting 永不因超时消失**：卡住的任务不发 hook 也必须留着报警（这是旧版 `STALE_SEC=600`
  会把卡住任务在第 10 分钟误删的 bug，本设计修正）。
- 进程已退但状态停在 running 的残留：由托盘「清空已结束/全部」手动清理；进程级自动探测属 YAGNI，暂不做。

## 5. 桌面端交互与系统集成

### 5.1 窗口形态
- 无边框 + 透明 + 始终置顶（托盘可关）+ 不进任务栏。
- 毛玻璃：`window-vibrancy` 的 acrylic/mica；不可用时回退半透明纯色背景。
- 收起 ↔ 展开：默认 hover 展开、移开收起；支持点击「钉住」保持展开。
- UI 约定（来自草图迭代教训）：表头计数永远独立成行、用 flex-wrap 的 chip，**不得**与标题挤同一行；
  半透明层与其背景层必须同宽同圆角，避免露出方角/多余边框。

### 5.2 收起态 / 展开态
- 收起态：紧凑三状态计数条，同时显示 运行/待确认/完成 三类计数；待确认项黄底 + 圆点闪烁；为 0 的项灰显。
- 展开态：半透明毛玻璃面板，逐行列窗口（状态点 + 名称 + 状态文字 + 计时）；待确认行高亮。

### 5.3 交互定位
- 记住位置：拖动后坐标存本地配置（Tauri `app_config_dir/settings.json`），重启恢复。
- 鼠标穿透可选：托盘菜单 + 全局快捷键切换 `set_ignore_cursor_events`；穿透时降低不透明度作为视觉提示。
- 置顶开关：托盘菜单项。
- 开机自启：`tauri-plugin-autostart` 注册 Windows 启动项，设置可关。

### 5.4 提醒（WAITING）
- 声音（默认开）：waiting 由无变有时播放一次内置提示音，音量/开关可配。
- 自动展开：出现 waiting 自动收起→展开，整条黄色描边闪烁；无 waiting 后可自动收起。
- 去抖：同一 session 的 waiting 在冷却期内只提醒一次，避免状态抖动狂响。

### 5.5 后端连通与拉起（WSL ↔ Windows）
- 连接：Windows 访问 `http://localhost:8787/state`，依赖 WSL2 默认 localhost 转发。
- 启动自检：先探 `/healthz`；不通则 `wsl.exe -d <distro> -- bash -lc 'nohup python3 <server> >/tmp/monitor.log 2>&1 &'`
  拉起后重试。
- 断线处理：轮询失败显示「离线」灰标 + 保留上次画面；恢复后自动复活。
- 轮询频率：默认 1s，可配。

## 6. 错误处理

- hook 层：任何失败 `exit 0`，绝不阻塞 Claude Code；curl `--max-time 2`。心跳为高频事件，同样静默失败。
- server 层：坏 JSON / 缺字段返回 400 不崩；单连接异常不影响其它；时间用可注入 clock。
- 桌面层：后端不可达→离线灰标 + 保留上帧；坏数据→跳过本次渲染保留上一帧；WSL 拉起失败→托盘标
  「后端未启动」+「重试」项，不反复狂拉；acrylic 不可用→回退半透明纯色。

## 7. 测试策略

- hook（bash）：喂各种假 stdin（含 PostToolUse），桩掉 curl，断言映射与 POST body（扩展 `test_report_status.sh`）。
- server（Python unittest）：覆盖 ①run_started/last_seen 双时间戳；②`/state` 输出 run_sec/idle_sec；
  ③running/waiting 不被超时清理、done 被清理；④坏输入 400（扩展现有 13 测试，注入 clock 控时）。
- 桌面前端：将「JSON→渲染模型」「卡住判定」「聚合色」「提醒去抖」抽为纯函数单测；渲染层 mock 数据快照。
- 端到端（无 Windows 也能跑大半）：启动 server → hook 喂假事件序列（提交→多次心跳→卡住→waiting）→
  curl `/state` 断言 run_sec/idle_sec 演进 → 桌面端连本地 server 目测两态、闪烁、声音。

## 8. 待核实项（不臆测，实现/联调时实测）

1. WSL 发行版名、`monitor_server.py` 绝对路径、python 解释器路径（用于 wsl.exe 拉起命令）。
2. WSL2 localhost 转发对 `127.0.0.1` 绑定是否稳；必要时 server 改绑 `0.0.0.0` + 走 WSL IP。
3. acrylic/mica 在用户 Windows 版本上的可用性与回退表现。
4. `PostToolUse` hook 的 stdin 字段是否含 `session_id`/`cwd`（与其它事件一致）；`Notification` 是否覆盖全部
   WAITING 场景。

## 9. 集成注意

- 用户 `~/.claude/settings.json` 已有 `hooks` 配置；新增/修改 hook 必须**合并保留**，不可覆盖。
- 用户在多模型后端间切换（settings.json.*_w）；hook 配在用户级 settings 对所有后端生效，与后端无关。
- 「始终置顶」默认开（摸鱼时需可见），托盘可关。
