# 黄色警告解决后自动收回 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 黄色警告(待确认)自动展开的列表,在警告解决(确认/消音/cc 处理)后延迟 10s 自动收回到用户基础态(药丸或猫)。

**Architecture:** 延续项目「纯函数 + 单测」风格——把「是否应启动收回」的判定提纯为 `shouldArmCollapse(state)` 放独立模块 `src/auto-collapse.js`(可单测);计时器、来源标志、4 处设标志等副作用留在 `src/app.js`(项目惯例:app.js 入口不写单测,靠手动验证)。

**Tech Stack:** 原生 ES Modules(无新依赖)、Tauri 2、`node --test`。

**Spec:** `docs/superpowers/specs/2026-06-17-auto-collapse-after-resolved-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/auto-collapse.js` | 纯函数 `shouldArmCollapse(state)`:判定此刻是否应启动延迟收回 | 新建 |
| `src/auto-collapse.test.js` | 上述纯函数的单测 | 新建 |
| `src/app.js` | 接入:常量/标志/计时器 + `clearAutoCollapse` + `maybeScheduleAutoCollapse` + 4 处设标志 + `tick` 调用 | 修改 |

后端 / `render.js` / `cat.js` / `index.html` / `styles.css` / hooks **不动**。

---

## Task 1: `shouldArmCollapse` 纯函数(TDD)

**Files:**
- Create: `src/auto-collapse.js`
- Test: `src/auto-collapse.test.js`

- [ ] **Step 1: 写失败测试**

创建 `src/auto-collapse.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldArmCollapse } from "./auto-collapse.js";

// 满足全部四条件 -> 应启动收回
const armed = () => ({
  waitingActive: 0,
  currentMode: "list",
  listAutoExpanded: true,
  appearance: "pill",
});

test("四条件全满足 -> true", () => {
  assert.equal(shouldArmCollapse(armed()), true);
});

test("基础态为 cat(非 list)同样应收回 -> true", () => {
  assert.equal(shouldArmCollapse({ ...armed(), appearance: "cat" }), true);
});

test("仍有活动待确认(waitingActive>0) -> false", () => {
  assert.equal(shouldArmCollapse({ ...armed(), waitingActive: 1 }), false);
});

test("不在列表态 -> false", () => {
  assert.equal(shouldArmCollapse({ ...armed(), currentMode: "pill" }), false);
  assert.equal(shouldArmCollapse({ ...armed(), currentMode: "cat" }), false);
});

test("列表是用户手动展开(listAutoExpanded=false) -> false", () => {
  assert.equal(shouldArmCollapse({ ...armed(), listAutoExpanded: false }), false);
});

test("基础态是常驻列表(appearance=list) -> false(收回目标仍是 list,无意义)", () => {
  assert.equal(shouldArmCollapse({ ...armed(), appearance: "list" }), false);
});
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `npm test`
Expected: 失败,报 `Cannot find module ... auto-collapse.js`(模块尚未创建)。

- [ ] **Step 3: 写最小实现**

创建 `src/auto-collapse.js`:

```js
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
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `npm test`
Expected: PASS(本文件 6 条全过;既有 `cat.test.js` / `render.test.js` 仍全过)。

- [ ] **Step 5: 提交**

```bash
git add src/auto-collapse.js src/auto-collapse.test.js
git commit -m "feat(auto-collapse): shouldArmCollapse 纯函数 + 单测" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: `app.js` 接入自动收回

**Files:**
- Modify: `src/app.js`(顶部 import 区、模块变量区、`setMode` 与 `collapseToBase` 之间、`collapseToBase`、`__setAppearance`、`#expand` 监听、`tick` 内警告展开处与末尾)

- [ ] **Step 1: 顶部新增 import**

在 `src/app.js` 第 2 行(`import { buildCatVM } from "./cat.js";`)之后新增一行:

```js
import { shouldArmCollapse } from "./auto-collapse.js";
```

- [ ] **Step 2: 新增常量与模块变量**

