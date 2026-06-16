// 纯函数渲染逻辑（无 DOM、无副作用），便于单测。
export function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

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
      idleSec: idle, // 距最近一次 hook 回调的秒数（卡住判据，供 UI 提示）
      highlight: w.status === "waiting",
    };
  });
  return {
    counts,
    aggregate: (state && state.aggregate) || "idle",
    rows,
  };
}

export function newlyWaiting(prevWaitingIds, state) {
  const wins = (state && Array.isArray(state.windows)) ? state.windows : [];
  const waitingIds = wins.filter((w) => w.status === "waiting").map((w) => w.id);
  const prev = new Set(prevWaitingIds);
  const freshWaiting = waitingIds.filter((id) => !prev.has(id));
  return { freshWaiting, waitingIds };
}

// 新「完成」的会话（用于「任务完成」短暂闪烁提示）。逻辑同 newlyWaiting：
// 只挑这次出现、上次没有的 done id；done -> running -> done 会再次算新完成。
export function newlyDone(prevDoneIds, state) {
  const wins = (state && Array.isArray(state.windows)) ? state.windows : [];
  const doneIds = wins.filter((w) => w.status === "done").map((w) => w.id);
  const prev = new Set(prevDoneIds);
  const freshDone = doneIds.filter((id) => !prev.has(id));
  return { freshDone, doneIds };
}

export function statusLabel(status) {
  return { running: "运行中", waiting: "待确认", done: "完成" }[status] || status;
}
