# 猫咪宠物形态(Cat Pet Mode)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有「药丸/列表」之外新增第三形态「猫咪」——一只 SVG 矢量卡通猫,用情绪/动作反映 Claude Code 监控状态,托盘可切换,不丢任何现有功能。

**Architecture:** 延续现有「纯函数渲染 + node:test 单测」风格(`render.js`/`render.test.js`)。新增纯函数 `cat.js`(状态→pose 映射,可单测)+ `#cat` 容器(内联 SVG + 角标 + 气泡)+ CSS 动画。`app.js` 把布尔 `setExpanded` 升级为三态 `setMode('pill'|'list'|'cat')`,猫的渲染复用已有 `lastVm`/`muted`/`STUCK_SEC`,不碰轮询/音频/消音/移除/钩子。Rust 侧托盘加「外观」单选子菜单 + 配置文件持久化 + `get_appearance` 命令。

**Tech Stack:** Tauri v2、原生 ESM、纯 CSS/SVG、`node --test`。**零新依赖。**

## Global Constraints

- **不丢任何现有功能**:三状态计数、待确认闪烁+响铃(`chimeWaiting`)+自动展开、消音🔔、移除记录✕、卡住检测(`STUCK_SEC=600`)、离线标、完成蓝闪(`chimeDone`/`doneFlashUntil`)、鼠标穿透降透明度、钩子 toast —— 全部原样复用。
- **零新依赖**:不引入任何 npm 包或 Rust crate;猫为纯内联 SVG + CSS。
- **透明窗约束**:投影/动画扩散半径 ≤ `#app` 的 16px padding,否则被窗口直角边裁切。
- **状态语义色不变**:角标仍用绿(`--running`)/黄(`--waiting`)/蓝(`--done`);少女心配色用独立的 `--cat-*` 变量。
- **测试命令**:`npm test`(= `node --test src/*.test.js`),新建的 `src/cat.test.js` 自动被收录。
- **形态三选一互斥**:`pill` / `list` / `cat`,沿用 `[hidden]{display:none!important}` 约定。
- **持久化键值**:外观存配置文件,合法值仅 `"pill"|"list"|"cat"`,缺省 `"pill"`。

---

### Task 1: `cat.js` 纯函数 + 单测(状态→pose 映射)

**Files:**
- Create: `src/cat.js`
- Test: `src/cat.test.js`

**Interfaces:**
- Consumes: `buildViewModel` 的返回值 `vm`(形如 `{ counts:{running,waiting,done}, aggregate, rows:[{id,name,status,timerText,stuck,idleSec,highlight}] }`),来自 `src/render.js`。
- Produces:
  - `buildCatVM(vm, opts = {}) -> { pose, badgeText, badgeColor, bubble, sleeping, counts }`
    - `opts.waitingActive?: number` —— 非消音的待确认数;省略时回退为 `vm.counts.waiting`。
    - `pose`: `"waiting"|"stuck"|"running"|"done"|"idle"`(优先级 waiting > stuck > running > done > idle)。
    - `badgeText`: 角标文本(`""` 表示不显示);`badgeColor`: `"waiting"|"running"|"done"|null`。
    - `bubble`: 头顶气泡符号 `"!"|"?"|""`。
    - `sleeping`: boolean(仅 idle 为 true,用于戴睡帽)。
    - `counts`: 透传 `vm.counts`(供 hover 三色计数)。

- [ ] **Step 1: Write the failing test**

