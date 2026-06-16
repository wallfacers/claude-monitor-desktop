# claude-monitor-desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Claude Code CLI 做一个 Windows 桌面悬浮窗，始终可见地展示各窗口的「运行中/待确认/完成」状态与运行计时，并能区分「跑得久」与「真卡住」。

**Architecture:** 既有 WSL 后端（`monitor_server.py` + hook）增强为「双时间戳」契约（`run_sec`/`idle_sec`），新增 `PostToolUse` 心跳；Windows 端用 Tauri 透明置顶悬浮窗轮询 `GET /state` 渲染。两层通过 `/state` JSON 契约解耦，可独立测试。

**Tech Stack:** 后端 Python 3 stdlib + bash hook（仓库 `claude-monitor`）；前端逻辑纯 JS + `node:test`；外壳 Tauri v2（Rust + WebView2，仓库 `claude-monitor-desktop`）。

**两仓库路径：**
- 后端：`/home/wushengzhou/workspace/github/claude-monitor`
- 桌面：`/home/wushengzhou/workspace/github/claude-monitor-desktop`（本仓库）

**阶段可独立交付：** Phase A 完成即得到增强且测试通过的后端；Phase B 完成即得到经单测的前端渲染逻辑；Phase C/D 组装外壳与联调。

---

## Phase A — 后端增强（仓库 `claude-monitor`）

> 本阶段所有命令在 `/home/wushengzhou/workspace/github/claude-monitor` 下执行。
> 该仓库若非 git 仓库，第一步先 `git init` 并把现有文件提交一次作为基线。

### Task A0: 确保后端仓库有 git 基线

**Files:**
- 无新增，仅初始化版本控制

- [ ] **Step 1: 检查并初始化 git**

Run:
```bash
cd /home/wushengzhou/workspace/github/claude-monitor
git rev-parse --is-inside-work-tree 2>/dev/null || git init -q
git status --porcelain
```
Expected: 要么已是 git 仓库，要么 `git init` 成功；列出未跟踪文件。

- [ ] **Step 2: 提交基线（仅当有未提交内容时）**

```bash
git add -A
git commit -q -m "chore: baseline before desktop-monitor enhancements" || echo "nothing to commit"
```

---

### Task A1: StatusStore 改为双时间戳 + 心跳（核心逻辑，TDD）

**Files:**
- Modify: `server/monitor_server.py`（`StatusStore.update` 与 `get_state`）
- Test: `server/test_monitor_server.py`

- [ ] **Step 1: 写失败测试 —— run_sec / idle_sec 与心跳行为**

把下列测试 **追加** 到 `server/test_monitor_server.py` 的 `StatusStoreTest` 类中：

```python
    def test_state_includes_run_sec_and_idle_sec(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)

        win = store.get_state(now=1030.0)["windows"][0]

        self.assertEqual(win["run_sec"], 30)
        self.assertEqual(win["idle_sec"], 30)

    def test_heartbeat_refreshes_idle_but_keeps_run_started_and_status(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)
        store.update("s1", "heartbeat", "/tmp/a", now=1100.0)

        win = store.get_state(now=1100.0)["windows"][0]
        self.assertEqual(win["status"], "running")   # 心跳不改状态
        self.assertEqual(win["run_sec"], 100)        # 从开始算
        self.assertEqual(win["idle_sec"], 0)         # 活跃度刷新

    def test_running_then_idle_grows_when_no_heartbeat(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)

        win = store.get_state(now=1500.0)["windows"][0]
        self.assertEqual(win["run_sec"], 500)
        self.assertEqual(win["idle_sec"], 500)       # 没心跳 -> idle 跟着涨（疑似卡住）

    def test_heartbeat_for_unknown_session_creates_running(self):
        store = StatusStore(stale_sec=600)
        store.update("s9", "heartbeat", "/tmp/a", now=1000.0)

        win = store.get_state(now=1000.0)["windows"][0]
        self.assertEqual(win["status"], "running")

    def test_new_running_resets_run_started(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)
        store.update("s1", "running", "/tmp/a", now=1200.0)  # 新一轮 prompt

        win = store.get_state(now=1200.0)["windows"][0]
        self.assertEqual(win["run_sec"], 0)
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && python3 -m unittest test_monitor_server -v`
Expected: 新增 5 个测试 FAIL（`KeyError: 'run_sec'`、心跳被当普通状态等）。

- [ ] **Step 3: 重写 `StatusStore.update` 与 `get_state`**

把 `server/monitor_server.py` 中 `StatusStore` 的 `update` 和 `get_state` 替换为：

