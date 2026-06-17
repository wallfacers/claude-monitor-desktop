import { buildViewModel, newlyWaiting, newlyDone, statusLabel } from "./render.js";
import { buildCatVM } from "./cat.js";

const POLL_MS = 1000;
const STUCK_SEC = 600; // 10 分钟，后续可从设置读
const STATE_URL = "http://localhost:8787/state";
const POST_URL = "http://localhost:8787/api/window-status";
const DONE_FLASH_MS = 6000; // 单个任务完成贡献的闪烁时长
const DONE_FLASH_MAX_MS = 30000; // 累加上限：多个完成时间累加但封顶，避免一直闪

let prevWaiting = [];
let currentMode = "pill"; // 当前显示形态:pill|list|cat
let appearance = "pill";  // 用户选定的基础态(pill|cat;list 也可作常驻),Task 4 持久化恢复
const muted = new Set(); // 被「消音」的待确认 session id（如 Claude 已 Cooked 完成但报成 waiting）
let lastVm = null;
let lastWaitingIds = [];
let prevDone = []; // 上一轮的完成 id（用于检测「新完成」）
let seededDone = false; // 首次轮询只播种、不为已存在的完成补闪
let doneFlashUntil = 0; // 收起条完成闪烁截止时间戳（ms），多个完成累加
const doneFlashIds = new Map(); // 每个新完成会话的行闪动截止时间戳（展开详情用）

// 手动操作：上报某会话状态（如把卡在运行中的取消会话标记完成）。失败静默。
function postStatus(id, status) {
  fetch(POST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: id, status }),
  }).catch(() => {});
}

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

// ---- 提示音：用 Web Audio 合成，无需音频文件，且能区分听感 ----
let audioCtx = null;
// 浏览器/WebView 自动播放策略：AudioContext 需用户手势解锁。首个手势后即可发声。
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch (e) {}
}
// 单个音符：正弦波 + 渐入渐出，柔和不刺耳。
function tone(freq, dur, gain, delay = 0) {
  try {
    if (!audioCtx) unlockAudio();
    if (!audioCtx) return;
    const t0 = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch (e) {}
}
// 完成：轻短高音单「叮」。待确认：更明显的下行双音「叮咚」。
const chimeDone = () => tone(1320, 0.11, 0.035);
const chimeWaiting = () => {
  tone(988, 0.14, 0.06); // 高
  tone(740, 0.2, 0.06, 0.13); // → 低，经典「叮咚」
};
// 任意一次窗口交互即解锁音频（拖动/点击）。
window.addEventListener("pointerdown", unlockAudio, { once: false });

// ---- Tauri 窗口：自适应尺寸（无 Tauri 时，如浏览器预览，自动跳过） ----
const TW = window.__TAURI__ && window.__TAURI__.window;

function fitWindow() {
  if (!TW || !TW.getCurrentWindow || !TW.LogicalSize) return;
  const el = MODE_EL[currentMode] || minibar;
  if (!el || el.hidden) return;

  // 展开态：按最长项目名动态加宽面板，避免被省略号截断；上下限保护防超长名字撑爆。
  // 先回基础宽再测（可增可减）：scrollWidth 是全文本宽，clientWidth 是可见宽，差即被截像素。
  if (currentMode === "list") {
    const MIN_W = 280, MAX_W = 360;
    panel.style.width = MIN_W + "px";
    let extra = 0;
    panel.querySelectorAll(".rname").forEach((n) => {
      extra = Math.max(extra, n.scrollWidth - n.clientWidth);
    });
    panel.style.width = Math.max(MIN_W, Math.min(MIN_W + extra, MAX_W)) + "px";
  }

  // 用 offset（布局尺寸，不受 transform 缩放影响）——动效进行中也测得准。
  // +16 与 #app padding 一致：四周留白对称，且容得下投影/闪烁环不被窗口直角边裁切。
  const w = el.offsetLeft + el.offsetWidth + 16;
  const h = el.offsetTop + el.offsetHeight + 16;
  TW.getCurrentWindow().setSize(new TW.LogicalSize(w, h)).catch(() => {});
}

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

// 重新评估收起条闪烁：待确认（黄，持续，需操作）优先；否则完成（蓝，短暂，到点自动停）。
function refreshAlert() {
  const waitingActive = lastWaitingIds.filter((id) => !muted.has(id)).length > 0;
  const doneFlash = Date.now() < doneFlashUntil;
  minibar.classList.toggle("alert", waitingActive);
  minibar.classList.toggle("done-alert", !waitingActive && doneFlash);
}

function render(vm) {
  lastVm = vm;
  setCounts(vm.counts);
  renderRows(vm.rows);
}

function setCounts(counts) {
  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = counts[el.getAttribute("data-count")] ?? 0;
  });
  minibar.querySelectorAll(".seg").forEach((seg) => {
    const span = seg.querySelector("[data-count]");
    const k = span ? span.getAttribute("data-count") : null;
    const n = k ? (counts[k] ?? 0) : 0;
    seg.classList.toggle("zero", n === 0);
  });
}