创建 `src/cat.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatVM } from "./cat.js";

// 构造最小 vm:只给 counts 与 rows(含 stuck)
const vm = (counts, rows = []) => ({ counts, aggregate: "idle", rows });
const row = (status, stuck = false) => ({ id: status, name: status, status, stuck });

test("waiting 最高优先:有待确认 -> waiting pose + 黄角标 + ! 气泡", () => {
  const r = buildCatVM(vm({ running: 2, waiting: 1, done: 3 }, [row("running"), row("waiting")]));
  assert.equal(r.pose, "waiting");
  assert.equal(r.badgeText, "1");
  assert.equal(r.badgeColor, "waiting");
  assert.equal(r.bubble, "!");
  assert.equal(r.sleeping, false);
});

test("waitingActive=0(全消音)时跳过 waiting,落到 running", () => {
  const r = buildCatVM(vm({ running: 2, waiting: 1, done: 0 }, [row("running"), row("waiting")]), { waitingActive: 0 });
  assert.equal(r.pose, "running");
  assert.equal(r.badgeText, "2");
  assert.equal(r.badgeColor, "running");
});

test("stuck 优先于 running:running 行 stuck -> stuck pose + ? 气泡", () => {
  const r = buildCatVM(vm({ running: 1, waiting: 0, done: 0 }, [row("running", true)]));
  assert.equal(r.pose, "stuck");
  assert.equal(r.badgeText, "?");
  assert.equal(r.badgeColor, "waiting");
  assert.equal(r.bubble, "?");
});

test("running:无待确认无卡住 -> running pose + 绿角标", () => {
  const r = buildCatVM(vm({ running: 3, waiting: 0, done: 1 }, [row("running")]));
  assert.equal(r.pose, "running");
  assert.equal(r.badgeText, "3");
  assert.equal(r.badgeColor, "running");
  assert.equal(r.bubble, "");
});

test("done:仅完成 -> done pose + ✓ 前缀蓝角标", () => {
  const r = buildCatVM(vm({ running: 0, waiting: 0, done: 4 }, [row("done")]));
  assert.equal(r.pose, "done");
  assert.equal(r.badgeText, "✓4");
  assert.equal(r.badgeColor, "done");
});

test("idle:全 0 -> idle pose、无角标、sleeping=true(戴睡帽)", () => {
  const r = buildCatVM(vm({ running: 0, waiting: 0, done: 0 }, []));
  assert.equal(r.pose, "idle");
  assert.equal(r.badgeText, "");
  assert.equal(r.badgeColor, null);
  assert.equal(r.sleeping, true);
});

test("counts 透传给 hover 计数", () => {
  const c = { running: 1, waiting: 2, done: 3 };
  assert.deepEqual(buildCatVM(vm(c, [row("waiting")])).counts, c);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL,报错类似 `Cannot find module './cat.js'` 或 `buildCatVM is not a function`。

- [ ] **Step 3: Write minimal implementation**

创建 `src/cat.js`:

```js
// 纯函数:把视图模型(buildViewModel 的结果)映射成「猫的表演」。
// 无 DOM、无副作用,便于单测;延续 render.js 的风格。
// 优先级:待确认 > 卡住 > 运行 > 完成 > 空闲(同一刻只演最高优先级那个)。
export function buildCatVM(vm, opts = {}) {
  const counts = (vm && vm.counts) || { running: 0, waiting: 0, done: 0 };
  const rows = (vm && Array.isArray(vm.rows)) ? vm.rows : [];
  const waitingActive =
    opts.waitingActive === undefined ? (counts.waiting || 0) : opts.waitingActive;
  const anyStuck = rows.some((r) => r.stuck);

  let pose, badgeText, badgeColor, bubble;
  if (waitingActive > 0) {
    pose = "waiting"; badgeText = String(waitingActive); badgeColor = "waiting"; bubble = "!";
  } else if (anyStuck) {
    pose = "stuck"; badgeText = "?"; badgeColor = "waiting"; bubble = "?";
  } else if ((counts.running || 0) > 0) {
    pose = "running"; badgeText = String(counts.running); badgeColor = "running"; bubble = "";
  } else if ((counts.done || 0) > 0) {
    pose = "done"; badgeText = "✓" + counts.done; badgeColor = "done"; bubble = "";
  } else {
    pose = "idle"; badgeText = ""; badgeColor = null; bubble = "";
  }

  return { pose, badgeText, badgeColor, bubble, sleeping: pose === "idle", counts };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS(原有 render 测试 + 7 个新 cat 测试全绿)。

- [ ] **Step 5: Commit**

```bash
git add src/cat.js src/cat.test.js
git commit -m "feat(cat): 状态->pose 纯函数 buildCatVM + 单测"
```

---

### Task 2: `#cat` 容器(内联 SVG + 角标 + 气泡)+ CSS 样式与动画

**Files:**
- Modify: `src/index.html`(在 `#panel` 之后、`#app` 内新增 `#cat`)
- Modify: `src/styles.css`(末尾追加 `.cat` 区块)

**Interfaces:**
- Produces: DOM 结构与 CSS 类约定,供 Task 3 的 `renderCat` 操控:
  - 容器 `#cat.cat`,pose 由 `cat--waiting|cat--stuck|cat--running|cat--done|cat--idle` 类驱动。
  - 角标 `.cat-badge`(配色类 `cat-badge--waiting|--running|--done`)。
  - 气泡 `.cat-bubble`(文本 `!`/`?`)。
  - hover 三色计数 `.cat-counts`,内含 `[data-cc="running"|"waiting"|"done"]` 三个 span。

本任务无自动化测试(代码库无 DOM 测试依赖,刻意保持零依赖);用浏览器预览做人工验收。

- [ ] **Step 1: 在 `src/index.html` 的 `#panel` 闭合 `</div>`(第 36 行那个)之后、`#app` 的 `</div>`(第 37 行)之前,插入 `#cat` 容器**

```html
    <!-- 猫咪形态:整只可拖动(data-tauri-drag-region);单击展开列表(JS 绑定) -->
    <div id="cat" class="cat" data-tauri-drag-region title="按住拖动 · 单击展开" hidden>
      <svg class="cat-svg" viewBox="0 0 100 110" width="76" height="84" data-tauri-drag-region>
        <!-- 尾巴(摆动) -->
        <path class="cat-tail" d="M70 86 q24 2 22 -22 q-2 -10 -8 -12"
              fill="none" stroke="var(--cat-base)" stroke-width="9" stroke-linecap="round"/>
        <!-- 身体 -->
        <ellipse class="cat-body" cx="50" cy="86" rx="22" ry="18" fill="var(--cat-base)"/>
        <!-- 举起的爪子(waiting 时挥手) -->
        <ellipse class="cat-paw" cx="30" cy="74" rx="7" ry="9" fill="var(--cat-base)"/>
        <!-- 头(含耳/眼/腮红/睡帽) -->
        <g class="cat-head">
          <!-- 耳朵 -->
          <polygon class="cat-ear" points="30,30 26,8 48,24" fill="var(--cat-base)"/>
          <polygon class="cat-ear" points="70,30 74,8 52,24" fill="var(--cat-base)"/>
          <polygon points="32,27 30,15 42,24" fill="var(--cat-blush)"/>
          <polygon points="68,27 70,15 58,24" fill="var(--cat-blush)"/>
          <!-- 脸 -->
          <circle cx="50" cy="46" r="27" fill="var(--cat-base)"/>
          <!-- 腮红 -->
          <ellipse class="cat-blush-l" cx="34" cy="54" rx="6" ry="4" fill="var(--cat-blush)" opacity=".75"/>
          <ellipse class="cat-blush-r" cx="66" cy="54" rx="6" ry="4" fill="var(--cat-blush)" opacity=".75"/>
          <!-- 眼睛(眨眼/眯眼靠 transform: scaleY) -->
          <ellipse class="cat-eye cat-eye-l" cx="40" cy="46" rx="3.2" ry="5.2" fill="#3a3340"/>
          <ellipse class="cat-eye cat-eye-r" cx="60" cy="46" rx="3.2" ry="5.2" fill="#3a3340"/>
          <!-- 鼻 + 嘴 -->
          <path d="M47 55 h6 l-3 3 z" fill="#d98aa6"/>
          <path d="M44 58 q6 6 12 0" fill="none" stroke="#3a3340" stroke-width="1.6" stroke-linecap="round"/>
          <!-- 蝴蝶结(常驻,右耳旁) -->
          <g class="cat-bow">
            <path d="M64 22 l8 -5 v10 z" fill="var(--cat-bow)"/>
            <path d="M64 22 l8 5 v-10 z" fill="var(--cat-bow)"/>
            <circle cx="64" cy="22" r="2.5" fill="#fff" opacity=".9"/>
          </g>
          <!-- 睡帽(仅 idle 显示,默认 hidden) -->
          <g class="cat-hat">
            <path d="M24 18 q26 -22 52 0 z" fill="var(--cat-hat)"/>
            <path d="M76 18 q14 -2 12 12 q-8 2 -12 -4 z" fill="var(--cat-hat)"/>
            <circle cx="88" cy="30" r="4" fill="#fff"/>
          </g>
        </g>
        <!-- 完成时的星星(默认隐形,done pose 闪一下) -->
        <g class="cat-sparkle">
          <path d="M20 24 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2 z" fill="var(--cat-star)"/>
          <path d="M82 60 l1.5 3.5 3.5 1.5 -3.5 1.5 -1.5 3.5 -1.5 -3.5 -3.5 -1.5 3.5 -1.5 z" fill="var(--cat-star)"/>
        </g>
      </svg>
      <!-- 头顶气泡(! / ?) -->
      <div class="cat-bubble" hidden></div>
      <!-- 角标数字 -->
      <div class="cat-badge" hidden></div>
      <!-- hover 展开的三色完整计数 -->
      <div class="cat-counts">
        <span class="cc cc-running"><i></i><b data-cc="running">0</b></span>
        <span class="cc cc-waiting"><i></i><b data-cc="waiting">0</b></span>
        <span class="cc cc-done"><i></i><b data-cc="done">0</b></span>
      </div>
    </div>
```

- [ ] **Step 2: 在 `src/styles.css` 第 1 行的 `:root{...}` 末尾追加少女心猫变量**

把第 1 行改为(在 `}` 前补 `--cat-*`):

```css
:root{ --running:#3ddc84; --waiting:#ffc83d; --done:#4aa8ff; --txt:#e6e9ef; --dim:#9aa3b2;
  --cat-base:#ffd6e7; --cat-blush:#ff9ec4; --cat-bow:#ff7fb0; --cat-hat:#b9a7ff; --cat-star:#fff2a8; }
```

- [ ] **Step 3: 在 `src/styles.css` 末尾追加 `.cat` 区块**

```css
/* ===== 猫咪形态 ===== */
/* 容器:与 minibar/panel 并列,[hidden] 互斥。整只可拖;内部装饰不吃鼠标,事件落到拖动区。
   单击展开由 app.js 在 #cat 上监听 click。投影/动画位移 ≤ #app 16px padding 防裁切。 */
.cat{position:relative;display:inline-block;cursor:grab;filter:drop-shadow(0 3px 6px rgba(0,0,0,.4))}
.cat:active{cursor:grabbing}
.cat > *{pointer-events:none}
.cat-svg{display:block;overflow:visible}
/* 各部件的 transform 锚点 */
.cat-tail{transform-box:fill-box;transform-origin:left center}
.cat-paw{transform-box:fill-box;transform-origin:center bottom;opacity:0}
.cat-head{transform-box:fill-box;transform-origin:50% 70%}
.cat-eye{transform-box:fill-box;transform-origin:center}
.cat-bow{transform-box:fill-box;transform-origin:64px 22px}
.cat-hat,.cat-sparkle{opacity:0}

/* 眨眼:全程随机眨(idle 态被眯眼覆盖) */
.cat-eye{animation:catBlink 4.5s infinite}
@keyframes catBlink{0%,92%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}

/* —— 各 pose 动画 —— */
/* 运行:埋头微微点头 + 尾巴欢快摆动 */
.cat--running .cat-head{animation:catBob 1.6s ease-in-out infinite}
.cat--running .cat-tail{animation:catWag .6s ease-in-out infinite}
@keyframes catBob{0%,100%{transform:translateY(0)}50%{transform:translateY(2px)}}
@keyframes catWag{0%,100%{transform:rotate(0)}50%{transform:rotate(-16deg)}}

/* 待确认:身体催促抖动 + 举爪挥手 + 慢摆尾 */
.cat--waiting{animation:catShake .5s ease-in-out infinite}
.cat--waiting .cat-paw{opacity:1;animation:catWave .5s ease-in-out infinite}
.cat--waiting .cat-tail{animation:catWag 1s ease-in-out infinite}
@keyframes catShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-2px)}75%{transform:translateX(2px)}}
@keyframes catWave{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(20deg)}}

/* 卡住:歪头发懵,慢 */
.cat--stuck .cat-head{animation:catTilt 2.4s ease-in-out infinite}
@keyframes catTilt{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(-9deg)}}

/* 完成:满足弹跳 + 星星闪 */
.cat--done{animation:catHop 1.2s ease-in-out infinite}
.cat--done .cat-sparkle{animation:catTwinkle 1.2s ease-in-out infinite}
@keyframes catHop{0%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}60%{transform:translateY(0)}}
@keyframes catTwinkle{0%,100%{opacity:0;transform:scale(.6)}50%{opacity:1;transform:scale(1)}}

/* 空闲:呼吸起伏 + 眯眼 + 戴睡帽 */
.cat--idle{animation:catBreathe 3.4s ease-in-out infinite;transform-origin:bottom center}
.cat--idle .cat-eye{animation:none;transform:scaleY(.18)}
.cat--idle .cat-hat{opacity:1}
@keyframes catBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}

/* 头顶气泡 ! / ? */
.cat-bubble{position:absolute;top:-2px;right:6px;min-width:18px;height:18px;padding:0 4px;
  display:flex;align-items:center;justify-content:center;border-radius:9px;font-size:13px;font-weight:800;
  color:#fff;background:var(--waiting);box-shadow:0 1px 3px rgba(0,0,0,.4)}

/* 角标(右下角数字),配色随状态 */
.cat-badge{position:absolute;right:2px;bottom:8px;min-width:18px;height:18px;padding:0 5px;
  display:flex;align-items:center;justify-content:center;border-radius:9px;font-size:11px;font-weight:800;
  color:#10141c;box-shadow:0 1px 3px rgba(0,0,0,.4)}
.cat-badge--running{background:var(--running)}
.cat-badge--waiting{background:var(--waiting)}
.cat-badge--done{background:var(--done)}

/* hover 才显示的三色完整计数(角标只显当前态,这里补全信息,不丢数据) */
.cat-counts{position:absolute;left:50%;bottom:-6px;transform:translate(-50%,4px);display:flex;gap:6px;
  padding:3px 7px;border-radius:999px;background:rgba(20,23,30,.82);border:1px solid rgba(255,255,255,.14);
  opacity:0;pointer-events:none;transition:opacity .14s;white-space:nowrap}
.cat:hover .cat-counts{opacity:1}
.cat-counts .cc{display:flex;align-items:center;gap:3px;font-size:11px;font-weight:800;color:var(--txt)}
.cat-counts .cc i{width:7px;height:7px;border-radius:50%}
.cat-counts .cc-running i{background:var(--running)}
.cat-counts .cc-waiting i{background:var(--waiting)}
.cat-counts .cc-done i{background:var(--done)}
```

- [ ] **Step 4: 人工验收(浏览器预览,无 Tauri 也能看)**

Run: `python3 -m http.server -d src 5599`(或任意静态服务器),浏览器开 `http://localhost:5599/`。
临时验证:打开浏览器 DevTools 控制台执行
```js
const c = document.querySelector('#cat'); c.hidden = false;
document.querySelector('#minibar').hidden = true;
['waiting','stuck','running','done','idle'].forEach((p,i)=>setTimeout(()=>{c.className='cat cat--'+p;console.log(p)},i*2000));
```
Expected:看到一只粉色猫,依次切换:抖动举爪(waiting)→歪头(stuck)→点头摆尾(running)→弹跳星星(done)→呼吸戴睡帽眯眼(idle);全程会眨眼;hover 时底部出现三色计数胶囊;投影不被窗口边裁切。
(看完把临时改动撤销/刷新即可,无需保留。)

- [ ] **Step 5: Commit**

```bash
git add src/index.html src/styles.css
git commit -m "feat(cat): #cat 容器(内联 SVG)+ 少女心配色与 pose 动画"
```

---

### Task 3: `app.js` 接入——`setMode` 三态化 + 猫渲染 + 交互

**Files:**
- Modify: `src/app.js`

**Interfaces:**
- Consumes: `buildCatVM`(Task 1);`#cat`/`.cat-badge`/`.cat-bubble`/`.cat-counts`/`[data-cc]`(Task 2)。
- Produces:
  - `setMode(mode)`,`mode ∈ "pill"|"list"|"cat"` —— 取代旧 `setExpanded(bool)`。
  - 模块级变量 `currentMode`(当前显示)、`appearance`(用户选定的基础态,Task 4 由托盘/启动设置)。
  - `renderCat(vm)` —— 把 `buildCatVM` 结果写进 `#cat` 的类/角标/气泡/计数。
  - `window.__setAppearance(mode)` —— 供 Task 4 的托盘事件调用,设置基础态并切换显示。

本任务为 DOM/集成接线,沿用代码库惯例(无 DOM 单测);验收靠 `npm test` 保证纯函数不回归 + 人工运行 app。

- [ ] **Step 1: 顶部 import 增加 `buildCatVM`**

把第 1 行:
```js
import { buildViewModel, newlyWaiting, newlyDone, statusLabel } from "./render.js";
```
改为追加一行:
```js
import { buildViewModel, newlyWaiting, newlyDone, statusLabel } from "./render.js";
import { buildCatVM } from "./cat.js";
```

- [ ] **Step 2: 用三态模式变量替换 `panelOpen`,并新增元素引用**

把第 11 行 `let panelOpen = false;` 替换为:
```js
let currentMode = "pill"; // 当前显示形态:pill|list|cat
let appearance = "pill";  // 用户选定的基础态(pill|cat;list 也可作常驻),Task 4 持久化恢复
```

把第 29-33 行的元素引用块:
```js
const $ = (s) => document.querySelector(s);
const panel = $("#panel");
const minibar = $("#minibar");
const rowsEl = $("#rows");
const offlineEl = $("#offline");
```
替换为(补上 cat 相关引用):
```js
const $ = (s) => document.querySelector(s);
const panel = $("#panel");
const minibar = $("#minibar");
const catEl = $("#cat");
const catBadge = $(".cat-badge");
const catBubble = $(".cat-bubble");
const rowsEl = $("#rows");
const offlineEl = $("#offline");
const MODE_EL = { pill: minibar, list: panel, cat: catEl };
const POSE_CLASSES = ["cat--waiting", "cat--stuck", "cat--running", "cat--done", "cat--idle"];
```

- [ ] **Step 3: `fitWindow` 改用 `currentMode`**

把第 78 行:
```js
  const el = panelOpen ? panel : minibar;
```
替换为:
```js
  const el = MODE_EL[currentMode] || minibar;
```
把第 83 行:
```js
  if (panelOpen) {
```
替换为:
```js
  if (currentMode === "list") {
```

- [ ] **Step 4: 用 `setMode` 替换 `setExpanded`,并新增 `renderCat`**

把第 100-114 行整个 `setExpanded` 函数:
```js
// 缩放(收起) ↔ 详细(展开) 切换:只显示一个,出现时播放 scale+fade 进入动效。
function setExpanded(open) {
  if (open === panelOpen) return;
  panelOpen = open;
  const show = open ? panel : minibar;
  const hide = open ? minibar : panel;

  hide.hidden = true;
  show.hidden = false;
  show.classList.add("mode-enter"); // 起始 opacity0 + scale(.9)
  requestAnimationFrame(() => {
    fitWindow(); // 先按目标尺寸贴合窗口
    requestAnimationFrame(() => show.classList.remove("mode-enter")); // 再过渡到 1
  });
}
```
替换为:
```js
// 三态切换 pill|list|cat:只显示一个,出现时播放 scale+fade 进入动效。
function setMode(mode) {
  if (mode === currentMode || !MODE_EL[mode]) return;
  currentMode = mode;
  const show = MODE_EL[mode];
  for (const [k, el] of Object.entries(MODE_EL)) el.hidden = k !== mode;
  show.classList.add("mode-enter"); // 起始 opacity0 + scale(.9)
  if (mode === "cat" && lastVm) renderCat(lastVm); // 切到猫立即渲染当前状态
  requestAnimationFrame(() => {
    fitWindow(); // 先按目标尺寸贴合窗口
    requestAnimationFrame(() => show.classList.remove("mode-enter")); // 再过渡到 1
  });
}

// 收起目标 = 用户的基础态(appearance)。list 自身为基础态时即留在 list。
function collapseToBase() {
  setMode(appearance);
}

// 把猫的「表演」写进 DOM:pose 类、角标、头顶气泡、hover 三色计数。
function renderCat(vm) {
  const waitingActive = lastWaitingIds.filter((id) => !muted.has(id)).length;
  const c = buildCatVM(vm, { waitingActive });
  catEl.classList.remove(...POSE_CLASSES);
  catEl.classList.add("cat--" + c.pose);
  // 角标
  if (c.badgeText) {
    catBadge.hidden = false;
    catBadge.textContent = c.badgeText;
    catBadge.className = "cat-badge cat-badge--" + c.badgeColor;
  } else {
    catBadge.hidden = true;
  }
  // 头顶气泡
  if (c.bubble) {
    catBubble.hidden = false;
    catBubble.textContent = c.bubble;
  } else {
    catBubble.hidden = true;
  }
  // hover 三色计数(信息不丢)
  catEl.querySelectorAll("[data-cc]").forEach((b) => {
    b.textContent = c.counts[b.getAttribute("data-cc")] ?? 0;
  });
}

// 供 Task 4 托盘/启动调用:设置基础态并立即切换显示。
window.__setAppearance = (mode) => {
  if (!MODE_EL[mode]) return;
  appearance = mode;
  setMode(mode);
};
```

- [ ] **Step 5: 接线交互——展开/收起/猫单击改走 `setMode`**

把第 212-214 行:
```js
// ⌄ 展开详情;✕ 收起。整条药丸/标题栏的拖动由 HTML data-tauri-drag-region 处理。
$("#expand").addEventListener("click", () => setExpanded(true));
$("#collapse").addEventListener("click", () => setExpanded(false));
```
替换为:
```js
// ▾ 展开详情;✕ 收起到基础态。整条药丸/标题栏/猫的拖动由 data-tauri-drag-region 处理。
$("#expand").addEventListener("click", () => setMode("list"));
$("#collapse").addEventListener("click", () => collapseToBase());
// 单击猫 -> 展开列表(拖动由 data-tauri-drag-region 处理;拖动时浏览器不触发 click)。
catEl.addEventListener("click", () => setMode("list"));
```

- [ ] **Step 6: tick 内的自动展开 + 每轮渲染猫**

把第 222-223 行:
```js
    const vm = buildViewModel(state, STUCK_SEC);
    render(vm);
```
替换为(渲染后,若正处于猫态则刷新猫):
```js
    const vm = buildViewModel(state, STUCK_SEC);
    render(vm);
    if (currentMode === "cat") renderCat(vm);
```

把第 250 行(新待确认自动展开):
```js
      setExpanded(true); // 有新待确认 -> 自动展开
```
替换为:
```js
      setMode("list"); // 有新待确认 -> 自动展开列表
```

- [ ] **Step 7: 跑测试确认纯函数无回归**

Run: `npm test`
Expected: PASS(render + cat 全部测试通过;本任务只改 DOM 接线,不影响纯函数)。

- [ ] **Step 8: 人工运行 app 验收**

Run: `npm run tauri dev`
Expected(临时:启动默认仍是 pill,因 Task 4 才接持久化;先用控制台验证)——在 webview DevTools 执行 `window.__setAppearance('cat')`:窗口变成猫并自适应尺寸;随监控状态变化猫切换姿态/角标/气泡;单击猫展开为完整列表(消音🔔/移除✕/计时全部可用);列表里点 ✕ 收回到猫;制造一个待确认 → 仍响铃(`chimeWaiting`)且自动跳到列表。执行 `window.__setAppearance('pill')` 回到药丸,一切如旧。

- [ ] **Step 9: Commit**

```bash
git add src/app.js
git commit -m "feat(cat): app.js 接入 setMode 三态 + renderCat + 猫单击展开"
```

---

### Task 4: Rust 托盘「外观」子菜单 + 持久化 + 启动恢复

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/app.js`(启动读取 + 监听 `set-mode` 事件)

**Interfaces:**
- Consumes: `window.__setAppearance(mode)`(Task 3);前端 `setMode`/`appearance`。
- Produces:
  - Rust 命令 `get_appearance() -> String`(返回 `"pill"|"list"|"cat"`,缺省 `"pill"`)。
  - Rust 托盘事件 `set-mode`(payload 为 `"pill"|"list"|"cat"`),用户点子菜单时发出。
  - 配置文件 `<app_config_dir>/appearance` 持久化选择。

本任务为原生集成,验收靠人工运行(切换 → 重启 → 恢复)。

- [ ] **Step 1: lib.rs 顶部补依赖与持久化辅助函数**

把第 11-13 行:
```rust
use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;
```
替换为(加 `fs`/`PathBuf`):
```rust
use std::fs;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
```

把第 15-19 行的 `use tauri::{...}`:
```rust
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
```
替换为(加 `SubmenuBuilder`):
```rust
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
```

在第 21 行 `const MONITOR_PORT: u16 = 8787;` 之后,新增持久化函数与命令:
```rust

/// 外观持久化文件路径:<app_config_dir>/appearance。
fn appearance_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("appearance"))
}