```python
    def update(self, session_id, status, cwd, now):
        win = self._windows.get(session_id)
        name = os.path.basename(cwd.rstrip("/")) if cwd else session_id

        if status == "heartbeat":
            if win is None:
                # 监控启动时任务已在跑：把心跳视为「此刻起运行」
                self._windows[session_id] = {
                    "id": session_id, "status": "running",
                    "name": name, "run_started": now, "last_seen": now,
                }
            else:
                win["last_seen"] = now
                if cwd:
                    win["name"] = name
            return

        if status == "running":
            run_started = now            # 新一轮 prompt = 新的计时起点
        else:
            run_started = win["run_started"] if win else now  # waiting/done 保留起点

        self._windows[session_id] = {
            "id": session_id, "status": status,
            "name": name, "run_started": run_started, "last_seen": now,
        }

    def get_state(self, now):
        visible = []
        for win in self._windows.values():
            age = now - win["last_seen"]
            # 仅 done 窗口超时清理；running/waiting 永不消失（卡住的任务不发 hook）
            if win["status"] == "done" and age > self.stale_sec:
                continue
            visible.append(win)

        basename_counts = {}
        for win in visible:
            basename_counts[win["name"]] = basename_counts.get(win["name"], 0) + 1

        windows = []
        statuses = set()
        for win in visible:
            statuses.add(win["status"])
            name = win["name"]
            if basename_counts[name] > 1:
                name = "{}#{}".format(name, win["id"][:5])
            idle = int(now - win["last_seen"])
            windows.append(
                {
                    "id": win["id"],
                    "status": win["status"],
                    "name": name,
                    "run_sec": int(now - win["run_started"]),
                    "idle_sec": idle,
                    "age_sec": idle,  # 向后兼容旧字段（= idle_sec）
                }
            )
        return {
            "windows": windows,
            "aggregate": self._aggregate(statuses),
            "ts": now,
        }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && python3 -m unittest test_monitor_server -v`
Expected: 新增 5 个测试 PASS。（旧的清理测试可能 FAIL —— 下一个 Task 修正。）

- [ ] **Step 5: 提交**

```bash
cd /home/wushengzhou/workspace/github/claude-monitor
git add server/monitor_server.py server/test_monitor_server.py
git commit -m "feat(server): dual-timestamp run_sec/idle_sec + heartbeat"
```

---

### Task A2: 修正死窗口清理规则（running/waiting 不清理）

**Files:**
- Modify: `server/test_monitor_server.py`（更新两个旧测试 + 加两个新测试）

- [ ] **Step 1: 更新旧测试以匹配新规则**

在 `server/test_monitor_server.py` 中，将 `test_stale_window_is_dropped_from_state` 的 `status="running"` 改为 `status="done"`：

```python
    def test_stale_window_is_dropped_from_state(self):
        store = StatusStore(stale_sec=600)
        store.update(session_id="old", status="done", cwd="/tmp/a", now=1000.0)

        # 601s later, no further updates -> done window considered closed
        state = store.get_state(now=1601.0)

        self.assertEqual(state["windows"], [])
```

并将 `test_aggregate_ignores_stale_windows` 中那个会变 stale 的窗口由 `waiting` 改为 `done`：

```python
    def test_aggregate_ignores_stale_windows(self):
        store = StatusStore(stale_sec=600)
        store.update("done_but_stale", "done", "/tmp/a", now=1000.0)
        store.update("running_live", "running", "/tmp/b", now=1700.0)

        # at 1701: the done window is stale (>600s) -> aggregate should be running
        self.assertEqual(store.get_state(now=1701.0)["aggregate"], "running")
```

- [ ] **Step 2: 加新测试 —— running/waiting 永不超时消失**

追加到 `StatusStoreTest`：

```python
    def test_running_window_survives_past_stale(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "running", "/tmp/a", now=1000.0)

        # 2000s later, still no hooks (stuck) -> must remain visible
        state = store.get_state(now=3000.0)
        self.assertEqual(len(state["windows"]), 1)
        self.assertEqual(state["windows"][0]["status"], "running")

    def test_waiting_window_survives_past_stale(self):
        store = StatusStore(stale_sec=600)
        store.update("s1", "waiting", "/tmp/a", now=1000.0)

        state = store.get_state(now=3000.0)
        self.assertEqual(len(state["windows"]), 1)
        self.assertEqual(state["windows"][0]["status"], "waiting")
```

- [ ] **Step 3: 运行全部 server 测试确认通过**

Run: `cd server && python3 -m unittest discover -p "test_*.py" -v`
Expected: 全部 PASS（含 `test_http_server.py`）。

- [ ] **Step 4: 提交**

```bash
cd /home/wushengzhou/workspace/github/claude-monitor
git add server/test_monitor_server.py
git commit -m "fix(server): only expire done windows; running/waiting persist"
```

---

### Task A3: hook 新增 PostToolUse → heartbeat

**Files:**
- Modify: `hooks/report-status.sh:12-17`（case 分支）
- Test: `hooks/test_report_status.sh`

- [ ] **Step 1: 写失败测试**

在 `hooks/test_report_status.sh` 中，`PreToolUse` 那个断言**之后**插入：

```bash
cap=$(run_event '{"hook_event_name":"PostToolUse","session_id":"s6","cwd":"/tmp/a"}')
assert_contains "$(cat "$cap")" '"status":"heartbeat"' "PostToolUse -> heartbeat"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bash hooks/test_report_status.sh`
Expected: 出现 `FAIL: PostToolUse -> heartbeat`（当前 PostToolUse 落入 `*)` 不发 POST）。

- [ ] **Step 3: 在 case 中加 PostToolUse 分支**

把 `hooks/report-status.sh` 的 case 块改为：

