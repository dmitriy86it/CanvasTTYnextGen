// Requirements and readiness conditions of a journal v2 run (A2: journal-v2-format.md §2.7; acceptance-review-spec.md
// §1, §2.3, §3.3 p. 1–2). Pure functions of the plan texts, the lead's review answers and the journal state: the service
// uses them to check a plan and a review before writing it, the cycle and the completion function to decide, the store
// to check the texts of a journal (its second stage of reading), and the run view to show them.
//
// R<n> is the n-th criterion of the goal: the person's, never changed. C<n> is numbered by the application, in the order
// conditions first appear in the plans; its text, covers and evidence never change. Nothing here is written to the
// journal: every fact is derived from texts the hash chain already fixes.

// person (A4, 5h §3.5): met by the person's decision (person.decided)
export type Evidence = { kind: "check"; check: string } | { kind: "change" } | { kind: "person" };
export interface ConditionDef { id: string; text: string; covers: string[]; evidence: Evidence }
// a condition of a recorded plan: a new one with its number, or one carried over from the plan in force
export type PlanCondition = ConditionDef | { keep: string };
// dropped / dropRequirements (A4, 5h §2.3): what the plan proposes to drop, with the lead's why; only a proposal the
// person accepted (plan.decided) is in force with them
export interface Dropped { condition: string; why: string }
export interface DroppedRequirement { requirement: string; why: string }
export interface PlanText {
  stages: { title: string; task: string; conditions?: PlanCondition[] }[];
  dropped?: Dropped[]; dropRequirements?: DroppedRequirement[]; question: string | null;
}
// a condition as the lead answers it (the answer schema has no anyOf: one flat object, journal-v2-format.md §2.7)
export interface ReportCondition {
  keep: string | null; text: string | null; covers: string[] | null;
  evidence: { kind: "check" | "change" | "person"; check: string | null } | null;
}
export interface PlanReportV2 {
  stages: { title: string; task: string; conditions: ReportCondition[] }[];
  dropped: Dropped[]; dropRequirements: DroppedRequirement[]; question: string | null;
}
// the lead's review answer of a journal formatPreview (A1–A2: the lead reviews)
export interface ConditionMark { id: string; status: "met" | "not_met"; paths: string[]; note: string }
export interface RequirementMark { id: string; status: "met" | "not_met"; note: string }

// One recorded plan: where its stages start, its text, and how many numbers it took (absent: a plan of A1's form).
// base: its first new number (the journal's count, proposals included: A4); absent — the book's next.
export interface RecordedPlan { firstStage: number; text: PlanText; conditionsAssigned: number | null; base?: number }

// What the plans say now: every condition ever defined, the conditions of each stage in force (the accepted stages keep
// those of the plan they were accepted under; the rest are the current plan's), and the next free number.
export interface ConditionsBook {
  defs: Map<string, ConditionDef>;
  stages: Map<number, string[]>;
  next: number;
  conditioned: boolean; // the plan in force has conditions (A2's form); otherwise no condition rule applies (§2.7)
  // A4 (5h §3.6): what the person dropped with a proposal, and the lead's why
  dropped: Map<string, string>;
  droppedRequirements: Map<string, string>;
}

export const emptyBook = (): ConditionsBook => ({ defs: new Map(), stages: new Map(), next: 1, conditioned: false, dropped: new Map(), droppedRequirements: new Map() });

const isKeep = (c: PlanCondition): c is { keep: string } => Object.hasOwn(c, "keep");

// The book after the plans, in journal order. Throws on a text that breaks the numbering or carries over an unknown
// condition (the store reports it as a corrupt text); a plan's own rules are planProblems.
export function bookOf(plans: readonly RecordedPlan[]): ConditionsBook {
  const book = emptyBook();
  for (const p of plans) applyPlan(book, p);
  return book;
}