/// 读取已保存的外观;非法/缺失一律回退 "pill"。
fn read_appearance(app: &tauri::AppHandle) -> String {
    appearance_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| matches!(s.as_str(), "pill" | "list" | "cat"))
        .unwrap_or_else(|| "pill".to_string())
}

/// 写入外观(尽力而为,失败不致命)。
fn write_appearance(app: &tauri::AppHandle, mode: &str) {
    if let Some(p) = appearance_path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(p, mode);
    }
}

/// 前端启动时拉取当前外观,据此设置初始形态。
#[tauri::command]
fn get_appearance(app: tauri::AppHandle) -> String {
    read_appearance(&app)
}
```

- [ ] **Step 2: 注册 `get_appearance` 命令**

把第 70-71 行:
```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
```
替换为(在 Builder 链上加 invoke_handler):
```rust
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_appearance])
        .plugin(tauri_plugin_window_state::Builder::default().build())
```

- [ ] **Step 3: 托盘菜单加「外观」单选子菜单**

把第 99-110 行(现有菜单构建):
```rust
            // 托盘菜单:穿透 / 置顶 / 退出。
            let passthrough = CheckMenuItemBuilder::with_id("passthrough", "鼠标穿透")
                .checked(false)
                .build(app)?;
            let ontop = CheckMenuItemBuilder::with_id("ontop", "始终置顶")
                .checked(true)
                .build(app)?;
            let rehook = MenuItemBuilder::with_id("rehook", "重配 Claude 钩子").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&passthrough, &ontop, &rehook, &quit])
                .build()?;