```bash
case "$event" in
  UserPromptSubmit) status="running" ;;
  PostToolUse)      status="heartbeat" ;;
  Notification)     status="waiting" ;;
  Stop)             status="done" ;;
  *)                exit 0 ;;
esac
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bash hooks/test_report_status.sh`
Expected: `ALL PASS`。

- [ ] **Step 5: 提交**

```bash
cd /home/wushengzhou/workspace/github/claude-monitor
git add hooks/report-status.sh hooks/test_report_status.sh
git commit -m "feat(hook): emit heartbeat on PostToolUse"
```

---

### Task A4: 端到端冒烟（真实跑一遍事件序列）

**Files:**
- 无改动，纯验证

- [ ] **Step 1: 启动 server 并跑事件序列**

Run:
```bash
cd /home/wushengzhou/workspace/github/claude-monitor
python3 server/monitor_server.py &
SRV=$!
sleep 1
H=hooks/report-status.sh
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"w1","cwd":"/x/proj-a"}' | bash $H
printf '%s' '{"hook_event_name":"PostToolUse","session_id":"w1","cwd":"/x/proj-a"}' | bash $H
printf '%s' '{"hook_event_name":"Notification","session_id":"w2","cwd":"/x/proj-b"}' | bash $H
curl -s http://127.0.0.1:8787/state | python3 -m json.tool
kill $SRV
```
Expected: 输出含 `w1`(running, run_sec/idle_sec 字段齐全) 与 `w2`(waiting)，`aggregate":"waiting"`。

- [ ] **Step 2: 记录联调事实（写入 spec 待核实项）**

确认通过后，无需改代码。若 `/state` 字段符合契约即视为 Phase A 完成。

---

## Phase B — 桌面前端纯逻辑（仓库 `claude-monitor-desktop`，TDD）

> 本阶段所有命令在 `/home/wushengzhou/workspace/github/claude-monitor-desktop` 下执行。
> 前置：本机有 Node 18+（`node --version` 确认）；用内置 `node:test`，零三方依赖。

### Task B1: 初始化前端逻辑目录与测试运行

**Files:**
- Create: `package.json`
- Create: `src/render.js`
- Test: `src/render.test.js`

- [ ] **Step 1: 创建 `package.json`**

```json
{
  "name": "claude-monitor-desktop",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test src/"
  }
}
```

- [ ] **Step 2: 创建占位 `src/render.js`**

```js
// 纯函数渲染逻辑（无 DOM、无副作用），便于单测。
export function formatDuration(sec) {
  return String(sec);
}
```

- [ ] **Step 3: 写失败测试 `src/render.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "./render.js";

test("formatDuration: 秒 -> m:ss", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(512), "8:32");
});

test("formatDuration: 超过 1 小时 -> h:mm:ss", () => {
  assert.equal(formatDuration(3661), "1:01:01");
});

test("formatDuration: 负数夹到 0", () => {
  assert.equal(formatDuration(-5), "0:00");
});
```

- [ ] **Step 4: 运行确认失败**

Run: `npm test`
Expected: FAIL（`formatDuration(512)` 得到 `"512"`）。

- [ ] **Step 5: 实现 `formatDuration`**

替换 `src/render.js` 的 `formatDuration`：

```js
export function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
```

- [ ] **Step 6: 运行确认通过 + 提交**

Run: `npm test`
Expected: PASS。
```bash
git add package.json src/render.js src/render.test.js
git commit -m "feat(ui): formatDuration pure helper + tests"
```

---

### Task B2: buildViewModel —— /state → 渲染模型

**Files:**
- Modify: `src/render.js`（新增 `buildViewModel`）
- Test: `src/render.test.js`

- [ ] **Step 1: 写失败测试**

追加到 `src/render.test.js`：

