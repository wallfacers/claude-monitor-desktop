import { buildViewModel, newlyWaiting, statusLabel } from "./render.js";

const POLL_MS = 1000;
const STUCK_SEC = 600; // 10 分钟，后续可从设置读
const STATE_URL = "http://localhost:8787/state";

let prevWaiting = [];
let panelOpen = false;

const $ = (s) => document.querySelector(s);
const panel = $("#panel");
const minibar = $("#minibar");
const segs = $("#segs");
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
  const w = el.offsetLeft + el.offsetWidth + 14;
  const h = el.offsetTop + el.offsetHeight + 14;
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

    div.append(dot, name, stat, timer);
    rowsEl.appendChild(div);
  });
}

// 点击计数区展开；✕ 收起。拖动由 HTML 的 data-tauri-drag-region 处理。
segs.addEventListener("click", () => setExpanded(true));
$("#collapse").addEventListener("click", () => setExpanded(false));

async function tick() {
  try {
    const res = await fetch(STATE_URL, { cache: "no-store" });
    const state = await res.json();
    offlineEl.hidden = true;

    const vm = buildViewModel(state, STUCK_SEC);
    setCounts(vm.counts);
    renderRows(vm.rows);

    const { freshWaiting, waitingIds } = newlyWaiting(prevWaiting, state);
    minibar.classList.toggle("alert", waitingIds.length > 0);
    if (freshWaiting.length > 0) {
      ding.play().catch(() => {}); // 声音（默认开）
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
