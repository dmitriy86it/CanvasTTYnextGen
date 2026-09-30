import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPPORTED_SCHEMA_KEYWORDS,
  UnsupportedSchemaError,
  compileSchema,
  validateAnswer
} from "../src/main/services/orchestration/schema.ts";

test("supported subset validates values", () => {
  const s = compileSchema({
    type: "object", required: ["a", "k"], additionalProperties: false,
    properties: { a: { type: "integer" }, k: { enum: ["x", "y"] }, l: { type: "array", items: { type: "string", maxLength: 2 } }, n: { type: ["null", "number"] }, b: { type: "boolean" } }
  });
  assert.deepEqual(validateAnswer(s, { a: 1, k: "x", l: ["ab", "🧪🧪"], n: null, b: true }), []);
  assert.deepEqual(validateAnswer(s, { a: 1.5, k: "z", l: ["abc", 3], n: "s", extra: 1 }), [
    "$.a: expected integer, got number", "$.k: not in enum", "$.l[0]: longer than 2", "$.l[1]: expected string, got integer",
    "$.n: expected null|number, got string", "$: unexpected property extra"
  ]);
  assert.deepEqual(validateAnswer(s, []), ["$: expected object, got array"]);
  assert.deepEqual(validateAnswer(s, {}), ["$: missing required a", "$: missing required k"]);
  assert.deepEqual(validateAnswer(compileSchema({ type: "string", minLength: 2 }), "a"), ["$: shorter than 2"]);
  assert.deepEqual(validateAnswer(compileSchema({ type: "number" }), 3), [], "an integer is a number");
  assert.deepEqual(validateAnswer(compileSchema({}), { anything: [1] }), [], "empty schema accepts anything");
  const many = validateAnswer(compileSchema({ type: "array", items: { type: "string" } }), Array(500).fill(1));
  assert.equal(many.length, 100, "errors are bounded");
});

test("compileSchema rejects everything outside the subset, with the path", () => {
  assert.deepEqual([...SUPPORTED_SCHEMA_KEYWORDS].sort(), ["additionalProperties", "enum", "items", "maxLength", "minLength", "properties", "required", "type"]);
  const cases = [
    [{ $ref: "#/x" }, "$.$ref"],
    [{ oneOf: [{ type: "string" }] }, "$.oneOf"],
    [{ anyOf: [] }, "$.anyOf"],
    [{ allOf: [] }, "$.allOf"],
    [{ not: {} }, "$.not"],
    [{ type: "string", pattern: "^a" }, "$.pattern"],
    [{ type: "string", format: "email" }, "$.format"],
    [{ type: "number", minimum: 0 }, "$.minimum"],
    [{ type: "object", additionalProperties: true }, "$.additionalProperties"],
    [{ type: "object", additionalProperties: { type: "string" } }, "$.additionalProperties"],
    [{ type: "object", properties: { a: { type: "string", pattern: "x" } } }, "$.properties.a.pattern"],
    [{ type: "array", items: { const: 1 } }, "$.items.const"],
    [{ type: "array", items: [{ type: "string" }] }, "$.items"],
    [{ description: "annotations are keywords too" }, "$.description"],
    [{ type: "date" }, "$.type"],
    [{ type: [] }, "$.type"],
    [{ enum: [] }, "$.enum"],
    [{ required: "a" }, "$.required"],
    [{ properties: [] }, "$.properties"],
    [{ type: "string", maxLength: -1 }, "$.maxLength"],
    [{ type: "string", minLength: 1.5 }, "$.minLength"],
    [null, "$"],
    [[], "$"]
  ];
  for (const [schema, path] of cases) {
    assert.throws(() => compileSchema(schema), (e) => e instanceof UnsupportedSchemaError && e.path === path && e.message.startsWith(`${path}: `), JSON.stringify(schema));
  }
});