在模块变量区(第 20 行 `const doneFlashIds = new Map();` 之后)新增:

```js
const AUTO_COLLAPSE_MS = 10000; // 警告解决后,延迟多少毫秒自动收回列表
let listAutoExpanded = false;   // 当前 list 是否「黄色警告自动展开」(区别于用户手动 ▾)
let autoCollapseTimer = null;   // 延迟收回计时器(幂等:仅在 null 时才启动,避免每秒重置)
```

- [ ] **Step 3: 新增 `clearAutoCollapse` 与 `maybeScheduleAutoCollapse` 函数**

在 `setMode` 函数(约第 107-118 行)之后、`collapseToBase`(约第 120 行)之前插入:

```js
// 清掉挂起的延迟收回计时器并复位来源标志。收回/切形态时调用,防残留再触发。
function clearAutoCollapse() {
  if (autoCollapseTimer !== null) {
    clearTimeout(autoCollapseTimer);
    autoCollapseTimer = null;
  }
  listAutoExpanded = false;
}

// 幂等调度延迟收回。放 tick 末尾,与 refreshAlert 用同一个 waitingActive 表达式,
// 保证「黄闪消失」与「开始计时」同步。waitingActive 持续为 0 时不会每秒重置计时器。
function maybeScheduleAutoCollapse() {
  const waitingActive = lastWaitingIds.filter((id) => !muted.has(id)).length;
  if (
    shouldArmCollapse({ waitingActive, currentMode, listAutoExpanded, appearance })
  ) {
    if (autoCollapseTimer === null) {
      autoCollapseTimer = setTimeout(() => {
        autoCollapseTimer = null;
        collapseToBase(); // 内部 clearAutoCollapse 会复位标志
      }, AUTO_COLLAPSE_MS);
    }
  } else if (autoCollapseTimer !== null) {
    clearTimeout(autoCollapseTimer);
    autoCollapseTimer = null;
  }
}
```

- [ ] **Step 4: `collapseToBase` 收回时清计时**

将 `collapseToBase`(约第 121-123 行):

```js
function collapseToBase() {
  setMode(appearance);
}
```

改为:

```js
function collapseToBase() {
  clearAutoCollapse(); // 收回时清挂起计时 + 复位来源标志,防残留
  setMode(appearance);
}
```

- [ ] **Step 5: `__setAppearance` 切形态时清计时**

将 `window.__setAppearance`(约第 147-151 行):

```js
window.__setAppearance = (mode) => {
  if (!MODE_EL[mode]) return;
  appearance = mode;
  setMode(mode);
};
```

改为:

```js
window.__setAppearance = (mode) => {
  if (!MODE_EL[mode]) return;
  appearance = mode;
  clearAutoCollapse(); // 切基础态:作废当前展开来源 + 清挂起计时
  setMode(mode);
};
```

- [ ] **Step 6: 警告自动展开处标记来源**

将 `tick` 内(约第 287-291 行):

```js
    const freshActive = freshWaiting.filter((id) => !muted.has(id));
    if (freshActive.length > 0) {
      chimeWaiting(); // 「叮咚」双音（默认开），已消音的不响
      setMode("list"); // 有新待确认 -> 自动展开列表
    }
```

改为:

```js
    const freshActive = freshWaiting.filter((id) => !muted.has(id));
    if (freshActive.length > 0) {
      chimeWaiting(); // 「叮咚」双音（默认开），已消音的不响
      listAutoExpanded = true; // 标记:此次展开是警告触发(解决后可自动收回)
      setMode("list"); // 有新待确认 -> 自动展开列表
    }
```

- [ ] **Step 7: 用户手动展开处标记为「非自动」**

将 `#expand` 监听(约第 250 行):

```js
$("#expand").addEventListener("click", () => setMode("list"));
```

改为:

```js
$("#expand").addEventListener("click", () => {
  listAutoExpanded = false; // 用户主动 ▾ 展开,不纳入自动收回
  setMode("list");
});
```

