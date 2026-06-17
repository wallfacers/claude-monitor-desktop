# 黄色警告解决后自动收回(Auto-collapse after resolved)设计

日期:2026-06-17
状态:已批准设计,待写实现计划

## 目标

当前黄色警告(待确认 waiting)会**自动展开列表**(`app.js` 的 `tick()` 内 `freshActive>0 → setMode('list')`)。但警告被解决后——用户消音了、或 Claude Code 那边确认/处理了使状态不再 waiting——列表却**一直停在展开态**,需要用户手动点 ✕ 收起,不够省心。

本功能:警告解决后**延迟 10s 自动收回**到用户的基础态(药丸或猫),让监控窗平时保持紧凑。

**硬约束:不丢/不改任何现有功能。** 待确认响铃+自动展开、消音、移除记录、卡住检测、完成蓝闪、三形态切换 —— 全部原样。只在「自动展开后、警告解决时」加一条延迟收回。

## 现状(改动前)

`app.js` 关键逻辑:
- `appearance`:用户基础态(`pill`/`cat`;`list` 也可作常驻),启动/托盘切换时恢复。
- `currentMode`:当前显示态。
- `setMode(mode)`:三态互斥切换(目标态等于当前态时 early-return)。
- `collapseToBase()`:`setMode(appearance)`——收起到基础态。
- `tick()` 末尾:有新待确认(`freshActive = freshWaiting.filter(id => !muted.has(id)) > 0`)时 `chimeWaiting()` + `setMode('list')`。
- 列表展开有两个来源:① 警告自动展开(tick);② 用户手动点 `#expand`(▾)。

## 新行为

**仅当列表是「因黄色警告自动展开」时**,在警告解决后延迟 10s 自动收回。用户手动展开(▾)的不受影响。

「警告解决」=`waitingActive`(排除已消音的待确认数)从 >0 归零。归零原因有三,都应触发:
1. **Claude Code 那边确认/处理** → 该 session 状态离开 waiting(`waitingIds` 不再含它)。
2. **用户消音** → 该 id 加入 `muted`,`waitingActive` 重新计算归零。
3. (多个警告时)逐个解决直到全部归零。

收回目标:复用 `collapseToBase()` → 回到 `appearance`。若 `appearance` 本身是 `list`(常驻列表),则收回目标仍是 list,等于不变化——此时不应启动无意义计时。

## 设计(方案 A:内联 app.js)

### ① 来源标志:区分自动展开 vs 手动展开

新增模块级 `let listAutoExpanded = false`。

| 触发点 | listAutoExpanded |
|---|---|
| 警告自动展开(`tick` 内 `freshActive>0`) | `true`(在 setMode 前设) |
| 用户手动展开(`#expand` 点击) | `false` |
| `collapseToBase()` 执行后 | `false` |
| `__setAppearance()`(托盘/启动切形态) | `false` |

注:`setMode('list')` 在 `currentMode` 已是 list 时会 early-return,故标志必须在调用前于外部设置,不放进 setMode 内部。

### ② 幂等计时器:检测解决 → 10s 收回

新增 `let autoCollapseTimer = null` + `const AUTO_COLLAPSE_MS = 10000`。

`tick()` 末尾(在现有 `requestAnimationFrame(fitWindow)` 之前)调用 `maybeScheduleAutoCollapse()`:

```js
function maybeScheduleAutoCollapse() {
  const waitingActive = lastWaitingIds.filter((id) => !muted.has(id)).length;
  const shouldArm =
    waitingActive === 0 &&
    currentMode === "list" &&
    listAutoExpanded &&
    appearance !== "list";
  if (shouldArm && autoCollapseTimer === null) {
    autoCollapseTimer = setTimeout(() => {
      autoCollapseTimer = null;
      collapseToBase(); // 内部会重置 listAutoExpanded=false
    }, AUTO_COLLAPSE_MS);
  } else if (!shouldArm && autoCollapseTimer !== null) {
    clearTimeout(autoCollapseTimer);
    autoCollapseTimer = null;
  }
}
```

**幂等性**:`waitingActive` 持续为 0 时,`autoCollapseTimer` 已非 null,不会重复启动,10s 后必收;不依赖「记住上一轮 waitingActive」的下降沿检测,避免漏检。

`waitingActive` 的计算表达式与 `refreshAlert()` 完全一致,保证「视觉上黄闪消失」与「开始计时收回」同步。

### ③ 取消条件(全靠 shouldArm 变 false)

无需额外取消点,以下情形都让 `shouldArm=false` → 清计时器:
- **新警告又来**:`waitingActive>0`。
- **用户手动展开**:`listAutoExpanded=false`。
- **用户手动收起 ✕ / 托盘切形态**:`currentMode` 离开 list。

`collapseToBase()` 内部重置 `listAutoExpanded=false` 并清计时器(防止收回后残留计时再次触发)。

## 改动面

仅 `src/app.js`:
- 新增常量 `AUTO_COLLAPSE_MS`、模块变量 `autoCollapseTimer` / `listAutoExpanded`。
- 新增函数 `maybeScheduleAutoCollapse()`;`tick()` 末尾调用。
- 4 处设/清标志:警告自动展开(设 true)、`#expand` 点击(设 false)、`collapseToBase()`(清计时+设 false)、`__setAppearance()`(设 false)。

**不改动**:后端、`render.js`、`cat.js`、`cat.test.js`、`index.html`、`styles.css`、hooks。

## 测试

- **纯函数单测**:把 `shouldArm` 判定提纯为 `shouldArmCollapse({ waitingActive, currentMode, listAutoExpanded, appearance }) → bool`,新增 `src/auto-collapse.test.js`(或并入现有测试),覆盖:
  - 四条件全满足 → `true`;
  - `waitingActive>0` / `currentMode≠list` / `listAutoExpanded=false` / `appearance=list` 任一不满足 → `false`。
- **手动验证**:
  1. 触发 waiting → 列表自动展开 → 消音或等 cc 处理 → 10s 后自动收回 pill(或 cat)。
  2. 展开后 10s 内又来新警告 → 不收回(保持展开)。
  3. 手动点 ▾ 展开 → 警告解决 → 不自动收回。
  4. `appearance=list` 常驻 → 警告解决不收(本就是 list)。
  5. 收回动效正常(复用 `mode-enter` 过渡,不突兀)。

## 范围外(YAGNI)

- 倒计时 UI(进度条/数字提示)——静默收回,靠现有过渡动画。
- 10s 时长可配置/可关——固定 10s。
- 防抖(状态短暂抖动)——简单立即计时;真实场景 waiting 不会秒级反复。
- 收回时机可配置(如点击窗口外部收起)。
