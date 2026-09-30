// Stage 13: forms MCP servers ask the person to fill (MCP elicitation, `requestedSchema`), for both CLIs. A form is a
// flat object of primitive fields (MCP 2025-11-25 ElicitRequestFormParams): strings (with format), numbers,
// booleans, single and multiple choice. Parsed into fields the panel renders; the person's answer is validated here
// again before it goes back to the CLI. Nothing is ever filled in automatically; a server's own default is shown as
// the initial value, nothing else.
import type { OrchestrationForm, OrchestrationFormField } from "../../../shared/orchestration.ts";

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : null);
const FORMATS = ["email", "uri", "date", "date-time"] as const;
const MAX_FIELDS = 30;

export function parseFormSchema(schema: unknown): OrchestrationForm {
  const s = rec(schema);
  if (s.type !== "object") return { mode: "unsupported", reason: "the requested schema is not an object" };
  const props = rec(s.properties);
  const required = new Set(Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === "string") : []);
  const names = Object.keys(props);
  if (names.length > MAX_FIELDS) return { mode: "unsupported", reason: `more than ${MAX_FIELDS} fields` };
  const fields: OrchestrationFormField[] = [];
  for (const name of names) {
    const p = rec(props[name]);
    const base = {
      name: name.slice(0, 100), title: text(p.title, 200) || name.slice(0, 100), description: text(p.description, 600),
      required: required.has(name), format: null as OrchestrationFormField["format"], options: [] as { value: string; label: string }[],
      minimum: null as number | null, maximum: null as number | null, minLength: null as number | null, maxLength: null as number | null,
      minItems: null as number | null, maxItems: null as number | null
    };
    const choice = (list: unknown): { value: string; label: string }[] | null => {
      if (!Array.isArray(list)) return null;
      return list.slice(0, 100).map((o) => typeof o === "string" ? { value: o, label: o } : { value: text(rec(o).const, 200), label: text(rec(o).title, 200) || text(rec(o).const, 200) });
    };
    if (p.type === "string" && (Array.isArray(p.enum) || Array.isArray(p.oneOf))) {
      const labels = Array.isArray(p.enumNames) ? p.enumNames : null;
      const opts = Array.isArray(p.oneOf) ? choice(p.oneOf)! : choice(p.enum)!.map((o, i) => ({ value: o.value, label: text(labels?.[i], 200) || o.label }));
      fields.push({ ...base, type: "enum", options: opts, default: typeof p.default === "string" ? p.default : null });
    } else if (p.type === "array") {
      const items = rec(p.items);
      const opts = choice(items.enum) ?? choice(items.anyOf);
      if (!opts) return { mode: "unsupported", reason: `field ${name}: an array without choices` };
      fields.push({ ...base, type: "multi", options: opts, minItems: num(p.minItems), maxItems: num(p.maxItems),
        default: Array.isArray(p.default) ? p.default.filter((x): x is string => typeof x === "string") : null });
    } else if (p.type === "string") {
      const format = FORMATS.includes(p.format as never) ? p.format as OrchestrationFormField["format"] : null;
      fields.push({ ...base, type: "string", format, minLength: num(p.minLength), maxLength: num(p.maxLength), default: typeof p.default === "string" ? p.default : null });
    } else if (p.type === "number" || p.type === "integer") {
      fields.push({ ...base, type: p.type, minimum: num(p.minimum), maximum: num(p.maximum), default: num(p.default) });
    } else if (p.type === "boolean") {
      fields.push({ ...base, type: "boolean", default: typeof p.default === "boolean" ? p.default : null });
    } else {
      return { mode: "unsupported", reason: `field ${name}: type ${String(p.type)} is not a form field` };
    }
  }
  return { mode: "form", fields };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/;

// The answer as the MCP server expects it (typed values), or the errors per field.
export function validateForm(fields: readonly OrchestrationFormField[], input: unknown): { ok: true; content: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const v = rec(input);
  const errors: Record<string, string> = {};
  const content: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (!fields.some((f) => f.name === k)) errors[k] = "unknown field";
  for (const f of fields) {
    const raw = v[f.name];
    const empty = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && raw.length === 0 && f.type !== "multi");
    if (empty) { if (f.required) errors[f.name] = "required"; continue; }
    switch (f.type) {
      case "string": {
        if (typeof raw !== "string" || raw.length > 10_000) { errors[f.name] = "text expected"; break; }
        if (f.minLength !== null && raw.length < f.minLength) { errors[f.name] = `at least ${f.minLength} characters`; break; }
        if (f.maxLength !== null && raw.length > f.maxLength) { errors[f.name] = `at most ${f.maxLength} characters`; break; }
        if (f.format === "email" && !EMAIL.test(raw)) { errors[f.name] = "an email address"; break; }
        if (f.format === "uri") { try { new URL(raw); } catch { errors[f.name] = "a URL"; break; } }
        if (f.format === "date" && !DATE.test(raw)) { errors[f.name] = "a date YYYY-MM-DD"; break; }
        if (f.format === "date-time" && !DATE_TIME.test(raw)) { errors[f.name] = "a date and time"; break; }
        content[f.name] = raw;
        break;
      }
      case "number": case "integer": {
        const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
        if (!Number.isFinite(n) || (f.type === "integer" && !Number.isInteger(n))) { errors[f.name] = f.type === "integer" ? "a whole number" : "a number"; break; }
        if (f.minimum !== null && n < f.minimum) { errors[f.name] = `at least ${f.minimum}`; break; }
        if (f.maximum !== null && n > f.maximum) { errors[f.name] = `at most ${f.maximum}`; break; }
        content[f.name] = n;
        break;
      }
      case "boolean":
        if (typeof raw !== "boolean") { errors[f.name] = "yes or no"; break; }
        content[f.name] = raw;
        break;
      case "enum":
        if (typeof raw !== "string" || !f.options.some((o) => o.value === raw)) { errors[f.name] = "one of the choices"; break; }
        content[f.name] = raw;
        break;
      case "multi": {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !f.options.some((o) => o.value === x)) || new Set(raw).size !== raw.length) { errors[f.name] = "choices from the list"; break; }
        if (f.required && raw.length === 0) { errors[f.name] = "required"; break; }
        if (f.minItems !== null && raw.length < f.minItems) { errors[f.name] = `at least ${f.minItems}`; break; }
        if (f.maxItems !== null && raw.length > f.maxItems) { errors[f.name] = `at most ${f.maxItems}`; break; }
        content[f.name] = raw;
        break;
      }
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, content };
}
