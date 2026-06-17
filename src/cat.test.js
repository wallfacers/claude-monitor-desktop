import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatVM } from "./cat.js";

// 构造最小 vm:只给 counts 与 rows(含 stuck)
const vm = (counts, rows = []) => ({ counts, aggregate: "idle", rows });
const row = (status, stuck = false) => ({ id: status, name: status, status, stuck });

test("waiting 最高优先:有待确认 -> waiting pose + 黄角标 + ! 气泡", () => {
  const r = buildCatVM(vm({ running: 2, waiting: 1, done: 3 }, [row("running"), row("waiting")]));
  assert.equal(r.pose, "waiting");
  assert.equal(r.badgeText, "1");
  assert.equal(r.badgeColor, "waiting");
  assert.equal(r.bubble, "!");
  assert.equal(r.sleeping, false);
});

test("waitingActive=0(全消音)时跳过 waiting,落到 running", () => {
  const r = buildCatVM(vm({ running: 2, waiting: 1, done: 0 }, [row("running"), row("waiting")]), { waitingActive: 0 });
  assert.equal(r.pose, "running");
  assert.equal(r.badgeText, "2");
  assert.equal(r.badgeColor, "running");
});

test("stuck 优先于 running:running 行 stuck -> stuck pose + ? 气泡", () => {
  const r = buildCatVM(vm({ running: 1, waiting: 0, done: 0 }, [row("running", true)]));
  assert.equal(r.pose, "stuck");
  assert.equal(r.badgeText, "?");
  assert.equal(r.badgeColor, "waiting");
  assert.equal(r.bubble, "?");
});

test("running:无待确认无卡住 -> running pose + 绿角标", () => {
  const r = buildCatVM(vm({ running: 3, waiting: 0, done: 1 }, [row("running")]));
  assert.equal(r.pose, "running");
  assert.equal(r.badgeText, "3");
  assert.equal(r.badgeColor, "running");
  assert.equal(r.bubble, "");
});

test("done:仅完成 -> done pose + ✓ 前缀蓝角标", () => {
  const r = buildCatVM(vm({ running: 0, waiting: 0, done: 4 }, [row("done")]));
  assert.equal(r.pose, "done");
  assert.equal(r.badgeText, "✓4");
  assert.equal(r.badgeColor, "done");
});

test("idle:全 0 -> idle pose、无角标、sleeping=true(戴睡帽)", () => {
  const r = buildCatVM(vm({ running: 0, waiting: 0, done: 0 }, []));
  assert.equal(r.pose, "idle");
  assert.equal(r.badgeText, "");
  assert.equal(r.badgeColor, null);
  assert.equal(r.sleeping, true);
});

test("counts 透传给 hover 计数", () => {
  const c = { running: 1, waiting: 2, done: 3 };
  assert.deepEqual(buildCatVM(vm(c, [row("waiting")])).counts, c);
});
