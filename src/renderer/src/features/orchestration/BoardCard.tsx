// B2: the task board on the canvas (stage-b-board.md §6). One card per workspace, moved and resized as an agent card
// is. Its columns and every line of a task card come from the shared status (boardStatuses) and the same display rules
// as the agent cards (runStatus); the board only sends what the person asked for — main checks every rule.
import { useState } from "react";
import type { LocaleId, SessionBounds } from "../../../../shared/contracts";
import type { OrchestrationAgentLink } from "../../../../shared/orchestration";
import type { BoardTask, TaskColumn } from "../../../../shared/taskBoard";
import { t } from "../../lib/i18n";
import { Dialog } from "./OrchestrationDialogs";
import { ACTIVE_STATUSES } from "./runModel";
import { taskLine, tr } from "./boardModel";
import { conditionsLine, costLine, findingsLine } from "./runStatus";
import type { AgentCanvasUi } from "./useAgentCanvasUi";
import type { Board } from "./useBoard";
import { RESIZE_DIRECTIONS, useCardFrame } from "./useCardFrame";
import type { Orchestration } from "./useOrchestration";

export const BOARD_SIZE = { width: 1040, height: 560 };
const LIMITS = { min: { width: 560, height: 320 }, max: { width: 4000, height: 3000 } };
const COLUMNS: TaskColumn[] = ["queue", "work", "review", "done"];

export interface BoardCardProps {
  board: Board;
  orch: Orchestration; // this workspace's agents and links (the scene's)
  ui: AgentCanvasUi;
  locale: LocaleId;
  workspaceId: string;
  bounds: SessionBounds;
  zoom: number;
  stackIndex: number;
  selected: boolean;
  snapEnabled: boolean;
  snapTargets: readonly SessionBounds[];
  defaultProject: string | null;
  onBoundsChange(bounds: SessionBounds): void;
  onHide(): void;
}