```js
import { buildViewModel } from "./render.js";

const sample = {
  windows: [
    { id: "a", name: "proj-a", status: "running", run_sec: 512, idle_sec: 3 },
    { id: "b", name: "proj-b", status: "running", run_sec: 700, idle_sec: 650 },
    { id: "c", name: "proj-c", status: "waiting", run_sec: 0, idle_sec: 42 },
    { id: "d", name: "proj-d", status: "done", run_sec: 0, idle_sec: 5 },
  ],
  aggregate: "waiting",
  ts: 1750000000,
};

test("buildViewModel: 计数与聚合", () => {
  const vm = buildViewModel(sample, 600);
  assert.deepEqual(vm.counts, { running: 2, waiting: 1, done: 1 });
  assert.equal(vm.aggregate, "waiting");
  assert.equal(vm.rows.length, 4);
});

test("buildViewModel: running 显示计时，其它显示 —", () => {
  const vm = buildViewModel(sample, 600);
  assert.equal(vm.rows[0].timerText, "8:32");
  assert.equal(vm.rows[2].timerText, "—"); // waiting
  assert.equal(vm.rows[3].timerText, "—"); // done
});

test("buildViewModel: 卡住判定用 idle_sec 而非 run_sec", () => {
  const vm = buildViewModel(sample, 600);
  assert.equal(vm.rows[0].stuck, false); // run 512 但 idle 3 -> 不卡
  assert.equal(vm.rows[1].stuck, true);  // run 700 idle 650 -> 卡
});

test("buildViewModel: waiting 行高亮", () => {
  const vm = buildViewModel(sample, 600);
  assert.equal(vm.rows[2].highlight, true);
  assert.equal(vm.rows[0].highlight, false);
});

test("buildViewModel: 空/缺字段安全", () => {
  const vm = buildViewModel(null, 600);
  assert.deepEqual(vm.counts, { running: 0, waiting: 0, done: 0 });
  assert.equal(vm.aggregate, "idle");
  assert.deepEqual(vm.rows, []);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（`buildViewModel is not a function`）。

- [ ] **Step 3: 实现 `buildViewModel`**

追加到 `src/render.js`：

```js
export function buildViewModel(state, stuckThresholdSec) {
  const wins = (state && Array.isArray(state.windows)) ? state.windows : [];
  const counts = { running: 0, waiting: 0, done: 0 };
  const rows = wins.map((w) => {
    if (counts[w.status] !== undefined) counts[w.status] += 1;
    const idle = w.idle_sec || 0;
    const stuck = w.status === "running" && idle >= stuckThresholdSec;
    const timerText =
      w.status === "running" ? formatDuration(w.run_sec || 0) : "—";
    return {
      id: w.id,
      name: w.name,
      status: w.status,
      timerText,
      stuck,
      highlight: w.status === "waiting",
    };
  });
  return {
    counts,
    aggregate: (state && state.aggregate) || "idle",
    rows,
  };
}
```

- [ ] **Step 4: 运行确认通过 + 提交**

Run: `npm test`
Expected: PASS。
```bash
git add src/render.js src/render.test.js
git commit -m "feat(ui): buildViewModel maps /state to view model"
```

---

### Task B3: 提醒去抖 —— 仅对新出现的 waiting 报警

**Files:**
- Modify: `src/render.js`（新增 `newlyWaiting`）
- Test: `src/render.test.js`

- [ ] **Step 1: 写失败测试**

追加：

```js
import { newlyWaiting } from "./render.js";

test("newlyWaiting: 首次出现的 waiting 触发", () => {
  const state = { windows: [{ id: "c", status: "waiting" }] };
  const r = newlyWaiting([], state);
  assert.deepEqual(r.freshWaiting, ["c"]);
  assert.deepEqual(r.waitingIds, ["c"]);
});

test("newlyWaiting: 持续 waiting 不重复触发", () => {
  const state = { windows: [{ id: "c", status: "waiting" }] };
  const r = newlyWaiting(["c"], state);
  assert.deepEqual(r.freshWaiting, []);
  assert.deepEqual(r.waitingIds, ["c"]);
});