```
替换为(新增三个外观单选项 + 子菜单;初始勾选读自持久化):
```rust
            // 托盘菜单:外观(单选) / 穿透 / 置顶 / 退出。
            let cur = read_appearance(app.handle());
            let m_pill = CheckMenuItemBuilder::with_id("mode-pill", "药丸")
                .checked(cur == "pill")
                .build(app)?;
            let m_list = CheckMenuItemBuilder::with_id("mode-list", "列表")
                .checked(cur == "list")
                .build(app)?;
            let m_cat = CheckMenuItemBuilder::with_id("mode-cat", "猫咪")
                .checked(cur == "cat")
                .build(app)?;
            let appearance_menu = SubmenuBuilder::new(app, "外观")
                .items(&[&m_pill, &m_list, &m_cat])
                .build()?;

            let passthrough = CheckMenuItemBuilder::with_id("passthrough", "鼠标穿透")
                .checked(false)
                .build(app)?;
            let ontop = CheckMenuItemBuilder::with_id("ontop", "始终置顶")
                .checked(true)
                .build(app)?;
            let rehook = MenuItemBuilder::with_id("rehook", "重配 Claude 钩子").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&appearance_menu, &passthrough, &ontop, &rehook, &quit])
                .build()?;
```

- [ ] **Step 4: 处理外观点击事件(切勾 + 持久化 + emit set-mode)**

把第 117-136 行 `.on_menu_event(...)` 整段:
```rust
                .on_menu_event(move |app_handle, event| match event.id().as_ref() {
                    "passthrough" => {
                        // CheckMenuItem 点击后状态已翻转,读取最新值。
                        let on = passthrough.is_checked().unwrap_or(false);
                        let _ = win_for_menu.set_ignore_cursor_events(on);
                        // 通知前端:穿透时降低不透明度作视觉提示。
                        let _ = win_for_menu.emit("passthrough", on);
                    }
                    "ontop" => {
                        let on = ontop.is_checked().unwrap_or(true);
                        let _ = win_for_menu.set_always_on_top(on);
                    }
                    "rehook" => {
                        // 手动重试落脚本 + 合并 settings.json,并通知前端 toast 反馈。
                        let ok = hooks::ensure_hooks(app_handle).is_ok();
                        let _ = win_for_menu.emit("hooks-configured", ok);
                    }
                    "quit" => app_handle.exit(0),
                    _ => {}
                })
