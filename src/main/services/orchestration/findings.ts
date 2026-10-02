// Journal v2, A3: findings of the reviewer (5h §2.4, §3.4, §3.10; journal-v2-format.md §2.8). Pure: the service, the
// replay of the texts and the view all derive the findings from the same applied texts with these functions. The only
// outside facts — which paths changed since a tree — come in already computed.
import type { RunState, TextRef } from "./journal.ts";
import { applyPlan, emptyBook } from "./conditions.ts";
import type { ConditionsBook, PlanText } from "./conditions.ts";

export type Severity = "blocking" | "wish";
export interface Relation { repeatOf: string | null; distinctFrom: string | null; why: string | null }
// One finding of the reviewer's report as it answered (journal-v2-format.md §2.8, the flat form).
export interface ReportFinding {
  id: string | null; severity: Severity; condition: string | null; problem: string; evidence: string; closeWhen: string;
  status: "open" | "closed"; paths: string[]; relation: Relation | null;
}
export type RefusedReason = "same_run_key" | "no_new_evidence" | "declared_repeat";
// What the application did with a report, with the numbers it gave (5h §2.4 `applied`).
export interface Applied {
  report: TextRef;
  conditionsMet: string[];
  opened: { id: string; index: number; severity: Severity; condition: string | null; stage: number | null; paths: string[]; possibleRepeatOf: string | null }[];
  closed: { id: string; index: number }[];
  reopened: { id: string; index: number }[];
  refused: { index: number; finding: string; reason: RefusedReason }[];
  disputed: { index: number; candidates: string[] }[];
  unchanged: { id: string; index: number }[];
  nextFinding: number;
}
export type FindingEventKind = "opened" | "closed" | "reopened" | "refused" | "disputed" | "unchanged";
// One step of a finding's history: which review did what, on which state (runKey) and tree.
export interface FindingEvent { kind: FindingEventKind; turnId: string; seq: number; runKey: string; tree: string; index: number; reason?: RefusedReason }
export interface Finding {
  id: string; severity: Severity; condition: string | null;
  stage: number | null; // the stage of the review that opened it (or opened it again); null: the final review
  ownedSince: number; // the seq of that review: a plan recorded after it replaces a stage-bound finding's stage
  paths: string[]; problem: string; evidence: string; closeWhen: string;
  status: "open" | "closed";
  openRunKey: string; openTree: string; closeRunKey: string | null; closeTree: string | null;
  possibleRepeatOf: string | null;
  distinctCount: number; // new findings opened as distinct from it on its unchanged paths since it was closed (5h §3.4 p. 4)
  history: FindingEvent[];
}
export interface FindingsBook {
  list: Map<string, Finding>;
  next: number; // nextFinding
  // disputed items without the person's decision (A4 decides them): each blocks its stage and the completion
  disputed: { turnId: string; index: number; candidates: string[]; problem: string; seq: number }[];
}
export interface ReviewContext { turnId: string; seq: number; runKey: string; tree: string; stage: number | null }

export const emptyFindings = (): FindingsBook => ({ list: new Map(), next: 1, disputed: [] });
const fid = (n: number) => `F${n}`;
const relationOf = (r: Relation | null): Relation | null => (r && (r.repeatOf !== null || r.distinctFrom !== null || r.why !== null) ? r : null);