export function applyPlan(book: ConditionsBook, p: RecordedPlan): void {
  for (const s of [...book.stages.keys()]) if (s >= p.firstStage) book.stages.delete(s);
  // A4 (5h §3.8): a condition of an accepted stage the plan keeps (returned to the work) or drops leaves that stage
  const moved = new Set([...p.text.stages.flatMap((st) => (st.conditions ?? []).filter(isKeep).map((c) => c.keep)), ...(p.text.dropped ?? []).map((x) => x.condition)]);
  for (const [s, ids] of book.stages) book.stages.set(s, ids.filter((id) => !moved.has(id)));
  for (const x of p.text.dropped ?? []) {
    if (!book.defs.has(x.condition)) throw new Error(`${x.condition} is dropped but never defined`);
    book.dropped.set(x.condition, x.why);
  }
  for (const x of p.text.dropRequirements ?? []) book.droppedRequirements.set(x.requirement, x.why);
  const base = p.base ?? book.next;
  let fresh = 0;
  p.text.stages.forEach((stage, i) => {
    const ids = (stage.conditions ?? []).map((c) => {
      if (isKeep(c)) {
        if (!book.defs.has(c.keep)) throw new Error(`${c.keep} is carried over but never defined`);
        return c.keep;
      }
      if (c.id !== `C${base + fresh}`) throw new Error(`${c.id} is not the next condition number C${base + fresh}`);
      fresh++;
      book.defs.set(c.id, { id: c.id, text: c.text, covers: [...c.covers], evidence: c.evidence });
      return c.id;
    });
    book.stages.set(p.firstStage + i, ids);
  });
  if (p.conditionsAssigned === null ? fresh !== 0 : fresh !== p.conditionsAssigned) {
    throw new Error(`the plan numbers ${fresh} new conditions, its record says ${p.conditionsAssigned ?? "none"}`);
  }
  book.next = Math.max(book.next, base + fresh);
  book.conditioned = p.conditionsAssigned !== null;
}

const reqId = (n: number) => `R${n}`;
export const requirementIds = (criteria: number): string[] => Array.from({ length: criteria }, (_, i) => reqId(i + 1));