test("newlyWaiting: 多窗口只挑新增", () => {
  const state = {
    windows: [
      { id: "c", status: "waiting" },
      { id: "e", status: "waiting" },
      { id: "a", status: "running" },
    ],
  };
  const r = newlyWaiting(["c"], state);
  assert.deepEqual(r.freshWaiting, ["e"]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（`newlyWaiting is not a function`）。

- [ ] **Step 3: 实现 `newlyWaiting`**

追加到 `src/render.js`：

```js
export function newlyWaiting(prevWaitingIds, state) {
  const wins = (state && Array.isArray(state.windows)) ? state.windows : [];
  const waitingIds = wins.filter((w) => w.status === "waiting").map((w) => w.id);
  const prev = new Set(prevWaitingIds);
  const freshWaiting = waitingIds.filter((id) => !prev.has(id));
  return { freshWaiting, waitingIds };
}
```

- [ ] **Step 4: 运行确认通过 + 提交**

Run: `npm test`
Expected: PASS。
```bash
git add src/render.js src/render.test.js
git commit -m "feat(ui): newlyWaiting debounce helper"
```

---

## Phase C — Tauri 外壳与系统集成（仓库 `claude-monitor-desktop`）

> 这一阶段涉及窗口属性、托盘、穿透、自启、轮询、拉起 WSL 后端 —— 不做单元测试，每个 Task
> 给出**手动验证**步骤。前置：本机/目标 Windows 已装 Tauri v2 前置（Rust、WebView2、Node）。
> 注意：Tauri v2 的 API/配置以脚手架生成版本为准，本计划给出关键改动点；若字段名因版本不同，
> 以 `npm run tauri` 报错提示为准微调。

### Task C1: 用脚手架初始化 Tauri v2，接入已有前端目录

**Files:**
- Create: `src-tauri/`（脚手架生成）
- Modify: `package.json`（合并脚手架的 scripts/deps）

- [ ] **Step 1: 生成 Tauri 脚手架到临时目录再合并**

Run:
```bash
cd /home/wushengzhou/workspace/github/claude-monitor-desktop
npm create tauri-app@latest tauri-tmp -- --template vanilla --manager npm --yes
```
Expected: 生成 `tauri-tmp/` 含 `src-tauri/`、`package.json`、`src/`。

- [ ] **Step 2: 把 `src-tauri/` 与 Tauri 依赖并入本仓库**

```bash
mv tauri-tmp/src-tauri ./src-tauri
# 保留我们自己的 src/（render.js 等），不要用脚手架的 src 覆盖
node -e "const a=require('./tauri-tmp/package.json'),b=require('./package.json');b.scripts=Object.assign({},a.scripts,b.scripts);b.devDependencies=Object.assign({},a.devDependencies,b.devDependencies);b.dependencies=Object.assign({},a.dependencies,b.dependencies);require('fs').writeFileSync('./package.json',JSON.stringify(b,null,2))"
rm -rf tauri-tmp
npm install
```

- [ ] **Step 3: 把 Tauri 的 `frontendDist`/`devUrl` 指向我们的静态前端**

在 `src-tauri/tauri.conf.json` 的 `build` 段设为静态目录（无打包器）：

```json
  "build": {
    "frontendDist": "../src",
    "devUrl": null,
    "beforeDevCommand": "",
    "beforeBuildCommand": ""
  }
```

- [ ] **Step 4: 手动验证：能起空窗**

需要 `src/index.html` 存在才会显示内容（下一个 Task 建）。先确认编译链通：
Run: `npm run tauri dev`
Expected: 能编译并弹出一个窗口（可能空白），无 Rust 编译错误。Ctrl+C 退出。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore(desktop): scaffold Tauri v2 shell pointing at src/"
```

---

### Task C2: 悬浮窗 HTML/CSS（由 mockup.html 演进）

**Files:**
- Create: `src/index.html`
- Create: `src/styles.css`

- [ ] **Step 1: 建 `src/index.html`**

收起态计数条 + 展开态面板的结构（沿用 `mockup.html` 的 class，但去掉演示用假背景；计数 chip 独立成行）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div id="app" class="collapsed">
    <!-- 收起态：三状态计数条 -->
    <div id="minibar" class="minibar">
      <div class="seg running"><div class="sd"></div><span data-count="running">0</span></div>
      <div class="seg waiting"><div class="sd"></div><span data-count="waiting">0</span></div>
      <div class="seg done"><div class="sd"></div><span data-count="done">0</span></div>
    </div>
    <!-- 展开态：面板 -->
    <div id="panel" class="panel" hidden>
      <div class="phead">
        <div class="phead-top"><div class="t">Claude Code 监控</div><div id="offline" class="off" hidden>离线</div></div>
        <div class="agg">
          <span class="cnt waiting"><div class="dot waiting"></div><b data-count="waiting">0</b>待确认</span>
          <span class="cnt running"><div class="dot running"></div><b data-count="running">0</b>运行</span>
          <span class="cnt done"><div class="dot done"></div><b data-count="done">0</b>完成</span>
        </div>
      </div>
      <div id="rows" class="rows"></div>
    </div>
  </div>
  <audio id="ding" src="ding.mp3" preload="auto"></audio>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 建 `src/styles.css`**

从 `mockup.html` 的 `<style>` 抽取并精简（保留 `.minibar/.seg/.panel/.phead/.agg/.cnt/.rows/.row/.dot/.timer` 等；body 背景设为透明以配合窗口透明）：

```css
:root{ --running:#3ddc84; --waiting:#ffc83d; --done:#4aa8ff; --txt:#e6e9ef; --dim:#9aa3b2; }
*{box-sizing:border-box;margin:0;padding:0;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
html,body{background:transparent}
#app{padding:6px}
/* 收起态 */
.minibar{display:inline-flex;align-items:center;gap:2px;padding:5px 6px;border-radius:999px;cursor:pointer;
  background:rgba(20,23,30,.78);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.14);box-shadow:0 6px 18px rgba(0,0,0,.5)}
.minibar.alert{border-color:var(--waiting);animation:flash 1s infinite}
@keyframes flash{0%,100%{box-shadow:0 0 0 0 rgba(255,200,61,.7)}50%{box-shadow:0 0 0 8px rgba(255,200,61,0)}}
.seg{display:flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:13px;font-weight:700;color:var(--txt)}
.seg .sd{width:9px;height:9px;border-radius:50%}
.seg.running .sd{background:var(--running);box-shadow:0 0 6px var(--running)}
.seg.waiting{color:var(--waiting);background:rgba(255,200,61,.16)} .seg.waiting .sd{background:var(--waiting);animation:blink .8s infinite}
.seg.done .sd{background:var(--done)}
.seg.zero{opacity:.32}
@keyframes blink{50%{opacity:.25}}
/* 展开态 */
.panel{width:280px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:rgba(20,23,30,.55);
  backdrop-filter:blur(14px) saturate(140%);box-shadow:0 12px 32px rgba(0,0,0,.45);overflow:hidden}
.phead{display:flex;flex-direction:column;gap:8px;padding:11px 13px;background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.08)}
.phead-top{display:flex;align-items:center;justify-content:space-between}
.phead .t{font-size:13px;font-weight:600;color:var(--txt)}
.off{color:var(--dim);font-size:11px}
.agg{display:flex;gap:6px;flex-wrap:wrap}
.cnt{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dim);padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08)}
.cnt b{font-weight:800}.cnt.waiting b{color:var(--waiting)}.cnt.running b{color:var(--running)}.cnt.done b{color:var(--done)}
.rows{padding:6px}
.row{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:8px}
.row.alert{background:rgba(255,200,61,.12);border:1px solid rgba(255,200,61,.4)}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dot.running{background:var(--running);box-shadow:0 0 8px var(--running)}
.dot.waiting{background:var(--waiting);animation:blink .8s infinite}
.dot.done{background:var(--done)}
.rname{flex:1;font-size:13px;color:var(--txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rstat{font-size:11px;font-weight:600}.rstat.running{color:var(--running)}.rstat.waiting{color:var(--waiting)}.rstat.done{color:var(--done)}
.timer{font-size:11px;color:var(--dim);font-variant-numeric:tabular-nums;min-width:46px;text-align:right}
.timer.warn{color:var(--waiting);font-weight:700}
```

- [ ] **Step 3: 放一个占位提示音**

Run: `printf '' > src/ding.mp3` 暂以空文件占位（C4 验证声音时换成真实音频；空文件不会报错，只是无声）。

- [ ] **Step 4: 提交**

```bash
git add src/index.html src/styles.css src/ding.mp3
git commit -m "feat(ui): floating widget markup + styles from mockup"
```

---

### Task C3: 前端胶水 app.js —— 轮询、渲染、收展、提醒

**Files:**
- Create: `src/app.js`
- Modify: `src/render.js`（新增 DOM 渲染函数 `applyViewModel`，可被 app.js 调用）
- Test: `src/render.test.js`（为 `rowStatusText` 等小纯函数补测）

- [ ] **Step 1: 给 render.js 加状态中文文案纯函数 + 测试**

追加到 `src/render.js`：

```js
export function statusLabel(status) {
  return { running: "运行中", waiting: "待确认", done: "完成" }[status] || status;
}
```

追加到 `src/render.test.js`：

```js
import { statusLabel } from "./render.js";
test("statusLabel 中文映射", () => {
  assert.equal(statusLabel("running"), "运行中");
  assert.equal(statusLabel("waiting"), "待确认");
  assert.equal(statusLabel("done"), "完成");
});
```

Run: `npm test` → Expected: PASS。

- [ ] **Step 2: 写 `src/app.js`（轮询 + 渲染 + 提醒）**

```js
import { buildViewModel, newlyWaiting, statusLabel } from "./render.js";

const POLL_MS = 1000;
const STUCK_SEC = 600; // 10 分钟，后续可从设置读
const STATE_URL = "http://localhost:8787/state";

let prevWaiting = [];

const $ = (s) => document.querySelector(s);
const app = $("#app");
const panel = $("#panel");
const minibar = $("#minibar");
const rowsEl = $("#rows");
const offlineEl = $("#offline");
const ding = $("#ding");

function setCounts(counts) {
  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = counts[el.getAttribute("data-count")] ?? 0;
  });
  minibar.querySelectorAll(".seg").forEach((seg) => {
    const k = seg.querySelector(".sd").parentElement.querySelector("[data-count]")?.getAttribute("data-count");
    const n = counts[k] ?? 0;
    seg.classList.toggle("zero", n === 0);
  });
}

function renderRows(rows) {
  rowsEl.innerHTML = "";
  rows.forEach((r) => {
    const div = document.createElement("div");
    div.className = "row" + (r.highlight ? " alert" : "");
    div.innerHTML =
      `<div class="dot ${r.status}"></div>` +
      `<div class="rname">${r.name ?? ""}</div>` +
      `<div class="rstat ${r.status}">${statusLabel(r.status)}</div>` +
      `<div class="timer ${r.stuck ? "warn" : ""}">${r.timerText}</div>`;
    rowsEl.appendChild(div);
  });
}

function setExpanded(expanded) {
  panel.hidden = !expanded;
  minibar.hidden = expanded;
  app.classList.toggle("collapsed", !expanded);
}

// 默认 hover 展开；有 waiting 时强制展开
minibar.addEventListener("mouseenter", () => setExpanded(true));
panel.addEventListener("mouseleave", () => { if (prevWaiting.length === 0) setExpanded(false); });

async function tick() {
  try {
    const res = await fetch(STATE_URL, { cache: "no-store" });
    const state = await res.json();
    offlineEl.hidden = true;

    const vm = buildViewModel(state, STUCK_SEC);
    setCounts(vm.counts);
    renderRows(vm.rows);

    const { freshWaiting, waitingIds } = newlyWaiting(prevWaiting, state);
    const hasWaiting = waitingIds.length > 0;
    minibar.classList.toggle("alert", hasWaiting);
    if (freshWaiting.length > 0) {
      ding.play().catch(() => {});     // 声音（默认开）
      setExpanded(true);               // 自动弹出展开
    }
    prevWaiting = waitingIds;
  } catch (e) {
    offlineEl.hidden = false;          // 后端不可达 -> 离线标，保留上次画面
  }
}

setInterval(tick, POLL_MS);
tick();
```

- [ ] **Step 3: 手动验证（连真实后端）**

Run（两个终端）:
```bash
# 终端1
cd /home/wushengzhou/workspace/github/claude-monitor && python3 server/monitor_server.py
# 终端2
cd /home/wushengzhou/workspace/github/claude-monitor-desktop && npm run tauri dev
# 终端3：喂事件
H=/home/wushengzhou/workspace/github/claude-monitor/hooks/report-status.sh
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"w1","cwd":"/x/proj-a"}' | bash $H
printf '%s' '{"hook_event_name":"Notification","session_id":"w2","cwd":"/x/proj-b"}' | bash $H
```
Expected: 悬浮窗收起态计数变化；喂 Notification 后自动展开、`proj-b` 行黄色高亮、minibar 闪烁。

- [ ] **Step 4: 提交**

```bash
git add src/app.js src/render.js src/render.test.js
git commit -m "feat(ui): polling, rendering, expand/collapse, waiting alert"
```

---

### Task C4: 窗口属性 —— 透明/无边框/置顶/不进任务栏 + 毛玻璃 + 记住位置

**Files:**
- Modify: `src-tauri/tauri.conf.json`（窗口定义）
- Modify: `src-tauri/src/main.rs`（毛玻璃 + 记住位置）
- Modify: `src-tauri/Cargo.toml`（加 `window-vibrancy`）

- [ ] **Step 1: 配置主窗口属性**

在 `src-tauri/tauri.conf.json` 的 `app.windows[0]` 设：

```json
{
  "label": "main",
  "width": 320,
  "height": 360,
  "decorations": false,
  "transparent": true,
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "resizable": false,
  "shadow": false
}
```

- [ ] **Step 2: 加毛玻璃依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 加：

```toml
window-vibrancy = "0.5"
```

- [ ] **Step 3: 启动时应用 acrylic + 恢复上次位置**

在 `src-tauri/src/main.rs` 的 `setup` 回调里（`tauri::Builder::default()...setup(|app| { ... })`）加入：

```rust
use tauri::Manager;
use window_vibrancy::apply_acrylic;

