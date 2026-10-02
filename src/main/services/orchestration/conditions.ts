// Requirements and readiness conditions of a journal v2 run (A2: journal-v2-format.md §2.7; acceptance-review-spec.md
// §1, §2.3, §3.3 p. 1–2). Pure functions of the plan texts, the lead's review answers and the journal state: the service
// uses them to check a plan and a review before writing it, the cycle and the completion function to decide, the store
// to check the texts of a journal (its second stage of reading), and the run view to show them.
//
// R<n> is the n-th criterion of the goal: the person's, never changed. C<n> is numbered by the application, in the order
// conditions first appear in the plans; its text, covers and evidence never change. Nothing here is written to the
// journal: every fact is derived from texts the hash chain already fixes.

export type Evidence = { kind: "check"; check: string } | { kind: "change" };
export interface ConditionDef { id: string; text: string; covers: string[]; evidence: Evidence }
// a condition of a recorded plan: a new one with its number, or one carried over from the plan in force
export type PlanCondition = ConditionDef | { keep: string };
export interface PlanText {
  stages: { title: string; task: string; conditions?: PlanCondition[] }[];
  dropped?: unknown[]; dropRequirements?: unknown[]; question: string | null;
}
// a condition as the lead answers it (the answer schema has no anyOf: one flat object, journal-v2-format.md §2.7)
export interface ReportCondition {
  keep: string | null; text: string | null; covers: string[] | null;
  evidence: { kind: "check" | "change"; check: string | null } | null;
}
export interface PlanReportV2 {
  stages: { title: string; task: string; conditions: ReportCondition[] }[];
  dropped: unknown[]; dropRequirements: unknown[]; question: string | null;
}
// the lead's review answer of a journal formatPreview (A1–A2: the lead reviews)
export interface ConditionMark { id: string; status: "met" | "not_met"; paths: string[]; note: string }
export interface RequirementMark { id: string; status: "met" | "not_met"; note: string }

// One recorded plan: where its stages start, its text, and how many numbers it took (absent: a plan of A1's form).
export interface RecordedPlan { firstStage: number; text: PlanText; conditionsAssigned: number | null }

// What the plans say now: every condition ever defined, the conditions of each stage in force (the accepted stages keep
// those of the plan they were accepted under; the rest are the current plan's), and the next free number.
export interface ConditionsBook {
  defs: Map<string, ConditionDef>;
  stages: Map<number, string[]>;
  next: number;
  conditioned: boolean; // the plan in force has conditions (A2's form); otherwise no condition rule applies (§2.7)
}

export const emptyBook = (): ConditionsBook => ({ defs: new Map(), stages: new Map(), next: 1, conditioned: false });

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
  let fresh = 0;
  p.text.stages.forEach((stage, i) => {
    const ids = (stage.conditions ?? []).map((c) => {
      if (isKeep(c)) {
        if (!book.defs.has(c.keep)) throw new Error(`${c.keep} is carried over but never defined`);
        return c.keep;
      }
      if (c.id !== `C${book.next + fresh}`) throw new Error(`${c.id} is not the next condition number C${book.next + fresh}`);
      fresh++;
      book.defs.set(c.id, { id: c.id, text: c.text, covers: [...c.covers], evidence: c.evidence });
      return c.id;
    });
    book.stages.set(p.firstStage + i, ids);
  });
  if (p.conditionsAssigned === null ? fresh !== 0 : fresh !== p.conditionsAssigned) {
    throw new Error(`the plan numbers ${fresh} new conditions, its record says ${p.conditionsAssigned ?? "none"}`);
  }
  book.next += fresh;
  book.conditioned = p.conditionsAssigned !== null;
}

const reqId = (n: number) => `R${n}`;
export const requirementIds = (criteria: number): string[] => Array.from({ length: criteria }, (_, i) => reqId(i + 1));

