import { test } from "node:test";
import assert from "node:assert/strict";
import { fitScale, rasterScale, pageRange, snippets } from "../ui/reader-utils.mjs";
test("fit respects viewport and high DPI rendering stays within pixel budget", () => {
  assert.equal(fitScale(600, 800, 300, 300, "page"), 0.375);
  assert.equal(fitScale(600, 800, 300, 300, "width"), 0.5);
  const ratio = rasterScale(3000, 4000, 3);
  assert.ok(Math.floor(3000 * ratio) * Math.floor(4000 * ratio) <= 8_000_000);
});
test("batch ranges validate bounds, deduplicate pages and limit work", () => {
  assert.deepEqual(pageRange("1-3, 2,5", 9, 2), [1, 2, 3, 5]);
  assert.deepEqual(pageRange("", 9, 7), [7]);
  for (const invalid of ["0", "4-2", "10", "2,x", "1.5", "-1"]) assert.throws(() => pageRange(invalid, 9, 1));
  assert.throws(() => pageRange("1-101", 200, 1), /100/);
  assert.equal(snippets("Japanese 日本語 and JAPANESE", "japanese").length, 2);
  assert.equal(snippets("日本語", "日本").length, 1);
  assert.equal(snippets("anything", "").length, 0);
});