function renderRows(rows) {
  rowsEl.innerHTML = "";
  rows.forEach((r) => {
    const div = document.createElement("div");
    div.className = "row" + (r.highlight ? " alert" : "");
    // 完成提示：新完成的行在展开详情里也蓝闪（时间到自动停）
    const flashUntil = doneFlashIds.get(r.id);
    if (flashUntil && Date.now() < flashUntil) div.classList.add("done-flash");

    const dot = document.createElement("div");
    // r.status 是固定串 running/waiting/done；仍消毒到 [a-z] 防止异常值注入 class。
    dot.className = "dot " + String(r.status).replace(/[^a-z]/g, "");

    const name = document.createElement("div");
    name.className = "rname";
    name.textContent = r.name ?? ""; // textContent — 无 XSS
    name.title = r.name ?? ""; // 超长被省略号截断时，悬停可看全名

    const stat = document.createElement("div");
    stat.className = "rstat " + String(r.status).replace(/[^a-z]/g, "");
    stat.textContent = statusLabel(r.status);

    const timer = document.createElement("div");
    timer.className = "timer" + (r.stuck ? " warn" : "");
    timer.textContent = r.timerText;
    // 卡住时提示：距 Claude 最近一次 hook 回调多久（区分「跑得久」与「真卡住」）
    timer.title = r.stuck
      ? `已 ${Math.floor((r.idleSec || 0) / 60)} 分钟无 Claude 回调，疑似卡住`
      : "";

    div.append(dot, name, stat, timer);

    // 待确认行：消音按钮（关掉响铃/闪烁，应对 Claude 已完成却报成 waiting 的情况）
    if (r.status === "waiting") {
      const on = muted.has(r.id);
      div.classList.toggle("muted", on);
      const mb = document.createElement("div");
      mb.className = "muteb" + (on ? " on" : "");
      mb.textContent = on ? "🔕" : "🔔";
      mb.title = on ? "已消音，点击恢复提示" : "消音（不再响铃/闪烁）";
      mb.addEventListener("click", (e) => {
        e.stopPropagation();
        if (muted.has(r.id)) muted.delete(r.id);
        else muted.add(r.id);
        if (lastVm) render(lastVm);
        refreshAlert();
      });
      div.append(mb);
    }

    // 运行中/完成行：一键「移除该记录」。应对两种监控收不到信号的情况：
    //  - ESC 取消/打断（Claude Code 打断不发任何 hook）
    //  - 硬关闭终端 / kill-9（不发 SessionEnd）
    // 移除是安全的：真活着的会话下次有 hook 回调会自动重新登记回来。
    if (r.status === "running" || r.status === "done") {
      const cb = document.createElement("div");
      cb.className = "clearb";
      cb.textContent = "✕";
      cb.title = "移除该记录（取消/已退出但仍残留时用；真在跑的会自动回来）";
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        postStatus(r.id, "end");
      });
      div.append(cb);
    }

    rowsEl.appendChild(div);
  });
}