// The plan's rules (5h §2.3 with the A2 limits of §2.7), against the book before it; [] = valid. firstStage: the first
// stage this plan replaces (the stages before it are accepted). checkIds: the commands a "check" condition may name.
export function planProblems(stages: readonly { conditions: readonly (Omit<ConditionDef, "id"> | { keep: string })[] }[],
  extra: { dropped: readonly unknown[]; dropRequirements: readonly unknown[] }, book: ConditionsBook, firstStage: number,
  criteria: number, checkIds: readonly string[]): string[] {
  const out: string[] = [];
  if (extra.dropped.length) out.push("dropped must be empty: dropping a condition is the person's decision (not available yet)");
  if (extra.dropRequirements.length) out.push("dropRequirements must be empty: dropping a requirement is the person's decision (not available yet)");
  const open = new Set<string>(); // conditions of the stages this plan replaces
  const kept = new Set<string>();
  const covered = new Set<string>();
  for (const [s, ids] of book.stages) {
    for (const id of ids) {
      if (s >= firstStage) open.add(id);
      else for (const r of book.defs.get(id)?.covers ?? []) covered.add(r);
    }
  }
  const reqs = new Set(requirementIds(criteria));
  stages.forEach((st, i) => {
    const n = firstStage + i;
    if (st.conditions.length < 1 || st.conditions.length > 12) out.push(`stage ${n}: 1..12 conditions`);
    for (const c of st.conditions) {
      if ("keep" in c) {
        if (!open.has(c.keep)) out.push(`stage ${n}: keep ${c.keep} is not a condition still to be met`);
        else if (kept.has(c.keep)) out.push(`stage ${n}: ${c.keep} is kept twice`);
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
  for (const id of open) if (!kept.has(id)) out.push(`${id} of the plan in force is neither kept nor dropped`);
  for (const r of reqs) if (!covered.has(r)) out.push(`${r} is covered by no condition`);
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
      return [{ text: c.text.trim(), covers: c.covers, evidence: c.evidence.kind === "check" ? { kind: "check", check: c.evidence.check! } : { kind: "change" } }];
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
    dropped: [], dropRequirements: [], question: null
  };
  return { text, assigned: n - next };
}

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
    if (m.status === "met" && changed) for (const p of m.paths) if (!changed.has(p)) out.push(`${m.id}: ${p} is not changed since the start of the run`);
  }
  for (const id of changeIds) if (!seen.has(id)) out.push(`${id} is not marked`);
  return out;
}
export function finalMarksProblems(marks: readonly RequirementMark[], criteria: number): string[] {
  const ids = requirementIds(criteria);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of marks) {
    if (!ids.includes(m.id)) out.push(`${m.id} is not a requirement (R1..R${criteria})`);
    else if (seen.has(m.id)) out.push(`${m.id} is marked twice`);
    seen.add(m.id);
  }
  for (const id of ids) if (!seen.has(id)) out.push(`${id} is not marked`);
  return out;
}

export const changeIdsOf = (book: ConditionsBook, stage: number): string[] =>
  (book.stages.get(stage) ?? []).filter((id) => book.defs.get(id)?.evidence.kind === "change");

// Status of every condition in force and of every requirement. checkPassed(cmd): the command's latest result passed on
// the tree the decision is about (a stale one does not count); stageMarks(stage): the marks of the review its stage was
// accepted on (null: not accepted); finalMarks: the last final review's answer (null: none).
export type Status = "met" | "not_met" | "not_checked";
export interface ConditionFacts {
  conditions: { id: string; stage: number; status: Status }[];
  requirements: { id: string; conditions: string[]; status: Status }[];
}
export function factsOf(book: ConditionsBook, criteria: number, input: {
  check(cmd: string): Status;
  marks(stage: number): readonly ConditionMark[] | null; // the review that decides the stage (the accepting one, or the latest)
  finalMarks: readonly RequirementMark[] | null;
}): ConditionFacts {
  const conditions: ConditionFacts["conditions"] = [];
  for (const [stage, ids] of [...book.stages.entries()].sort((a, b) => a[0] - b[0])) {
    for (const id of ids) {
      const d = book.defs.get(id)!;
      let status: Status;
      if (d.evidence.kind === "check") status = input.check(d.evidence.check);
      else {
        const m = input.marks(stage)?.find((x) => x.id === id);
        status = m ? m.status : "not_checked";
      }
      conditions.push({ id, stage, status });
    }
  }
  const requirements = requirementIds(criteria).map((r) => {
    const own = conditions.filter((c) => book.defs.get(c.id)!.covers.includes(r));
    const final = input.finalMarks?.find((m) => m.id === r)?.status ?? null;
    // met: proven by a met condition and confirmed by the final review; not yet asked: not checked
    const status: Status = final === "not_met" || own.length === 0 ? "not_met"
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
  if (f.requirements.some((r) => r.status !== "met")) out.push("requirement_unmet");
  return out;
}
