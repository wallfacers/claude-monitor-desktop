import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "./render.js";

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
