import { buildViewModel, newlyWaiting, newlyDone, statusLabel } from "./render.js";

const POLL_MS = 1000;
const STUCK_SEC = 600; // 10 分钟，后续可从设置读
const STATE_URL = "http://localhost:8787/state";
const DONE_FLASH_MS = 6000; // 单个任务完成贡献的闪烁时长
const DONE_FLASH_MAX_MS = 30000; // 累加上限：多个完成时间累加但封顶，避免一直闪

let prevWaiting = [];
let panelOpen = false;
const muted = new Set(); // 被「消音」的待确认 session id（如 Claude 已 Cooked 完成但报成 waiting）
let lastVm = null;
let lastWaitingIds = [];
let prevDone = []; // 上一轮的完成 id（用于检测「新完成」）
let seededDone = false; // 首次轮询只播种、不为已存在的完成补闪
let doneFlashUntil = 0; // 完成闪烁截止时间戳（ms），多个完成累加

const $ = (s) => document.querySelector(s);
const panel = $("#panel");
const minibar = $("#minibar");
const rowsEl = $("#rows");
const offlineEl = $("#offline");
const ding = $("#ding");

// ---- Tauri 窗口：自适应尺寸（无 Tauri 时，如浏览器预览，自动跳过） ----
const TW = window.__TAURI__ && window.__TAURI__.window;

function fitWindow() {
  if (!TW || !TW.getCurrentWindow || !TW.LogicalSize) return;
  const el = panelOpen ? panel : minibar;
  if (!el || el.hidden) return;
  // 用 offset（布局尺寸，不受 transform 缩放影响）——动效进行中也测得准。
  // +16 与 #app padding 一致：四周留白对称，且容得下投影/闪烁环不被窗口直角边裁切。
  const w = el.offsetLeft + el.offsetWidth + 16;
  const h = el.offsetTop + el.offsetHeight + 16;
  TW.getCurrentWindow().setSize(new TW.LogicalSize(w, h)).catch(() => {});
}

// 缩放(收起) ↔ 详细(展开) 切换：只显示一个，出现时播放 scale+fade 进入动效。
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

    const dot = document.createElement("div");
    // r.status 是固定串 running/waiting/done；仍消毒到 [a-z] 防止异常值注入 class。
    dot.className = "dot " + String(r.status).replace(/[^a-z]/g, "");

    const name = document.createElement("div");
    name.className = "rname";
    name.textContent = r.name ?? ""; // textContent — 无 XSS

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

    rowsEl.appendChild(div);
  });
}

// ⌄ 展开详情；✕ 收起。整条药丸/标题栏的拖动由 HTML data-tauri-drag-region 处理。
$("#expand").addEventListener("click", () => setExpanded(true));
$("#collapse").addEventListener("click", () => setExpanded(false));

async function tick() {
  try {
    const res = await fetch(STATE_URL, { cache: "no-store" });
    const state = await res.json();
    offlineEl.hidden = true;

    const vm = buildViewModel(state, STUCK_SEC);
    render(vm);

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
      ding.play().catch(() => {});
    }
    prevDone = doneIds;

    refreshAlert();

    const freshActive = freshWaiting.filter((id) => !muted.has(id));
    if (freshActive.length > 0) {
      ding.play().catch(() => {}); // 声音（默认开），已消音的不响
      setExpanded(true); // 有新待确认 -> 自动展开
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

setInterval(tick, POLL_MS);
tick();
