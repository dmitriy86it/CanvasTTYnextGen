// Fixed acceptance test of the real series (C1). The executor must make it pass by writing src/clamp.mjs;
// it must not edit this file (the review is told so, and a changed test would change the tree the lead sees).
import assert from "node:assert/strict";
import { test } from "node:test";

test("clamp keeps a value inside [lo, hi]", async () => {
  const { clamp } = await import("../src/clamp.mjs");
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(42, 0, 10), 10);
  assert.equal(clamp(0, 0, 0), 0);
});

test("clamp rejects an empty range", async () => {
  const { clamp } = await import("../src/clamp.mjs");
  assert.throws(() => clamp(1, 5, 2), RangeError);
});