// The report against the findings now (journal-v2-format.md §2.8, «invalid_report»; 5h §3.4): what is wrong, or what
// the application does with it. changedSince(tree): the paths changed between that tree and the reviewed one.
// stageConditions: the conditions a finding of this review may be bound to (null: the final review, any condition).
export function planReview(book: FindingsBook, findings: readonly ReportFinding[], ctx: ReviewContext & {
  changedSince(tree: string): ReadonlySet<string>;
  stageConditions: readonly string[] | null;
  conditions: readonly string[]; // every condition of the plans, for the shape check
}): { problems: string[]; applied: Omit<Applied, "report" | "conditionsMet"> } {
  const problems: string[] = [];
  const seen = new Set<string>();
  findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (f.id !== null) {
      const known = book.list.get(f.id);
      if (!known) problems.push(`${at}: ${f.id} is not a finding of this run (a new finding has id null; the application numbers it)`);
      else {
        if (f.severity !== known.severity) problems.push(`${at}: ${f.id} is ${known.severity}; its severity cannot change`);
        if (f.condition !== known.condition) problems.push(`${at}: ${f.id} is bound to ${known.condition ?? "no condition"}; its condition cannot change`);
        if (known.severity === "blocking" && known.status === "open" && f.status === "closed") {
          if (ctx.runKey === known.openRunKey) problems.push(`${at}: ${f.id} cannot be closed on the state it was opened on`);
          else if (f.paths.length === 0) problems.push(`${at}: closing ${f.id} needs the paths changed for it`);
          else {
            const changed = ctx.changedSince(known.openTree);
            for (const p of f.paths) if (!changed.has(p)) problems.push(`${at}: ${p} did not change since ${f.id} was opened`);
          }
        }
      }
      if (seen.has(f.id)) problems.push(`${at}: ${f.id} is named twice`);
      seen.add(f.id);
    } else {
      if (f.status !== "open") problems.push(`${at}: a new finding is open`);
      if (f.severity === "blocking" && f.paths.length === 0) problems.push(`${at}: a new blocking finding names its paths`);
      if (f.condition !== null && !ctx.conditions.includes(f.condition)) problems.push(`${at}: ${f.condition} is not a condition of this run`);
    }
    const r = relationOf(f.relation);
    if (r) {
      if (r.repeatOf !== null && r.distinctFrom !== null) problems.push(`${at}: relation is repeatOf or distinctFrom, not both`);
      if (r.distinctFrom !== null && (r.why ?? "").trim() === "") problems.push(`${at}: distinctFrom says why`);
    }
  });
  const applied: Omit<Applied, "report" | "conditionsMet"> = { opened: [], closed: [], reopened: [], refused: [], disputed: [], unchanged: [], nextFinding: book.next };
  if (problems.length) return { problems, applied };

  // a closed finding's own paths changed after it was closed (on another state): the evidence to open it again
  const reopenable = (f: Finding): RefusedReason | null => {
    if (f.closeRunKey === ctx.runKey) return "same_run_key";
    const changed = ctx.changedSince(f.closeTree as string);
    return f.paths.some((p) => changed.has(p)) ? null : "no_new_evidence";
  };
  let next = book.next;
  for (const [index, f] of findings.entries()) {
    if (f.id !== null) {
      const known = book.list.get(f.id)!;
      if (known.status === f.status) applied.unchanged.push({ id: f.id, index });
      else if (f.status === "closed") applied.closed.push({ id: f.id, index });
      else {
        const why = reopenable(known);
        if (why) applied.refused.push({ index, finding: f.id, reason: why });
        else applied.reopened.push({ id: f.id, index });
      }
      continue;
    }
    // binding (5h §3.4): a stage review binds only to a condition of its stage; otherwise to the stage, without one
    const condition = f.condition !== null && (ctx.stageConditions === null || ctx.stageConditions.includes(f.condition)) ? f.condition : null;
    const open = (possibleRepeatOf: string | null) => {
      applied.opened.push({ id: fid(next++), index, severity: f.severity, condition, stage: ctx.stage, paths: [...f.paths], possibleRepeatOf });
    };
    if (f.severity === "wish") { open(null); continue; }
    // a possible repeat of a finding closed before this report: shared paths that did not change since it was closed
    const candidates = [...book.list.values()].filter((c) => c.status === "closed" && c.paths.some((p) => f.paths.includes(p))
      && f.paths.filter((p) => c.paths.includes(p)).every((p) => !ctx.changedSince(c.closeTree as string).has(p))).map((c) => c.id);
    if (candidates.length === 0) { open(null); continue; }
    const r = relationOf(f.relation);
    const exhausted = candidates.some((id) => book.list.get(id)!.distinctCount >= 1);
    // a candidate whose one distinctFrom is spent: disputed, whatever the relation says (5h §3.4 p. 3–4)
    if (!exhausted && r?.repeatOf && candidates.includes(r.repeatOf)) {
      const target = book.list.get(r.repeatOf)!;
      // one finding is named once per report: by its id, or as the repeat of one new finding
      if (seen.has(target.id)) { problems.push(`findings[${index}]: ${target.id} is named twice`); continue; }
      seen.add(target.id);
      if (reopenable(target) === null) applied.reopened.push({ id: target.id, index });
      else applied.refused.push({ index, finding: target.id, reason: "declared_repeat" });
      continue;
    }
    if (!exhausted && r?.distinctFrom && candidates.includes(r.distinctFrom)) { open(r.distinctFrom); continue; }
    applied.disputed.push({ index, candidates });
  }
  applied.nextFinding = next;
  return { problems, applied: problems.length ? { opened: [], closed: [], reopened: [], refused: [], disputed: [], unchanged: [], nextFinding: book.next } : applied };
}

