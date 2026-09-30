// Memory of the framer (+ bounded collector) under two 200 MB inputs. Run: node --expose-gc mem-check.ts
// Method: gc() then baseline; sample process.memoryUsage() every SAMPLE_EVERY chunks and keep per-field peaks;
// gc() again for "after". All numbers are deltas vs baseline except rss, printed absolute too.
// Limits of the method: sampling can miss short spikes between samples; rss includes code pages and
// allocator slack and is not returned to the OS promptly; one run on one machine, not a leak proof for the product.
import { JsonlFramer, TurnCollector, DEFAULT_LIMITS } from "./jsonl.ts";

const MiB = 2 ** 20;
const CHUNK = 64 * 1024;
const TOTAL = 200 * 1000 * 1000; // 200 MB
const SAMPLE_EVERY = 16; // chunks (= 1 MiB)
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
if (!(globalThis as { gc?: unknown }).gc) console.log("WARNING: run with --expose-gc, baseline/after are not collected");

type Mem = { rss: number; heapUsed: number; external: number; arrayBuffers: number };
const FIELDS = ["heapUsed", "arrayBuffers", "external", "rss"] as const;
const snap = (): Mem => { const m = process.memoryUsage(); return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers }; };

function measure(name: string, body: (sample: () => void) => string) {
  gc(); gc();
  const base = snap();
  const peak = { ...base };
  const sample = () => { const m = snap(); for (const k of FIELDS) peak[k] = Math.max(peak[k], m[k]); };
  const t0 = performance.now();
  const result = body(sample);
  const ms = performance.now() - t0;
  sample();
  gc(); gc();
  const after = snap();
  console.log(`== ${name} (${ms.toFixed(0)} ms)`);
  console.log(`   ${result}`);
  for (const k of FIELDS) {
    const d = (x: number) => ((x - base[k]) / MiB).toFixed(1).padStart(7);
    console.log(`   ${k.padEnd(12)} baseline ${(base[k] / MiB).toFixed(1).padStart(7)} MiB | peak +${d(peak[k])} MiB | after gc +${d(after[k])} MiB`);
  }
}

measure("A: one 200 MB line, default 16 MiB line limit, 64 KiB chunks", (sample) => {
  const c = new TurnCollector("codex");
  const f = new JsonlFramer((x) => c.push(x));
  const chunk = Buffer.alloc(CHUNK, 0x61); // the same chunk object is pushed each time
  f.push(Buffer.from('{"type":"item.completed","text":"'));
  const n = Math.ceil(TOTAL / CHUNK);
  for (let i = 0; i < n; i++) { f.push(chunk); if (i % SAMPLE_EVERY === 0) sample(); }
  f.push(Buffer.from('"}\n{"type":"turn.completed"}\n'));
  f.end();
  const errs = c.errors.map((e) => (e.kind === "error" ? `${e.code}@${e.bytes}B` : "")).join(",");
  return `limit ${DEFAULT_LIMITS.maxMessageBytes / MiB} MiB; input ${(n * CHUNK / MiB).toFixed(0)} MiB; errors=[${errs}] events=${c.events.map((e) => (e.kind === "event" ? e.type : "")).join(",")}`;
});

measure("B: 200 MB of 1 KiB lines, collector maxEvents=1000 maxErrors=100", (sample) => {
  const c = new TurnCollector("codex", { maxEvents: 1000, maxErrors: 100 });
  const f = new JsonlFramer((x) => c.push(x));
  const line = '{"type":"item.completed","text":"' + "b".repeat(1024 - 36) + '"}\n';
  const chunk = Buffer.from(line.repeat(CHUNK / 1024)); // 64 lines per chunk
  if (Buffer.byteLength(line) !== 1024 || chunk.length !== CHUNK) throw new Error("bad fixture");
  const n = Math.ceil(TOTAL / CHUNK);
  for (let i = 0; i < n; i++) { f.push(chunk); if (i % SAMPLE_EVERY === 0) sample(); }
  f.push(Buffer.from('{"type":"turn.completed"}\n'));
  f.end();
  return `lines=${c.frameCount} kept events=${c.events.length} dropped=${c.droppedEvents} overflowAt=${c.overflowAt} terminals=${c.terminals.length} errors=${c.errorCount}`;
});