```
替换为(新增三个 mode-* 分支;用闭包统一处理单选互斥)：
```rust
                .on_menu_event(move |app_handle, event| {
                    // 外观单选:选中目标项、互斥取消其余、持久化、通知前端切形态。
                    let mut set_mode = |mode: &str| {
                        let _ = m_pill.set_checked(mode == "pill");
                        let _ = m_list.set_checked(mode == "list");
                        let _ = m_cat.set_checked(mode == "cat");
                        write_appearance(app_handle, mode);
                        let _ = win_for_menu.emit("set-mode", mode);
                    };
                    match event.id().as_ref() {
                        "mode-pill" => set_mode("pill"),
                        "mode-list" => set_mode("list"),
                        "mode-cat" => set_mode("cat"),
                        "passthrough" => {
                            // CheckMenuItem 点击后状态已翻转,读取最新值。
                            let on = passthrough.is_checked().unwrap_or(false);
                            let _ = win_for_menu.set_ignore_cursor_events(on);
                            // 通知前端:穿透时降低不透明度作视觉提示。
                            let _ = win_for_menu.emit("passthrough", on);
                        }
                        "ontop" => {
                            let on = ontop.is_checked().unwrap_or(true);
                            let _ = win_for_menu.set_always_on_top(on);
                        }
                        "rehook" => {
                            // 手动重试落脚本 + 合并 settings.json,并通知前端 toast 反馈。
                            let ok = hooks::ensure_hooks(app_handle).is_ok();
                            let _ = win_for_menu.emit("hooks-configured", ok);
                        }
                        "quit" => app_handle.exit(0),
                        _ => {}
                    }
                })
