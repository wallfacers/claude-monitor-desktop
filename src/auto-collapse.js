// 纯函数:判定「此刻是否应启动延迟自动收回」。无 DOM、无副作用,便于单测。
// 延续 render.js / cat.js 的风格。四条件全满足才收回(见 spec「② 幂等计时器」):
//   1. 没有活动待确认(waitingActive===0)——警告已解决(确认/消音/cc 处理)
//   2. 当前正显示列表(currentMode==="list")
//   3. 这个列表是「黄色警告自动展开」的,而非用户手动 ▾ 展开(listAutoExpanded===true)
//   4. 用户基础态不是常驻列表(appearance!=="list")——否则收回目标仍是 list,无意义
export function shouldArmCollapse({
  waitingActive,
  currentMode,
  listAutoExpanded,
  appearance,
} = {}) {
  return (
    waitingActive === 0 &&
    currentMode === "list" &&
    listAutoExpanded === true &&
    appearance !== "list"
  );
}
