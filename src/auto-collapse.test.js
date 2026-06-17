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
