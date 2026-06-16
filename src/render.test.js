import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration, buildViewModel, newlyWaiting, statusLabel } from "./render.js";

test("formatDuration: 秒 -> m:ss", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(512), "8:32");
});

test("formatDuration: 超过 1 小时 -> h:mm:ss", () => {
  assert.equal(formatDuration(3661), "1:01:01");
});

test("formatDuration: 负数夹到 0", () => {
  assert.equal(formatDuration(-5), "0:00");
});

const sample = {
  windows: [
    { id: "a", name: "proj-a", status: "running", run_sec: 512, idle_sec: 3 },
    { id: "b", name: "proj-b", status: "running", run_sec: 700, idle_sec: 650 },
    { id: "c", name: "proj-c", status: "waiting", run_sec: 0, idle_sec: 42 },
    { id: "d", name: "proj-d", status: "done", run_sec: 0, idle_sec: 5 },
  ],
  aggregate: "waiting",
  ts: 1750000000,
};

test("buildViewModel: 计数与聚合", () => {
  const vm = buildViewModel(sample, 600);
  assert.deepEqual(vm.counts, { running: 2, waiting: 1, done: 1 });
  assert.equal(vm.aggregate, "waiting");
  assert.equal(vm.rows.length, 4);
});

test("buildViewModel: running 显示计时，其它显示 —", () => {
  const vm = buildViewModel(sample, 600);
  assert.equal(vm.rows[0].timerText, "8:32");
  assert.equal(vm.rows[2].timerText, "—");
  assert.equal(vm.rows[3].timerText, "—");
});

test("buildViewModel: 卡住判定用 idle_sec 而非 run_sec", () => {
  const vm = buildViewModel(sample, 600);
  assert.equal(vm.rows[0].stuck, false);
  assert.equal(vm.rows[1].stuck, true);
});

test("buildViewModel: waiting 行高亮", () => {
  const vm = buildViewModel(sample, 600);
  assert.equal(vm.rows[2].highlight, true);
  assert.equal(vm.rows[0].highlight, false);
});

test("buildViewModel: 空/缺字段安全", () => {
  const vm = buildViewModel(null, 600);
  assert.deepEqual(vm.counts, { running: 0, waiting: 0, done: 0 });
  assert.equal(vm.aggregate, "idle");
  assert.deepEqual(vm.rows, []);
});

test("newlyWaiting: 首次出现的 waiting 触发", () => {
  const state = { windows: [{ id: "c", status: "waiting" }] };
  const r = newlyWaiting([], state);
  assert.deepEqual(r.freshWaiting, ["c"]);
  assert.deepEqual(r.waitingIds, ["c"]);
});

test("newlyWaiting: 持续 waiting 不重复触发", () => {
  const state = { windows: [{ id: "c", status: "waiting" }] };
  const r = newlyWaiting(["c"], state);
  assert.deepEqual(r.freshWaiting, []);
  assert.deepEqual(r.waitingIds, ["c"]);
});

test("newlyWaiting: 多窗口只挑新增", () => {
  const state = {
    windows: [
      { id: "c", status: "waiting" },
      { id: "e", status: "waiting" },
      { id: "a", status: "running" },
    ],
  };
  const r = newlyWaiting(["c"], state);
  assert.deepEqual(r.freshWaiting, ["e"]);
});

test("statusLabel 中文映射", () => {
  assert.equal(statusLabel("running"), "运行中");
  assert.equal(statusLabel("waiting"), "待确认");
  assert.equal(statusLabel("done"), "完成");
});