let win = app.get_webview_window("main").unwrap();
// 毛玻璃；不支持则忽略错误，回退 CSS 半透明
let _ = apply_acrylic(&win, Some((18, 21, 28, 160)));

// 记住位置：Tauri v2 内置窗口状态插件
```

在 `Cargo.toml` 再加 `tauri-plugin-window-state = "2"`，并在 builder 上 `.plugin(tauri_plugin_window_state::Builder::default().build())`（该插件自动持久化/恢复窗口位置）。

- [ ] **Step 4: 手动验证**

Run: `npm run tauri dev`
Expected: 无边框、背景透明可见桌面、置顶在其它窗口之上、任务栏无图标；拖动后关闭重开位置保持。

- [ ] **Step 5: 换上真实提示音并验证声音**

把一个真实短提示音放到 `src/ding.mp3`（覆盖占位空文件），重复 C3 的喂 Notification 步骤，确认听到一声。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/src/main.rs src/ding.mp3
git commit -m "feat(desktop): transparent always-on-top widget + acrylic + window-state"
```

---

### Task C5: 托盘菜单 —— 穿透开关 / 置顶开关 / 退出；开机自启

**Files:**
- Modify: `src-tauri/src/main.rs`（托盘 + 菜单 + 命令）
- Modify: `src-tauri/Cargo.toml`（加 `tauri-plugin-autostart`）
- Modify: `src-tauri/tauri.conf.json`（按需加 tray 图标/权限）

