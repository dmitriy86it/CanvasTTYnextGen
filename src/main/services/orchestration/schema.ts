// Answer validator: a deliberately small subset of JSON Schema, not the standard.
// Supported: type (one or a list), properties, required, additionalProperties: false, enum, items (one schema),
// minLength/maxLength (code points). Any other keyword (annotations included) or additionalProperties !== false
// is rejected by compileSchema: silently ignoring it would accept what the schema forbids.
import type { AnswerSchema, SchemaType } from "./types.ts";

export type { AnswerSchema, SchemaType } from "./types.ts";

export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = Object.freeze([
  "type", "properties", "required", "additionalProperties", "enum", "items", "minLength", "maxLength"
]);

const TYPES: readonly string[] = ["object", "array", "string", "number", "integer", "boolean", "null"];
const MAX_ERRORS = 100;

export class UnsupportedSchemaError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`${path}: ${problem}`);
    this.name = "UnsupportedSchemaError";
    this.path = path;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

// Throws UnsupportedSchemaError (with the JSON path of the offending keyword) for anything outside the subset.
export function compileSchema(schema: unknown, path = "$"): AnswerSchema {
  const fail = (p: string, problem: string): never => { throw new UnsupportedSchemaError(p, problem); };
  if (!isPlainObject(schema)) fail(path, "schema must be an object");
  const s = schema as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!SUPPORTED_SCHEMA_KEYWORDS.includes(k)) fail(`${path}.${k}`, `unsupported schema keyword ${k}`);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.length === 0 || !types.every((t) => typeof t === "string" && TYPES.includes(t))) fail(`${path}.type`, "unsupported type");
  }
  if (s.properties !== undefined) {
    if (!isPlainObject(s.properties)) fail(`${path}.properties`, "must be an object");
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) compileSchema(v, `${path}.properties.${k}`);
  }
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((k) => typeof k === "string"))) {
    fail(`${path}.required`, "must be an array of strings");
  }
  if (s.additionalProperties !== undefined && s.additionalProperties !== false) fail(`${path}.additionalProperties`, "only false is supported");
  if (s.enum !== undefined && !(Array.isArray(s.enum) && s.enum.length > 0)) fail(`${path}.enum`, "must be a non-empty array");
  if (s.items !== undefined) compileSchema(s.items, `${path}.items`); // tuple form (array) fails as "must be an object"
  for (const k of ["minLength", "maxLength"]) if (s[k] !== undefined && !isCount(s[k])) fail(`${path}.${k}`, "must be a non-negative integer");
  return s as AnswerSchema;
}

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;
const matches = (t: SchemaType, v: unknown) => {
  const a = typeOf(v);
  return a === t || (t === "number" && a === "integer");
};

// Returns "<path>: <problem>" strings, at most MAX_ERRORS; [] = valid. `schema` must come from compileSchema.
export function validateAnswer(schema: AnswerSchema, value: unknown, path = "$", errors: string[] = []): string[] {
  if (errors.length >= MAX_ERRORS) return errors;
  const err = (m: string) => { if (errors.length < MAX_ERRORS) errors.push(`${path}: ${m}`); };
  if (schema.type !== undefined) {
    const types: readonly SchemaType[] = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (!types.some((t) => matches(t, value))) {
      err(`expected ${types.join("|")}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) err("not in enum");
  if (typeof value === "string") {
    const n = [...value].length;
    if (schema.minLength !== undefined && n < schema.minLength) err(`shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && n > schema.maxLength) err(`longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value) && schema.items) {
    const items = schema.items;
    value.forEach((v, i) => validateAnswer(items, v, `${path}[${i}]`, errors));
  }
  if (isPlainObject(value)) {
    const props = schema.properties ?? {};
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) err(`missing required ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) validateAnswer(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) err(`unexpected property ${k}`);
    }
  }
  return errors;
}