```

- [ ] **Step 5: 前端启动读取外观 + 监听 set-mode**

在 `src/app.js` 末尾(第 290-291 行 `setInterval(tick, POLL_MS); tick();` 之前)插入:
```js
// 外观:启动读持久化值恢复形态;托盘切换时实时响应。无 Tauri(浏览器预览)则保持默认 pill。
(async () => {
  try {
    const init = await window.__TAURI__.core.invoke("get_appearance");
    if (init) window.__setAppearance(init);
  } catch (e) {}
})();
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen("set-mode", (e) => window.__setAppearance(e.payload));
}

```

- [ ] **Step 6: 编译确认 Rust 无误**

Run: `npm run tauri dev`(首次会编译 Rust)
Expected: 编译通过、应用启动;若有 `cargo` 报错按提示修正(常见:导入/类型不匹配)。

- [ ] **Step 7: 人工端到端验收**

操作:托盘右键 → 外观 → 猫咪。
Expected: 窗口立即变猫、子菜单「猫咪」打勾、其余取消;**关闭应用再启动 → 仍是猫咪**(持久化生效)。再切回「药丸」同样即时 + 重启保持。制造一个待确认 → 猫举爪+黄角标+`!`气泡+响铃;单击猫展开列表所有功能正常。

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/lib.rs src/app.js
git commit -m "feat(cat): 托盘外观单选子菜单 + 持久化 + 启动恢复"
```