// The plan's rules (5h §2.3), against the book before it; [] = valid. firstStage: the first stage this plan replaces (the
// stages before it are accepted). checkIds: the commands a "check" condition may name. returned (A4, 5h §3.8): the
// conditions of accepted stages a refused final review returned to the work — the plan keeps or drops each; "any" (the
// replay, which has no trees to tell them): any condition of an accepted stage may be kept or dropped, none must be.
export function planProblems(stages: readonly { conditions: readonly (Omit<ConditionDef, "id"> | { keep: string })[] }[],
  extra: { dropped: readonly Dropped[]; dropRequirements: readonly DroppedRequirement[] }, book: ConditionsBook, firstStage: number,
  criteria: number, checkIds: readonly string[], returned: ReadonlySet<string> | "any" = "any"): string[] {
  const out: string[] = [];
  const open = new Set<string>(); // kept or dropped, each: the conditions of the stages this plan replaces, and the returned ones
  const allowed = new Set<string>();
  for (const [s, ids] of book.stages) {
    for (const id of ids) {
      if (s >= firstStage || (returned !== "any" && returned.has(id))) open.add(id);
      if (s >= firstStage || returned === "any" || returned.has(id)) allowed.add(id);
    }
  }
  const dropped = new Set<string>();
  for (const x of extra.dropped) {
    if (!allowed.has(x.condition)) out.push(`dropped ${x.condition} is not a condition still to be met`);
    else if (dropped.has(x.condition)) out.push(`${x.condition} is dropped twice`);
    if ((x.why ?? "").trim() === "") out.push(`dropped ${x.condition} says why`);
    dropped.add(x.condition);
  }
  const reqs = new Set(requirementIds(criteria));
  const dropReqs = new Set<string>();
  for (const x of extra.dropRequirements) {
    if (!reqs.has(x.requirement) || book.droppedRequirements.has(x.requirement)) out.push(`dropRequirements ${x.requirement} is not a requirement in force (R1..R${criteria})`);
    else if (dropReqs.has(x.requirement)) out.push(`${x.requirement} is dropped twice`);
    if ((x.why ?? "").trim() === "") out.push(`dropRequirements ${x.requirement} says why`);
    dropReqs.add(x.requirement);
  }
  const kept = new Set<string>();
  const covered = new Set<string>();
  // the conditions of accepted stages that stay in force count for the coverage
  for (const [s, ids] of book.stages) {
    if (s >= firstStage) continue;
    for (const id of ids) if (!open.has(id) && !dropped.has(id)) for (const r of book.defs.get(id)?.covers ?? []) covered.add(r);
  }
  stages.forEach((st, i) => {
    const n = firstStage + i;
    if (st.conditions.length < 1 || st.conditions.length > 12) out.push(`stage ${n}: 1..12 conditions`);
    for (const c of st.conditions) {
      if ("keep" in c) {
        if (!allowed.has(c.keep)) out.push(`stage ${n}: keep ${c.keep} is not a condition still to be met`);
        else if (kept.has(c.keep)) out.push(`stage ${n}: ${c.keep} is kept twice`);
        else if (dropped.has(c.keep)) out.push(`stage ${n}: ${c.keep} is both kept and dropped`);
        else { kept.add(c.keep); for (const r of book.defs.get(c.keep)!.covers) covered.add(r); }
        continue;
      }
      if (c.text.trim() === "") out.push(`stage ${n}: a condition without text`);
      if (new Set(c.covers).size !== c.covers.length) out.push(`stage ${n}: a requirement repeated in covers`);
      for (const r of c.covers) {
        if (!reqs.has(r)) out.push(`stage ${n}: covers ${r}, which is not a requirement (R1..R${criteria})`);
        else covered.add(r);
      }
      if (c.evidence.kind === "check" && !checkIds.includes(c.evidence.check)) {
        out.push(`stage ${n}: evidence check ${c.evidence.check} is not one of the check commands (${checkIds.join(", ") || "none"})`);
      }
    }
  });
  for (const id of open) if (!kept.has(id) && !dropped.has(id)) out.push(`${id} ${returned !== "any" && returned.has(id) ? "(returned by the final review)" : "of the plan in force"} is neither kept nor dropped`);
  for (const r of reqs) if (!book.droppedRequirements.has(r) && !dropReqs.has(r) && !covered.has(r)) out.push(`${r} is covered by no condition`);
  return out;
}

// The lead's flat answer as the plan's conditions; a problem of its shape is reported, not thrown.
export function reportConditions(report: PlanReportV2): { stages: { conditions: (Omit<ConditionDef, "id"> | { keep: string })[] }[]; problems: string[] } {
  const problems: string[] = [];
  const stages = report.stages.map((st, i) => ({
    conditions: st.conditions.flatMap((c): (Omit<ConditionDef, "id"> | { keep: string })[] => {
      if (c.keep !== null) {
        if (c.text !== null || c.covers !== null || c.evidence !== null) problems.push(`stage ${i + 1}: keep ${c.keep} with text, covers or evidence`);
        return [{ keep: c.keep }];
      }
      if (c.text === null || c.covers === null || c.evidence === null) { problems.push(`stage ${i + 1}: a new condition needs text, covers and evidence`); return []; }
      if ((c.evidence.kind === "check") !== (c.evidence.check !== null)) { problems.push(`stage ${i + 1}: evidence check names a command exactly for kind check`); return []; }
      return [{ text: c.text.trim(), covers: c.covers, evidence: c.evidence.kind === "check" ? { kind: "check", check: c.evidence.check! } : { kind: c.evidence.kind } }];
    })
  }));
  return { stages, problems };
}