- [ ] **Step 1: 加自启插件依赖**

`src-tauri/Cargo.toml` `[dependencies]` 加：

```toml
tauri-plugin-autostart = "2"
```

- [ ] **Step 2: 托盘 + 菜单项（穿透 / 置顶 / 退出）**

在 `src-tauri/src/main.rs` 的 builder 里注册托盘（Tauri v2 `TrayIconBuilder` + `MenuBuilder`），菜单含：
- 「鼠标穿透」勾选项 → 切换 `win.set_ignore_cursor_events(checked)`；开启穿透时 `win.set_opacity` 或加 CSS class 降透明度作提示（通过 `win.emit("passthrough", checked)` 通知前端加淡显 class）。
- 「始终置顶」勾选项 → `win.set_always_on_top(checked)`。
- 「退出」→ `app.exit(0)`。

```rust
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, CheckMenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};

let passthrough = CheckMenuItemBuilder::new("鼠标穿透").id("passthrough").checked(false).build(app)?;
let ontop = CheckMenuItemBuilder::new("始终置顶").id("ontop").checked(true).build(app)?;
let quit = MenuItemBuilder::new("退出").id("quit").build(app)?;
let menu = MenuBuilder::new(app).items(&[&passthrough, &ontop, &quit]).build()?;

let _tray = TrayIconBuilder::new()
    .menu(&menu)
    .on_menu_event(move |app, event| {
        let win = app.get_webview_window("main").unwrap();
        match event.id().as_ref() {
            "passthrough" => {
                let on = passthrough.is_checked().unwrap_or(false);
                let _ = win.set_ignore_cursor_events(on);
                let _ = win.emit("passthrough", on);
            }
            "ontop" => {
                let on = ontop.is_checked().unwrap_or(true);
                let _ = win.set_always_on_top(on);
            }
            "quit" => app.exit(0),
            _ => {}
        }
    })
    .build(app)?;
```

前端 `src/app.js` 末尾加监听，给 `#app` 加/去 `passthrough` 淡显 class：

```js
import { listen } from "@tauri-apps/api/event";
listen("passthrough", (e) => {
  document.documentElement.style.opacity = e.payload ? "0.6" : "1";
});
```
（如脚手架未带 `@tauri-apps/api`，先 `npm i @tauri-apps/api`。）

- [ ] **Step 3: 注册开机自启**

在 builder 上：

```rust
.plugin(tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
    None,
))
```
并在 `setup` 中启用一次（首启注册）：