// The applied text against the report and the findings before it: the structure 5h §3.10 checks on replay (the second
// stage). null: consistent.
// ctx: the review's stage and runKey (the paths changed between trees are the live rule's; replay has no trees).
export function appliedProblem(book: FindingsBook, applied: Applied, findings: readonly ReportFinding[], conditionsMet: readonly string[],
  ctx: { stage: number | null; runKey: string }): string | null {
  const indexes = [...applied.opened, ...applied.closed, ...applied.reopened, ...applied.refused, ...applied.disputed, ...applied.unchanged].map((x) => x.index);
  if (indexes.length !== findings.length || new Set(indexes).size !== findings.length || indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= findings.length)) {
    return "not every finding of the report is accounted for exactly once";
  }
  let next = book.next;
  for (const o of applied.opened) {
    if (o.id !== fid(next++)) return `${o.id} is not the next finding number`;
    const f = findings[o.index];
    if (f.id !== null || f.severity !== o.severity || JSON.stringify(f.paths) !== JSON.stringify(o.paths)) return `${o.id} is not the report's finding ${o.index}`;
    if (o.stage !== ctx.stage || (o.condition !== null && o.condition !== f.condition)) return `${o.id} is not bound as the review opened it`;
  }
  for (const f of findings) {
    const known = f.id === null ? null : book.list.get(f.id);
    if (f.id !== null && (!known || known.severity !== f.severity || known.condition !== f.condition)) return `${f.id} changed its severity or condition, or is not a finding`;
    if (known && known.severity === "blocking" && known.status === "open" && f.status === "closed" && (f.paths.length === 0 || ctx.runKey === known.openRunKey)) {
      return `${f.id} is closed on the state it was opened on, or without paths`;
    }
  }
  const ids = [...applied.closed, ...applied.reopened, ...applied.unchanged].map((x) => x.id);
  if (new Set(ids).size !== ids.length) return "a finding is named twice";
  if (applied.nextFinding !== next) return "nextFinding does not follow the opened findings";
  const state = (id: string) => book.list.get(id)?.status ?? null;
  for (const c of applied.closed) if (state(c.id) !== "open" || findings[c.index].id !== c.id || findings[c.index].status !== "closed") return `${c.id} is not an open finding the report closes`;
  for (const c of applied.reopened) if (state(c.id) !== "closed") return `${c.id} is not a closed finding`;
  for (const c of applied.unchanged) if (state(c.id) === null || findings[c.index].id !== c.id || state(c.id) !== findings[c.index].status) return `${c.id} is not unchanged`;
  for (const c of applied.refused) if (state(c.finding) !== "closed") return `${c.finding} is not a closed finding`;
  for (const c of applied.disputed) if (c.candidates.length === 0 || c.candidates.some((id) => state(id) !== "closed")) return "a disputed item without closed candidates";
  if (JSON.stringify([...applied.conditionsMet].sort()) !== JSON.stringify([...conditionsMet].sort())) return "conditionsMet is not what the report marks met";
  return null;
}