// The recorded text of a valid plan: new conditions numbered from the book's next number (5h §2.3).
export function numberPlan(report: PlanReportV2, stages: ReturnType<typeof reportConditions>["stages"], next: number): { text: PlanText; assigned: number } {
  let n = next;
  const text: PlanText = {
    stages: report.stages.map((s, i) => ({
      title: s.title, task: s.task,
      conditions: stages[i].conditions.map((c): PlanCondition => ("keep" in c ? { keep: c.keep } : { id: `C${n++}`, ...c }))
    })),
    dropped: report.dropped.map(({ condition, why }) => ({ condition, why })),
    dropRequirements: report.dropRequirements.map(({ requirement, why }) => ({ requirement, why })), question: null
  };
  return { text, assigned: n - next };
}

// Stage A gate (2026-10-03): a mark of a condition no review decides — a check condition (met only by its command) or a
// person condition (only by the person) — is extra. It is never counted (factsOf reads such a condition from its command
// or the person) and not a reason to refuse the report: it is left out before the rules below and named in the feed.
export function ignoredMarks(marks: readonly ConditionMark[], book: ConditionsBook): { id: string; by: "check" | "person" }[] {
  return marks.flatMap((m) => {
    const kind = book.defs.get(m.id)?.evidence.kind;
    return kind === "check" || kind === "person" ? [{ id: m.id, by: kind }] : [];
  });
}
export const decidedMarks = (marks: readonly ConditionMark[], book: ConditionsBook): ConditionMark[] => {
  const extra = new Set(ignoredMarks(marks, book).map((x) => x.id));
  return marks.filter((m) => !extra.has(m.id));
};

// The lead's stage review (journal-v2-format.md §2.7): one mark for every "change" condition of the stage, none else;
// met with paths the work changed since the start of the run (a limiter, not proof). changed: null — not known here.
export function stageMarksProblems(marks: readonly ConditionMark[], changeIds: readonly string[], changed: ReadonlySet<string> | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    if (!changeIds.includes(m.id)) { out.push(`${m.id} is not a change condition of this stage (${changeIds.join(", ") || "none"})`); continue; }
    if (seen.has(m.id)) out.push(`${m.id} is marked twice`);
    seen.add(m.id);
    if (m.status === "met" && m.paths.length === 0) out.push(`${m.id} met without paths`);
    // a met mark stands on the changed files it names; a file it names besides them that did not change is extra (left
    // out, said in the feed: unchangedPaths), but a mark with no changed file at all has no evidence
    if (m.status === "met" && changed && m.paths.length && m.paths.every((p) => !changed.has(p))) out.push(`${m.id}: none of ${m.paths.join(", ")} changed since the start of the run`);
  }
  for (const id of changeIds) if (!seen.has(id)) out.push(`${id} is not marked`);
  return out;
}
// The files a met mark names that did not change since the start of the run, next to ones that did: not its evidence.
export const unchangedPaths = (marks: readonly ConditionMark[], changed: ReadonlySet<string>): { id: string; paths: string[] }[] =>
  marks.flatMap((m) => {
    const extra = m.status === "met" ? m.paths.filter((p) => !changed.has(p)) : [];
    return extra.length && extra.length < m.paths.length ? [{ id: m.id, paths: extra }] : [];
  });
// A4: a requirement the person dropped is not in force (journal-v2-format.md §2.9). Stage A gate: a mark of it is extra —
// never counted (factsOf: dropped) and not a reason to refuse the report.
export function finalMarksProblems(marks: readonly RequirementMark[], criteria: number, dropped: ReadonlyMap<string, unknown> | ReadonlySet<string> = new Set()): string[] {
  const ids = requirementIds(criteria).filter((r) => !dropped.has(r));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    if (dropped.has(m.id)) continue;
    if (!ids.includes(m.id)) out.push(`${m.id} is not a requirement (R1..R${criteria})`);
    else if (seen.has(m.id)) out.push(`${m.id} is marked twice`);
    seen.add(m.id);
  }
  for (const id of ids) if (!seen.has(id)) out.push(`${id} is not marked`);
  return out;
}

