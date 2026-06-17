// 纯函数:把视图模型(buildViewModel 的结果)映射成「猫的表演」。
// 无 DOM、无副作用,便于单测;延续 render.js 的风格。
// pose 决定姿态/动作与头顶气泡;三个状态数字(counts)始终显示在胖猫肚子上,
// 故不再需要单一角标。优先级:待确认 > 卡住 > 运行 > 完成 > 空闲。
export function buildCatVM(vm, opts = {}) {
  const counts = (vm && vm.counts) || { running: 0, waiting: 0, done: 0 };
  const rows = (vm && Array.isArray(vm.rows)) ? vm.rows : [];
  const waitingActive =
    opts.waitingActive === undefined ? (counts.waiting || 0) : opts.waitingActive;
  const anyStuck = rows.some((r) => r.stuck);

  let pose, bubble;
  if (waitingActive > 0) {
    pose = "waiting"; bubble = "!"; // 举爪催你,头顶 !
  } else if (anyStuck) {
    pose = "stuck"; bubble = "?"; // 歪头发懵,头顶 ?
  } else if ((counts.running || 0) > 0) {
    pose = "running"; bubble = ""; // 埋头干活
  } else if ((counts.done || 0) > 0) {
    pose = "done"; bubble = ""; // 满足弹跳
  } else {
    pose = "idle"; bubble = ""; // 打盹(戴睡帽)
  }

  return { pose, bubble, sleeping: pose === "idle", counts };
}