```rust
use tauri_plugin_autostart::ManagerExt;
let autostart = app.autolaunch();
let _ = autostart.enable();
```

- [ ] **Step 4: 手动验证**

Run: `npm run tauri dev`
Expected: 托盘出现图标；点「鼠标穿透」后点击穿过悬浮窗落到后面窗口、悬浮窗变淡；「始终置顶」可切换；「退出」关闭。重启系统后自动拉起（打包安装后验证更准）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(desktop): tray menu (passthrough/ontop/quit) + autostart"
```

---

## Phase D — 后端拉起 + 打包 + 联调收尾

### Task D1: 启动时确保后端在跑（端口探活 + 原生 spawn python）

> **修订（2026-06-16，实测后）：** 原方案「wsl.exe -d Ubuntu 拉起 WSL 内 server」作废 —— 后台进程随 wsl
> 会话结束被回收。改为 **server 随桌面项目（`server/monitor_server.py`），Windows 原生 spawn python**。
> WSL 侧只配 hooks，POST 到 `127.0.0.1:8787`（镜像网络已验证）。详见 `HANDOFF-WINDOWS.md`。

**Files:**
- Modify: `src-tauri/src/main.rs`（setup 中探活 + 原生 spawn）
- Modify: `src-tauri/tauri.conf.json`（`bundle.resources` 带上 server）
- 已就绪：`server/monitor_server.py`（随项目）

- [ ] **Step 1: 端口未监听则原生 spawn python**

```rust
use std::process::Command;
let healthy = std::net::TcpStream::connect(("127.0.0.1", 8787)).is_ok();
if !healthy {
    let _ = Command::new("python")           // 或 "py" + "-3"，视 Windows 安装
        .arg("server/monitor_server.py")      // release 用 app.path().resolve_resource(...)
        .spawn();
}
```
`tauri.conf.json` 加 `"bundle": { "resources": ["../server/monitor_server.py"] }`。零额外 Rust 依赖（std TcpStream）。

- [ ] **Step 2: 手动验证**

确保 8787 未被占用，`npm run tauri dev`。
Expected: 悬浮窗几秒内从「离线」恢复正常（server 被原生拉起）。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/main.rs src-tauri/tauri.conf.json
git commit -m "feat(desktop): spawn native python server on startup (port probe)"
```

---

### Task D2: 打包 + README + 计划自检收尾

**Files:**
- Create: `README.md`
- 验证打包产物

- [ ] **Step 1: 打 release 包**

Run: `npm run tauri build`
Expected: 在 `src-tauri/target/release/bundle/` 生成 Windows 安装包（.msi/.exe）。

- [ ] **Step 2: 安装后端到端验证一轮**

安装产物 → 开机自启生效 → 在 WSL 真跑一个 Claude Code 任务 → 悬浮窗显示该窗口 running 计时增长 → 触发权限确认时变 waiting 高亮 + 声音 + 展开 → 任务结束变 done。

- [ ] **Step 3: 写 `README.md`**

记录：架构一句话、依赖（WSL 后端 + hook 配置参见 `claude-monitor` 仓库）、`npm run tauri dev/build`、托盘菜单说明、`/state` 契约、待核实项现状。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: README for claude-monitor-desktop"
```

---

## Self-Review（计划对照 spec 的覆盖检查）

- **§2 架构 / 组件边界**：A1–A3（hook+server）、B1–B3 与 C1–C5（前端+外壳）覆盖四组件。✅
- **§4 双时间戳 / 心跳 / 卡住判定 / 清理修正**：A1（run_sec/idle_sec+心跳）、A2（清理规则）、B2（stuck 用 idle_sec）。✅
- **§5.1–5.2 窗口形态 / 两态 / UI 约定（计数独立成行）**：C2（HTML 计数 chip 独立 `.agg` 行）、C4（透明/置顶/毛玻璃）。✅
- **§5.3 记住位置 / 穿透 / 置顶 / 自启**：C4（window-state 记位置）、C5（穿透/置顶/自启）。✅
- **§5.4 提醒（声音默认开 / 自动展开 / 去抖）**：B3（去抖）、C3（声音+自动展开）。✅
- **§5.5 连通 / 拉起 / 离线 / 1s 轮询**：C3（轮询+离线标）、D1（healthz+wsl.exe 拉起）。✅
- **§6 错误处理**：A3 hook exit 0（既有）、A1 server 坏输入（既有测试保留）、C3 离线兜底、D1 拉起失败不狂拉（探活一次）。✅
- **§7 测试策略**：A 各 Task 的 unittest/bash 测试、B 各 Task 的 node:test、C/D 手动验证步骤。✅
- **§8 待核实项**：D1 顶部显式标注需先向用户确认 DISTRO/路径/解释器。✅

**类型一致性检查**：`buildViewModel` 返回 `{counts,aggregate,rows}`，`rows[i]` 含 `{id,name,status,timerText,stuck,highlight}` —— C3 渲染严格按此字段；`newlyWaiting` 返回 `{freshWaiting,waitingIds}` —— C3 按此解构。后端 `update(session_id,status,cwd,now)` 与 `status=="heartbeat"` 分支在 A1 定义、A3 hook 发送一致。✅