export const changeIdsOf = (book: ConditionsBook, stage: number): string[] =>
  (book.stages.get(stage) ?? []).filter((id) => book.defs.get(id)?.evidence.kind === "change");
export const personIdsOf = (book: ConditionsBook, stage: number): string[] =>
  (book.stages.get(stage) ?? []).filter((id) => book.defs.get(id)?.evidence.kind === "person");

// Status of every condition in force and of every requirement. checkPassed(cmd): the command's latest result passed on
// the tree the decision is about (a stale one does not count); stageMarks(stage): the marks of the review its stage was
// accepted on (null: not accepted); finalMarks: the last final review's answer (null: none).
// dropped (A4): a requirement the person dropped (plan.decided) — never "met", and never a blocker.
export type Status = "met" | "not_met" | "not_checked" | "dropped";
export interface ConditionFacts {
  // stale (A4, 5h §3.7): change evidence of an accepted stage whose paths changed since its checkpoint — it counts only
  // as the final review confirms it
  conditions: { id: string; stage: number; status: Status; stale?: true }[];
  requirements: { id: string; conditions: string[]; status: Status }[];
}
export function factsOf(book: ConditionsBook, criteria: number, input: {
  check(cmd: string): Status;
  marks(stage: number): readonly ConditionMark[] | null; // the review that decides the stage (the accepting one, or the latest)
  finalMarks: readonly RequirementMark[] | null;
  person?(id: string, stage: number): Status; // A4: the person's decision in force (5h §3.5)
  stale?(id: string, stage: number): boolean; // A4: 5h §3.7
  confirmed?(id: string): Status | null; // A4: the fresh final review's mark of a stale condition
}): ConditionFacts {
  const conditions: ConditionFacts["conditions"] = [];
  for (const [stage, ids] of [...book.stages.entries()].sort((a, b) => a[0] - b[0])) {
    for (const id of ids) {
      const d = book.defs.get(id)!;
      let status: Status;
      let stale = false;
      if (d.evidence.kind === "check") status = input.check(d.evidence.check);
      else if (d.evidence.kind === "person") status = input.person?.(id, stage) ?? "not_checked";
      else {
        const m = input.marks(stage)?.find((x) => x.id === id);
        status = m ? m.status : "not_checked";
        stale = status === "met" && !!input.stale?.(id, stage);
        if (stale) status = input.confirmed?.(id) ?? "not_checked";
      }
      conditions.push({ id, stage, status, ...(stale ? { stale: true as const } : {}) });
    }
  }
  const requirements = requirementIds(criteria).map((r) => {
    const own = conditions.filter((c) => book.defs.get(c.id)!.covers.includes(r));
    const final = input.finalMarks?.find((m) => m.id === r)?.status ?? null;
    // met: proven by a met condition and confirmed by the final review; not yet asked: not checked; dropped by the person
    const status: Status = book.droppedRequirements.has(r) ? "dropped" : final === "not_met" || own.length === 0 ? "not_met"
      : final === "met" ? (own.some((c) => c.status === "met") ? "met" : "not_met") : "not_checked";
    return { id: r, conditions: own.map((c) => c.id), status };
  });
  return { conditions, requirements };
}

export type ConditionBlocker = "condition_unmet" | "requirement_unmet";
// The completion function's condition part (journal-v2-format.md §2.3, §2.7).
export function conditionBlockers(f: ConditionFacts | null): ConditionBlocker[] {
  if (!f) return [];
  const out: ConditionBlocker[] = [];
  if (f.conditions.some((c) => c.status !== "met")) out.push("condition_unmet");
  if (f.requirements.some((r) => r.status !== "met" && r.status !== "dropped")) out.push("requirement_unmet");
  return out;
}