// ▾ 展开详情；✕ 收起到基础态。整条药丸/标题栏/猫的拖动由 data-tauri-drag-region 处理。
$("#expand").addEventListener("click", () => setMode("list"));
$("#collapse").addEventListener("click", () => collapseToBase());
// 单击猫 -> 展开列表(拖动由 data-tauri-drag-region 处理;拖动时浏览器不触发 click)。
catEl.addEventListener("click", () => setMode("list"));

async function tick() {
  try {
    const res = await fetch(STATE_URL, { cache: "no-store" });
    const state = await res.json();
    offlineEl.hidden = true;

    const vm = buildViewModel(state, STUCK_SEC);
    render(vm);
    if (currentMode === "cat") renderCat(vm);

    const { freshWaiting, waitingIds } = newlyWaiting(prevWaiting, state);
    // 不再 waiting 的 session 解除消音：下次再 waiting 会重新提醒。
    for (const id of [...muted]) if (!waitingIds.includes(id)) muted.delete(id);
    lastWaitingIds = waitingIds;

    // 任务完成提示：新完成的会话让收起条短暂闪蓝（到点自动停）。多个完成时间累加，封顶。
    const { freshDone, doneIds } = newlyDone(prevDone, state);
    if (!seededDone) {
      seededDone = true; // 首次轮询：已存在的完成不补闪，避免开窗刷屏
    } else if (freshDone.length > 0) {
      const base = Math.max(Date.now(), doneFlashUntil); // 已在闪则从当前截止点继续累加
      doneFlashUntil = Math.min(
        base + freshDone.length * DONE_FLASH_MS,
        Date.now() + DONE_FLASH_MAX_MS,
      );
      for (const id of freshDone) doneFlashIds.set(id, Date.now() + DONE_FLASH_MS); // 行闪动
      chimeDone(); // 轻短「叮」
    }
    prevDone = doneIds;

    refreshAlert();

    const freshActive = freshWaiting.filter((id) => !muted.has(id));
    if (freshActive.length > 0) {
      chimeWaiting(); // 「叮咚」双音（默认开），已消音的不响
      setMode("list"); // 有新待确认 -> 自动展开列表
    }
    prevWaiting = waitingIds;

    // 内容变化后重新贴合窗口尺寸（计数位数/行数变化都会改变尺寸）。
    requestAnimationFrame(fitWindow);
  } catch (e) {
    offlineEl.hidden = false; // 后端不可达 -> 离线标，保留上次画面
  }
}

// Tauri 事件：鼠标穿透开启时降低不透明度作视觉提示。
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen("passthrough", (e) => {
    document.documentElement.style.opacity = e.payload ? "0.55" : "1";
  });
}

// 托盘「重配 Claude 钩子」结果反馈：短暂浮窗（内联样式，不依赖 CSS 文件）。
function flashHookToast(ok) {
  let t = document.getElementById("hookToast");
  if (!t) {
    t = document.createElement("div");
    t.id = "hookToast";
    t.style.cssText =
      "position:fixed;left:50%;bottom:6px;transform:translateX(-50%);" +
      "padding:3px 8px;border-radius:6px;font-size:12px;z-index:99;" +
      "background:rgba(40,40,40,.9);color:#fff;pointer-events:none;" +
      "opacity:0;transition:opacity .2s";
    document.body.appendChild(t);
  }
  t.textContent = ok ? "✅ Claude 钩子已配置" : "⚠️ 钩子配置失败（见日志）";
  t.style.opacity = "1";
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.style.opacity = "0"), 2000);
}
if (window.__TAURI__?.event?.listen) {
  window.__TAURI__.event.listen("hooks-configured", (e) => flashHookToast(e.payload));
}

setInterval(tick, POLL_MS);
tick();
