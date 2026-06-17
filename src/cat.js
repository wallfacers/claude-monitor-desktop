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
