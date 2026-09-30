// Minimal JSON Schema subset: type (string or list), properties, required, additionalProperties: false,
// enum, items (one schema), minLength/maxLength (code points). Returns "<path>: <problem>" strings; [] = valid.
// An unsupported keyword is an error, never silently ignored (it would accept what the schema forbids).
const MAX_ERRORS = 100;
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples"]);
const KNOWN = new Set(["type", "properties", "required", "additionalProperties", "enum", "items", "minLength", "maxLength"]);

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v);
const matches = (t, v) => { const a = typeOf(v); return a === t || (t === "number" && a === "integer"); };

export function validate(schema, value, path = "$", errors = []) {
  if (errors.length >= MAX_ERRORS) return errors;
  const err = (m) => { if (errors.length < MAX_ERRORS) errors.push(`${path}: ${m}`); };
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) { err("schema is not an object"); return errors; }
  for (const k of Object.keys(schema)) if (!KNOWN.has(k) && !ANNOTATIONS.has(k)) err(`unsupported schema keyword ${k}`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") err("unsupported additionalProperties schema");

  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => matches(t, value))) { err(`expected ${types.join("|")}, got ${typeOf(value)}`); return errors; }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) err("not in enum");
  if (typeof value === "string") {
    const n = [...value].length;
    if (schema.minLength !== undefined && n < schema.minLength) err(`shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && n > schema.maxLength) err(`longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
  if (typeOf(value) === "object") {
    const props = schema.properties ?? {};
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) err(`missing required ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) validate(props[k], v, `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) err(`unexpected property ${k}`);
    }
  }
  return errors;
}