export function BoardCard(props: BoardCardProps): React.JSX.Element {
  const { board, orch, ui, locale, workspaceId } = props;
  const frame = useCardFrame({ bounds: props.bounds, zoom: props.zoom, snapEnabled: props.snapEnabled, snapTargets: props.snapTargets, limits: LIMITS,
    onMoved: props.onBoundsChange, onResized: props.onBoundsChange });
  const { position, size } = frame.bounds;
  const [showArchive, setShowArchive] = useState(false);
  const [form, setForm] = useState<{ task: BoardTask | null } | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ taskId: string | null; text: string } | null>(null);
  const view = board.view;
  const readOnly = !!view?.readOnly;
  const tasks = (view?.board.tasks ?? []).filter((x) => x.workspaceId === workspaceId);
  const keyOf = (id: string) => tasks.find((x) => x.id === id)?.key ?? "?";
  const keysOf = (ids: string[]) => ids.map(keyOf).join(", ");
  const shown = tasks.filter((x) => (showArchive ? x.archivedAt : !x.archivedAt));
  const leadOf = (l: OrchestrationAgentLink) => orch.canvas.agents.find((a) => a.agentId === l.fromAgentId);
  const busy = (l: OrchestrationAgentLink) => {
    const v = l.runIds.length ? orch.runs[l.runIds.at(-1)!]?.view : undefined;
    return !!v && (ACTIVE_STATUSES.includes(v.status) || !!v.newer);
  };
  const say = (taskId: string | null, text: string) => {
    setMessage({ taskId, text });
    window.setTimeout(() => setMessage((m) => (m?.text === text ? null : m)), 8000);
  };
  const failure = (r: { ok: boolean; code?: string; message?: string }) => (r.ok ? null : tr(locale, `orchError_${r.code}`) || r.message || String(r.code));
  // «Start»: the goal dialog of a free link of the task's folder, with the task's text, requirements and goal.task
  const start = (task: BoardTask) => {
    const links = orch.canvas.links.filter((l) => leadOf(l)?.project === task.project);
    const link = links.find((l) => !busy(l));
    if (!link) { say(task.id, tr(locale, "boardNoLink", { project: task.project })); return; }
    ui.openGoal(link.linkId, { id: task.id, key: task.key, title: task.title, text: task.text, criteria: task.criteria });
  };
  const projects = [...new Set([...orch.canvas.agents.map((a) => a.project), ...(props.defaultProject ? [props.defaultProject] : [])])];

  return (
    <article className={`board-card ${props.selected ? "board-card--selected" : ""}`} data-interactive="true" data-board={workspaceId}
      data-canvas-layer-id={`board:${workspaceId}`} aria-label={t(locale, "boardTitle")}
      style={{ zIndex: props.stackIndex, width: size.width, height: size.height, transform: `translate(${position.x}px, ${position.y}px)` }}>
      <header className="board-card__header" {...frame.header}>
        <strong>{t(locale, "boardTitle")}</strong>
        {readOnly && <span className="board-card__readonly" role="status">{t(locale, "boardReadOnly")}</span>}
        <span className="board-card__header-actions">
          <button type="button" data-board-new disabled={readOnly} onClick={() => setForm({ task: null })}>{t(locale, "boardNewTask")}</button>
          <button type="button" data-board-archive-toggle aria-pressed={showArchive} onClick={() => setShowArchive((v) => !v)}>
            {t(locale, showArchive ? "boardHideArchive" : "boardShowArchive")}</button>
          <button type="button" className="board-card__hide" data-board-hide title={t(locale, "boardHide")} aria-label={t(locale, "boardHide")} onClick={props.onHide}>×</button>
        </span>
      </header>
      {board.failed && !view && <p className="board-card__message" role="alert">{t(locale, "boardLoadFailed")} ({board.failed})</p>}
      {message && !message.taskId && <p className="board-card__message" role="alert">{message.text}</p>}
      {view && tasks.length === 0 && <p className="board-card__empty" data-board-empty>{t(locale, "boardEmpty")}</p>}
      <div className="board-card__columns" data-wheel-owner="local">
        {COLUMNS.map((column) => {
          const items = shown.filter((x) => (showArchive ? column === "queue" : board.statuses.get(x.id)?.column === column))
            .sort((a, b) => a.order - b.order);
          return (
            <section key={column} className={`board-card__column board-card__column--${column}`} data-board-column={column} aria-label={t(locale, `boardCol_${column}`)}>
              <h3>{showArchive && column === "queue" ? t(locale, "boardArchived") : t(locale, `boardCol_${column}`)} <span data-board-count>{items.length}</span></h3>
              <ul className="board-card__list">
                {items.length === 0 && <li className="board-card__column-empty">{t(locale, "boardColumnEmpty")}</li>}
                {items.map((task) => {
                  const st = board.statuses.get(task.id)!;
                  const runId = st.current;
                  const run = runId ? orch.runs[runId] : undefined;
                  const entries = runId ? orch.activity[runId]?.entries ?? [] : [];
                  const fact = runId ? view?.facts.find((f) => f.runId === runId) : undefined;
                  const base = taskLine(locale, st, run ? { view: run.view, entries, open: run.open } : null, fact?.limit ?? null);
                  // what is asked, in the request's own words (answered in the run panel: one home for answers)
                  const asked = st.reason === "waits_permission" ? run?.view.permission?.summary : null;
                  const line = asked ? `${base}: ${asked}` : base;
                  // without checks, the conditions are met by the agents' word only
                  const met = run ? conditionsLine(locale, run.view) : null;
                  const facts = [met && (st.completion === "no_checks" ? `${met} (${t(locale, "boardByAgents")})` : met), run && findingsLine(locale, run.view),
                    st.attempts > 0 && tr(locale, "boardAttempt", { n: st.attempts })].filter(Boolean).join(" · ");
                  // the tasks that go on once this one is accepted
                  const next = tasks.filter((x) => !x.archivedAt && x.dependsOn.includes(task.id)).map((x) => x.key);
                  const cost = run ? costLine(locale, "executor", run.view, entries) : null;
                  // «after T-2» while T-2 is not done and the line does not say so already
                  const open = task.dependsOn.filter((d) => !board.statuses.get(d)?.done);
                  const after = open.length && st.reason !== "waits_task" ? tr(locale, "boardAfter", { keys: keysOf(open) }) : null;
                  const archived = !!task.archivedAt;
                  return (
                    <li key={task.id} className={`board-task board-task--${st.column}${st.done ? ` board-task--done-${st.done}` : ""}`}
                      data-board-task={task.key} data-board-task-column={st.column} data-board-done={st.done ?? undefined} data-board-reason={st.reason ?? undefined}>
                      <button type="button" className="board-task__title" aria-label={`${task.key} ${task.title}. ${line}`}
                        onClick={() => (runId ? ui.openRunById(runId) : setForm({ task }))} title={task.title}>
                        <span className="board-task__key">{task.key}</span> {task.title}
                      </button>
                      <div className="board-task__line" data-board-line title={line}>
                        {st.done && <span className={`board-task__badge board-task__badge--${st.done}`} aria-hidden="true">{st.done === "confirmed" ? "✓" : "✋"}</span>}
                        <span data-board-line-text>{line}</span>
                      </div>
                      {facts && <div className="board-task__line board-task__facts" title={facts}>{facts}</div>}
                      {after && <div className="board-task__line" data-board-after title={after}>{after}</div>}
                      {run && <div className="board-task__line" data-board-executor title={cost ?? undefined}>{tr(locale, "boardExecutor", { who: "Claude" })}{cost ? ` · ${cost}` : ""}</div>}
                      {message?.taskId === task.id && <div className="board-task__message" role="alert">{message.text}</div>}
                      {accepting === task.id && (
                        <div className="board-task__confirm" role="alertdialog" aria-label={t(locale, "boardAccept")} data-board-accept-confirm>
                          <p>{t(locale, "boardAcceptWhy")}{next.length ? ` ${tr(locale, "boardAcceptNext", { keys: next.join(", ") })}` : ""}</p>
                          <button type="button" className="orch-primary" data-board-accept-yes onClick={async () => {
                            setAccepting(null);
                            const r = await board.accept(task.id);
                            const f = failure(r);
                            if (f) say(task.id, f);
                          }}>{t(locale, "boardAcceptConfirm")}</button>
                          <button type="button" onClick={() => setAccepting(null)}>{t(locale, "orchCancel")}</button>
                        </div>
                      )}
                      {!readOnly && accepting !== task.id && (
                        <div className="board-task__actions">
                          {archived ? (
                            <button type="button" data-board-unarchive onClick={() => void board.archive(task.id, false)}>{t(locale, "boardUnarchive")}</button>
                          ) : (
                            <>
                              {(st.column === "queue" || st.reason === "no_checks") && !st.reason?.startsWith("waits_") && st.reason !== "run_newer" && (
                                <button type="button" data-board-start onClick={() => start(task)}>{t(locale, st.attempts ? "boardStartAgain" : "boardStart")}</button>
                              )}
                              {runId && st.reason === "waits_permission"
                                ? <button type="button" className="orch-primary" data-board-open data-board-answer onClick={() => ui.openRunById(runId)}>{t(locale, "boardAnswer")}</button>
                                : runId && <button type="button" data-board-open onClick={() => ui.openRunById(runId)}>{t(locale, "orchOpenRun")}</button>}
                              {st.reason === "no_checks" && <button type="button" className="orch-primary" data-board-accept onClick={() => setAccepting(task.id)}>{t(locale, "boardAccept")}</button>}
                              {(st.column === "queue" || st.column === "done") && <button type="button" data-board-edit onClick={() => setForm({ task })}>{t(locale, "boardEdit")}</button>}
                              {(st.column === "queue" || st.column === "done") && <button type="button" data-board-archive onClick={() => void board.archive(task.id, true)}>{t(locale, "boardArchive")}</button>}
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {RESIZE_DIRECTIONS.map((direction) => (
        <div key={direction} className={`terminal-card__resize-handle terminal-card__resize-handle--${direction}`} aria-hidden="true" data-board-resize={direction}
          {...frame.handle(direction)} />
      ))}
      {form && (
        <TaskForm locale={locale} task={form.task} tasks={tasks.filter((x) => !x.archivedAt)} projects={projects}
          onClose={() => setForm(null)}
          onSave={async (input) => {
            const r = form.task ? await board.update(form.task.id, { title: input.title, text: input.text, criteria: input.criteria, dependsOn: input.dependsOn })
              : await board.create({ workspaceId, ...input });
            const f = failure(r);
            if (!f) setForm(null);
            return f;
          }}
          onDelete={form.task && !(board.statuses.get(form.task.id)?.attempts) ? async () => {
            const f = failure(await board.remove(form.task!.id));
            if (!f) setForm(null);
            return f;
          } : undefined} />
      )}
    </article>
  );
}

// «New task» / «Edit task»: the goal's fields without a start (§6). main checks the rest (lengths, cycles, the folder).
function TaskForm({ locale, task, tasks, projects, onClose, onSave, onDelete }: {
  locale: LocaleId; task: BoardTask | null; tasks: BoardTask[]; projects: string[]; onClose(): void;
  onSave(input: { project: string; title: string; text: string; criteria: string[]; dependsOn: string[] }): Promise<string | null>;
  onDelete?: () => Promise<string | null>;
}): React.JSX.Element {
  const [title, setTitle] = useState(task?.title ?? "");
  const [text, setText] = useState(task?.text ?? "");
  const [criteria, setCriteria] = useState(task?.criteria.join("\n") ?? "");
  const [project, setProject] = useState(task?.project ?? projects[0] ?? "");
  const [depends, setDepends] = useState<string[]>(task?.dependsOn ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lines = criteria.split("\n").map((c) => c.trim()).filter(Boolean);
  const complete = title.trim() && text.trim() && lines.length > 0 && project.trim();
  const others = tasks.filter((x) => x.id !== task?.id);
  return (
    <Dialog label={t(locale, task ? "boardEditTask" : "boardNewTask")} onClose={onClose} locale={locale}>
      <form className="orch-form" data-board-form onSubmit={async (event) => {
        event.preventDefault();
        if (!complete) return;
        setBusy(true);
        setError(await onSave({ project: project.trim(), title: title.trim(), text: text.trim(), criteria: lines, dependsOn: depends }));
        setBusy(false);
      }}>
        {task && <div className="orch-field orch-field--static"><span>{t(locale, "boardTask")}</span><strong>{task.key}</strong></div>}
        <label className="orch-field"><span>{t(locale, "boardFieldTitle")}</span>
          <input data-board-field="title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus /></label>
        <label className="orch-field"><span>{t(locale, "boardFieldText")}</span>
          <textarea data-board-field="text" value={text} maxLength={8000} rows={4} onChange={(e) => setText(e.target.value)} /></label>
        <label className="orch-field"><span>{t(locale, "boardFieldCriteria")}</span>
          <textarea data-board-field="criteria" value={criteria} rows={3} onChange={(e) => setCriteria(e.target.value)} /></label>
        <label className="orch-field"><span>{t(locale, "boardFieldProject")}</span>
          <input data-board-field="project" value={project} list="board-projects" disabled={!!task} onChange={(e) => setProject(e.target.value)} />
          <datalist id="board-projects">{projects.map((p) => <option key={p} value={p} />)}</datalist></label>
        {(
          <fieldset className="orch-field board-form__depends"><legend>{t(locale, "boardFieldDepends")}</legend>
            {others.length === 0 && <small className="orch-hint">{t(locale, "boardNoOtherTasks")}</small>}
            {others.map((x) => (
              <label key={x.id}><input type="checkbox" data-board-depends={x.key} checked={depends.includes(x.id)}
                onChange={(e) => setDepends((d) => (e.target.checked ? [...d, x.id] : d.filter((y) => y !== x.id)))} /> {x.key} · {x.title}</label>
            ))}
          </fieldset>
        )}
        {error && <p className="orch-error" role="alert">{error}</p>}
        <div className="orch-actions">
          {onDelete && <button type="button" className="orch-danger" data-board-delete onClick={async () => setError(await onDelete())}>{t(locale, "boardDelete")}</button>}
          <button type="button" onClick={onClose}>{t(locale, "orchCancel")}</button>
          <button type="submit" className="orch-primary" data-board-save disabled={!complete || busy}>{t(locale, "boardSave")}</button>
        </div>
      </form>
    </Dialog>
  );
}