// The book after a review's applied text (in place): new findings, closes, reopens, and every finding's history.
export function applyApplied(book: FindingsBook, applied: Applied, findings: readonly ReportFinding[], ctx: ReviewContext): void {
  const event = (kind: FindingEventKind, index: number, reason?: RefusedReason): FindingEvent => ({
    kind, turnId: ctx.turnId, seq: ctx.seq, runKey: ctx.runKey, tree: ctx.tree, index, ...(reason ? { reason } : {})
  });
  for (const o of applied.opened) {
    const f = findings[o.index];
    book.list.set(o.id, {
      id: o.id, severity: o.severity, condition: o.condition, stage: o.stage, ownedSince: ctx.seq, paths: [...o.paths],
      problem: f.problem, evidence: f.evidence, closeWhen: f.closeWhen, status: "open", openRunKey: ctx.runKey, openTree: ctx.tree,
      closeRunKey: null, closeTree: null, possibleRepeatOf: o.possibleRepeatOf, distinctCount: 0, history: [event("opened", o.index)]
    });
    if (o.possibleRepeatOf) book.list.get(o.possibleRepeatOf)!.distinctCount++;
  }
  for (const c of applied.closed) {
    const f = book.list.get(c.id)!;
    Object.assign(f, { status: "closed", closeRunKey: ctx.runKey, closeTree: ctx.tree, distinctCount: 0 });
    f.history.push(event("closed", c.index));
  }
  for (const c of applied.reopened) {
    const f = book.list.get(c.id)!;
    Object.assign(f, { status: "open", openRunKey: ctx.runKey, openTree: ctx.tree, stage: ctx.stage, ownedSince: ctx.seq });
    f.history.push(event("reopened", c.index));
  }
  for (const c of applied.unchanged) book.list.get(c.id)!.history.push(event("unchanged", c.index));
  for (const c of applied.refused) book.list.get(c.finding)!.history.push(event("refused", c.index, c.reason));
  for (const c of applied.disputed) {
    book.disputed.push({ turnId: ctx.turnId, index: c.index, candidates: [...c.candidates], problem: findings[c.index].problem, seq: ctx.seq });
    for (const id of c.candidates) book.list.get(id)!.history.push(event("disputed", c.index));
  }
  book.next = applied.nextFinding;
}

// The stage that owns an open finding now (5h §3.4 «Привязка к этапу»): a bound one, the stage of its condition in the
// plans in force while that stage is not accepted; otherwise (unbound, or its condition's stage accepted) the stage it
// was opened on (or opened again) while that one is not accepted and no later plan replaced it — then the first
// unaccepted stage of that plan. null: no unaccepted stage owns it yet (the next action is a plan turn). An open blocking
// finding never stays with an accepted stage (its own stage is not accepted while it is open; one opened again is the
// reviewing stage's): it always reaches an executor.
export function ownerOf(f: Finding, plans: { stages: ReadonlyMap<number, readonly string[]>; accepted: number; recorded: readonly { firstStage: number; seq: number }[] }): number | null {
  if (f.condition !== null) {
    for (const [s, ids] of plans.stages) if (ids.includes(f.condition) && s > plans.accepted) return s;
  }
  const later = plans.recorded.find((p) => p.seq > f.ownedSince);
  if (f.stage !== null && (!later || later.firstStage > f.stage)) return f.stage;
  return later ? Math.max(later.firstStage, plans.accepted + 1) : null;
}

export const openBlocking = (book: FindingsBook): Finding[] => [...book.list.values()].filter((f) => f.status === "open" && f.severity === "blocking");

// ---------- replay: the findings of a run from its texts ----------

