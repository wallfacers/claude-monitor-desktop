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
    // r.status is one of the fixed strings: running / waiting / done (from server JSON).
    // We still sanitise to [a-z] so a rogue value cannot inject a class with spaces or quotes.
    dot.className = "dot " + String(r.status).replace(/[^a-z]/g, "");

    const name = document.createElement("div");
    name.className = "rname";
    name.textContent = r.name ?? "";           // textContent — safe, no XSS

    const stat = document.createElement("div");
    stat.className = "rstat " + String(r.status).replace(/[^a-z]/g, "");
    stat.textContent = statusLabel(r.status);  // fixed map output — still textContent

    const timer = document.createElement("div");
    timer.className = "timer" + (r.stuck ? " warn" : "");
    timer.textContent = r.timerText;           // formatDuration output: digits / "—"

    div.append(dot, name, stat, timer);
    rowsEl.appendChild(div);
  });
}

function setExpanded(expanded) {
  panel.hidden = !expanded;
  minibar.hidden = expanded;
  app.classList.toggle("collapsed", !expanded);
}

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
      ding.play().catch(() => {});
      setExpanded(true);
    }
    prevWaiting = waitingIds;
  } catch (e) {
    offlineEl.hidden = false;
  }
}

setInterval(tick, POLL_MS);
tick();