---

## 自检结果(规划者已核对 spec)

- **spec 覆盖**:第三形态 cat(T2/T3)✓;状态→pose 映射含优先级/卡住/睡帽(T1)✓;角标+hover 三色计数不丢信息(T1 counts / T2 .cat-counts / T3 renderCat)✓;单击展开列表(T3)✓;拖动(T2 data-tauri-drag-region)✓;托盘单选切换+持久化+启动恢复(T4)✓;少女心配色+蝴蝶结+腮红+睡帽(T2)✓;复用响铃/消音/移除/卡住/完成闪/离线/穿透/钩子(T3 仅接线不改逻辑)✓;零依赖纯 SVG/CSS ✓;皮肤主题对象——本次只交付一只默认猫,变量化 `--cat-*` 即为扩展口子,未做切换 UI(YAGNI,符合 spec 范围外)✓。
- **占位符扫描**:无 TODO/TBD;每个改动步骤均给出完整代码与精确行号锚点。
- **类型一致性**:`buildCatVM` 的返回字段(pose/badgeText/badgeColor/bubble/sleeping/counts)在 T1 定义、T3 `renderCat` 全部按名消费;`window.__setAppearance` 在 T3 定义、T4 调用;`get_appearance`/`set-mode` 在 T4 两侧名字一致;pose 类名 `cat--*` 在 T2(CSS)/T3(`POSE_CLASSES`)一致。
