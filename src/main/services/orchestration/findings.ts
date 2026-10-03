// Journal v2, A3: findings of the reviewer (5h §2.4, §3.4, §3.10; journal-v2-format.md §2.8). Pure: the service, the
// replay of the texts and the view all derive the findings from the same applied texts with these functions. The only
// outside facts — which paths changed since a tree — come in already computed.
import type { PersonDecision, RunState, TextRef } from "./journal.ts";
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
// A4 (journal-v2-format.md §2.3, §2.9): closed_by_person, to_wish (downgraded by the person), moved (to another stage
// or condition when its condition was dropped), and the disputed item's decision on its candidates (decided).
export type FindingEventKind = "opened" | "closed" | "reopened" | "refused" | "disputed" | "unchanged" | "closed_by_person" | "to_wish" | "moved" | "decided";
// One step of a finding's history: which review did what, on which state (runKey) and tree. by person (A4): the
// person's command did it (commandId); turnId and index are then the disputed item's, or null outside a review.
export interface FindingEvent {
  kind: FindingEventKind; turnId: string | null; seq: number; runKey: string; tree: string; index: number | null; reason?: RefusedReason;
  by?: "person"; commandId?: string; note?: string;
}
// A4 (5h §3.6 p. 4): the person's choice for every open blocking finding bound to a condition the proposal drops
export interface PlanChoices { findings: { id: string; choice: "move" | "close" | "to_wish"; stage: number | null; condition: string | null }[] }
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
  // disputed items without the person's decision: each blocks its stage and the completion
  disputed: { turnId: string; index: number; candidates: string[]; problem: string; seq: number }[];
  downgraded: string[]; // A4: blocking findings the person made wishes — the result says so, never as fixed
}
export interface ReviewContext { turnId: string; seq: number; runKey: string; tree: string; stage: number | null }

export const emptyFindings = (): FindingsBook => ({ list: new Map(), next: 1, disputed: [], downgraded: [] });
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

// ---------- A4: the person's decisions (5h §3.4–§3.6, journal-v2-format.md §2.9) ----------

// The reviewed state of a disputed item: its review's runKey, tree and stage, and the item as the report gave it.
export interface ItemContext { runKey: string; tree: string; stage: number | null; finding: ReportFinding | undefined; stageConditions: readonly string[] | null }

// A person.decided about a finding or a disputed item, applied to the book (in place). What is wrong, or null (then
// applied). A condition's decision is not the findings' (conditions.ts).
export function applyPerson(book: FindingsBook, d: PersonDecision, item: (turnId: string, index: number) => ItemContext | null): string | null {
  const by = { by: "person" as const, commandId: d.commandId };
  if (d.subject === "finding") {
    const f = book.list.get(d.target as string);
    if (f?.status !== "open") return `${String(d.target)} is not an open finding`;
    if (d.decision === "close") {
      Object.assign(f, { status: "closed", closeRunKey: d.runKey, closeTree: d.tree, distinctCount: 0 });
      f.history.push({ kind: "closed_by_person", turnId: null, seq: d.seq, runKey: d.runKey, tree: d.tree, index: null, ...by });
    } else {
      if (f.severity !== "blocking") return `${f.id} is not blocking`;
      f.severity = "wish";
      book.downgraded.push(f.id);
      f.history.push({ kind: "to_wish", turnId: null, seq: d.seq, runKey: d.runKey, tree: d.tree, index: null, ...by });
    }
    return null;
  }
  if (d.subject !== "disputed") return null;
  const t = d.target as { reviewTurnId: string; index: number };
  const at = book.disputed.findIndex((x) => x.turnId === t.reviewTurnId && x.index === t.index);
  const ctx = item(t.reviewTurnId, t.index);
  if (at < 0 || !ctx?.finding) return `no disputed item ${t.reviewTurnId}#${t.index} waits for the person`;
  const pending = book.disputed[at];
  const event = (kind: FindingEventKind, reason?: RefusedReason): FindingEvent => ({
    kind, turnId: t.reviewTurnId, seq: d.seq, runKey: ctx.runKey, tree: ctx.tree, index: t.index, ...(reason ? { reason } : {}), ...by
  });
  if (d.decision === "new") {
    if (d.finding !== fid(book.next)) return `the new finding of a disputed item is ${fid(book.next)}, not ${String(d.finding)}`;
    const f = ctx.finding;
    const condition = f.condition !== null && (ctx.stageConditions === null || ctx.stageConditions.includes(f.condition)) ? f.condition : null;
    book.list.set(d.finding, {
      id: d.finding, severity: f.severity, condition, stage: ctx.stage, ownedSince: d.seq, paths: [...f.paths], problem: f.problem, evidence: f.evidence,
      closeWhen: f.closeWhen, status: "open", openRunKey: ctx.runKey, openTree: ctx.tree, closeRunKey: null, closeTree: null,
      possibleRepeatOf: pending.candidates.join(", "), distinctCount: 0, history: [event("opened")]
    });
    book.next++;
  } else {
    const target = pending.candidates.includes(d.finding as string) ? book.list.get(d.finding as string) : undefined;
    if (target?.status !== "closed") return `${String(d.finding)} is not a closed candidate of the disputed item`;
    if (d.reopened && target.closeRunKey === ctx.runKey) return `${target.id} is opened again on the state it was closed on`;
    if (d.reopened) {
      Object.assign(target, { status: "open", openRunKey: ctx.runKey, openTree: ctx.tree, stage: ctx.stage, ownedSince: d.seq });
      target.history.push(event("reopened"));
    } else target.history.push(event("refused", "declared_repeat"));
  }
  // the person's decision is about this item only: the next possible repeat of a candidate is disputed again (5h §3.4 p. 4)
  for (const id of pending.candidates) {
    const c = book.list.get(id)!;
    if (c.status === "closed") c.distinctCount = Math.max(c.distinctCount + (d.decision === "new" ? 1 : 0), 1);
    if (id !== d.finding || d.decision === "new") c.history.push(event("decided"));
  }
  book.disputed.splice(at, 1);
  return null;
}