- [ ] **Step 8: `tick` 末尾调用调度函数**

在 `tick` 内 `prevWaiting = waitingIds;`(约第 292 行)之后、`requestAnimationFrame(fitWindow)`(约第 295 行)之前插入:

```js
    // 警告解决(活动待确认归零)后,延迟收回「自动展开的列表」(基础态非 list 时)。
    maybeScheduleAutoCollapse();
```

- [ ] **Step 9: 启动应用,冒烟验证无报错**

Run: `npm run dev`(后台运行,等编译完成)
Expected: 应用窗口正常出现,DevTools Console 无报错;既有功能(药丸/列表/猫切换、计数、消音、移除)全部正常。**不要在此步依赖自动收回时序**,仅确认接入未破坏现有行为。

- [ ] **Step 10: 提交**

```bash
git add src/app.js
git commit -m "feat(auto-collapse): 警告解决后 10s 自动收回列表" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 全量回归与功能验证

**Files:** 无代码改动(纯验证;若发现问题再回头改 Task 2)。

- [ ] **Step 1: 跑全部单测**

Run: `npm test`
Expected: 全部 PASS(`auto-collapse.test.js` + `cat.test.js` + `render.test.js`)。

- [ ] **Step 2: 手动验证完整收回链路**

应用保持 `npm run dev` 运行,在真实使用中(Claude Code 触发 permission request 即产生 waiting)逐项验证:

1. **基本收回**:出现待确认 → 列表自动展开(黄闪+叮咚) → 在 Claude Code 端确认(或点列表行 🔔 消音) → **约 10s 后列表自动收回**到药丸(或猫)。
2. **10s 内又来新警告不收**:展开后 10s 内再次出现新的待确认 → 保持展开,**不收回**(收回计时被新警告清掉)。
3. **手动展开永不自动收**:点 ▾ 手动展开列表 → 即便此时有待确认并随后解决 → **不自动收回**(用户主动看的列表不被打断)。
4. **基础态=猫**:托盘把外观切到「猫咪」→ 触发待确认展开 → 解决后 10s **收回成猫**(而非药丸)。
5. **常驻列表不收**:托盘把外观切到「列表」(常驻)→ 触发并解决待确认 → **不发生形态变化**(本就是 list)。

- [ ] **Step 3: 终态确认**

确认上述 5 项全部符合预期,且既有功能(消音🔔、移除✕、卡住提示、完成蓝闪、托盘切换持久化、鼠标穿透降透明度)无回归。如有偏差,回到 Task 2 对应 Step 修正后重跑本任务。

(本任务无代码改动,无需新增 commit。)

---

## Self-Review

**1. Spec 覆盖:** spec 各节 → 任务对照:
- 「① 来源标志」4 处设值 → Task 2 Step 5/6/7(`collapseToBase`/警告展开/手动展开)+ Step 3 的 `clearAutoCollapse` 内复位 ✓
- 「② 幂等计时器」`maybeScheduleAutoCollapse` + `tick` 调用 → Task 2 Step 3/8 ✓
- 「③ 取消条件」靠 `shouldArm` 变 false → Task 1 的四条件 + Task 2 Step 3 的 else 分支 ✓
- 「测试」纯函数单测 + 手动验证清单 → Task 1 + Task 3 ✓
- 「改动面仅 app.js + 新 auto-collapse.js」→ 文件结构表 ✓

**2. 占位符扫描:** 全部步骤含完整代码,无 TBD/TODO/"类似上文"。手动验证为真实操作步骤而非"测试以上"。✓

**3. 类型一致性:** `shouldArmCollapse({ waitingActive, currentMode, listAutoExpanded, appearance })` 的形参名与 Task 2 Step 3 调用处、Task 1 测试处完全一致;`clearAutoCollapse` / `maybeScheduleAutoCollapse` / `autoCollapseTimer` / `listAutoExpanded` / `AUTO_COLLAPSE_MS` 命名全程统一。✓
