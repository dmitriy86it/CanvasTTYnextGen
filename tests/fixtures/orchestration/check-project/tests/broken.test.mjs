import assert from "node:assert/strict";
import { test } from "node:test";
import { sum } from "../src/sum.mjs";

// Deliberately wrong: the check that must come back as `failed` (a verdict of the tool, not a runner problem).
test("sum is broken on purpose", () => {
  assert.equal(sum(1, 1), 3);
});