// plan.decided(accept): the person's choice for each open blocking finding bound to a dropped condition (5h §3.6 p. 4),
// after the new plan is in force. wish findings of a dropped condition stay wishes without it.
export function applyChoices(book: FindingsBook, choices: PlanChoices, dropped: ReadonlySet<string>,
  ctx: { seq: number; runKey: string; tree: string; commandId: string; conditions: ConditionsBook; firstStage: number; lastStage: number }): string | null {
  const affected = openBlocking(book).filter((f) => f.condition !== null && dropped.has(f.condition)).map((f) => f.id).sort();
  const chosen = (choices?.findings ?? []).map((c) => c.id);
  if (JSON.stringify([...chosen].sort()) !== JSON.stringify(affected)) return "the choices are not one for each open blocking finding of a dropped condition";
  for (const c of choices?.findings ?? []) {
    const f = book.list.get(c.id)!;
    const was = f.condition;
    const event = (kind: FindingEventKind): FindingEvent => ({ kind, turnId: null, seq: ctx.seq, runKey: ctx.runKey, tree: ctx.tree, index: null, by: "person", commandId: ctx.commandId, note: was ?? undefined });
    if (c.choice === "move") {
      const stageOf = c.condition === null ? null : [...ctx.conditions.stages.entries()].find(([s, ids]) => s >= ctx.firstStage && ids.includes(c.condition!))?.[0] ?? null;
      const stage = c.condition !== null ? stageOf : c.stage;
      if (stage === null || stage < ctx.firstStage || stage > ctx.lastStage) return `${c.id} is moved to no unaccepted stage of the new plan`;
      Object.assign(f, { condition: c.condition, stage, ownedSince: ctx.seq });
      f.history.push(event("moved"));
    } else if (c.choice === "close") {
      Object.assign(f, { status: "closed", closeRunKey: ctx.runKey, closeTree: ctx.tree, distinctCount: 0, condition: null });
      f.history.push(event("closed_by_person"));
    } else {
      Object.assign(f, { severity: "wish", condition: null });
      book.downgraded.push(f.id);
      f.history.push(event("to_wish"));
    }
  }
  for (const f of book.list.values()) if (f.condition !== null && dropped.has(f.condition)) f.condition = null;
  return null;
}

// ---------- replay: the findings of a run from its texts ----------

// The texts a replay needs: the plans' (in o.plans order), the reviewer's reports and applied texts by turn.
// A4: choices of the accepted proposals, by their turn
export interface FindingsTexts { plans: readonly PlanText[]; reports: Readonly<Record<string, unknown>>; applied: Readonly<Record<string, Applied>>; choices?: Readonly<Record<string, PlanChoices>> }
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
    try { applyPlan(conditions, { firstStage: p.firstStage, text: t.plans[i], conditionsAssigned: p.conditionsAssigned ?? null, base: p.base }); } catch { /* conditionsConflict reports it */ }
    recorded.push({ firstStage: p.firstStage, seq: p.seq });
    // A4: a proposal the person accepted — its choices for the findings of the dropped conditions
    const decision = p.proposed ? o.proposals.find((x) => x.turnId === p.turnId)?.decision : null;
    if (!decision) return null;
    const why = applyChoices(book, t.choices?.[p.turnId] as PlanChoices, new Set((t.plans[i].dropped ?? []).map((x) => x.condition)), {
      seq: p.seq, runKey: decision.runKey, tree: decision.tree, commandId: decision.commandId, conditions, firstStage: p.firstStage, lastStage: p.firstStage + p.stageCount - 1
    });
    return why ? `plan v${p.version}: ${why}` : null;
  } });
  // A4: the person's decisions about findings and disputed items, each about the state of its review
  for (const d of o.person) {
    if (d.subject === "condition") continue;
    events.push({ seq: d.seq, run: () => {
      const why = applyPerson(book, d, (turnId, index) => {
        const r = o.reviews.find((x) => x.turnId === turnId);
        if (!r) return null;
        return { runKey: r.runKey, tree: o.turns[turnId]?.tree ?? "", stage: r.stage, finding: reportFindings(t.reports[turnId])[index],
          stageConditions: r.stage === null ? null : conditions.stages.get(r.stage) ?? [] };
      });
      return why ? `person decision ${d.commandId}: ${why}` : null;
    } });
  }
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