// The texts a replay needs: the plans' (in o.plans order), the reviewer's reports and applied texts by turn.
export interface FindingsTexts { plans: readonly PlanText[]; reports: Readonly<Record<string, unknown>>; applied: Readonly<Record<string, Applied>> }
export interface FindingsReplay {
  book: FindingsBook;
  conditions: ConditionsBook; // the plans in force (A2's book)
  // after each assessed review: its stage's open blocking ids (the progress key of 5h §3.3) — by review turn
  openAfter: Map<string, string[]>;
  problem: string | null; // the first violation of 5h §3.10 / §3.3 / §3.8 in the texts (the second stage of reading)
}
const reportFindings = (r: unknown): ReportFinding[] => {
  const f = (r as { findings?: unknown } | undefined)?.findings;
  return Array.isArray(f) ? f as ReportFinding[] : [];
};
const metIn = (r: unknown): string[] => {
  const c = (r as { conditions?: unknown } | undefined)?.conditions;
  return Array.isArray(c) ? (c as { id: string; status: string }[]).filter((m) => m.status === "met").map((m) => m.id) : [];
};

// Every record that changes the findings or depends on them, in journal order: plans, the reviewer's results, stage
// acceptances, the completion. A stage accepted with an open blocking finding it owns or a disputed item, and a run
// completed with an open blocking finding or a disputed item, are violations (journal-v2-format.md §2.8).
export function replayFindings(state: RunState, t: FindingsTexts): FindingsReplay {
  const o = state.orch;
  const book = emptyFindings();
  const conditions = emptyBook();
  const openAfter = new Map<string, string[]>();
  const out = (problem: string | null): FindingsReplay => ({ book, conditions, openAfter, problem });
  type Ev = { seq: number; run(): string | null };
  const events: Ev[] = [];
  const recorded: { firstStage: number; seq: number }[] = [];
  for (const [i, p] of o.plans.entries()) events.push({ seq: p.seq, run: () => {
    try { applyPlan(conditions, { firstStage: p.firstStage, text: t.plans[i], conditionsAssigned: p.conditionsAssigned ?? null }); } catch { /* conditionsConflict reports it */ }
    recorded.push({ firstStage: p.firstStage, seq: p.seq });
    return null;
  } });
  let accepted = 0;
  const owners = () => ({ stages: conditions.stages, accepted, recorded });
  for (const r of o.reviews) {
    if (!r.assessed) continue;
    events.push({ seq: r.seq, run: () => {
      const applied = t.applied[r.turnId];
      const report = t.reports[r.turnId];
      if (!applied || !report) return `the texts of review ${r.turnId} are missing`;
      if (applied.report?.sha256 !== r.assessed!.report.sha256) return `the applied text of review ${r.turnId} is about another report`;
      const findings = reportFindings(report);
      if ((report as { request?: unknown }).request !== r.assessed!.request) return `review ${r.turnId}: the request is not the report's`;
      const why = appliedProblem(book, applied, findings, metIn(report), { stage: r.stage, runKey: r.runKey });
      if (why) return `review ${r.turnId}: ${why}`;
      applyApplied(book, applied, findings, { turnId: r.turnId, seq: r.seq, runKey: r.runKey, tree: o.turns[r.turnId]?.tree ?? "", stage: r.stage });
      openAfter.set(r.turnId, openBlocking(book).filter((f) => ownerOf(f, owners()) === r.stage).map((f) => f.id).sort());
      return null;
    } });
  }
  for (const [stage, a] of Object.entries(o.accepted)) {
    events.push({ seq: a.seq, run: () => {
      const s = Number(stage);
      const held = openBlocking(book).find((f) => ownerOf(f, owners()) === s);
      accepted = Math.max(accepted, s);
      if (book.disputed.length) return `stage ${s} accepted with a disputed finding`;
      return held ? `stage ${s} accepted with ${held.id} open` : null;
    } });
  }
  events.sort((a, b) => a.seq - b.seq);
  for (const e of events) { const why = e.run(); if (why) return out(why); }
  if (state.completion) {
    const held = openBlocking(book)[0];
    if (held) return out(`completed with ${held.id} open`);
    if (book.disputed.length) return out("completed with a disputed finding");
  }
  return out(null);
}

// A3 (journal-v2-format.md §2.8): a v2 journal is reviewed by the reviewer unless the lead already reviewed in it (A1–A2).
export const byReviewer = (state: RunState): boolean => state.version === 2 && state.orch.reviews.every((r) => r.assessed !== undefined);
