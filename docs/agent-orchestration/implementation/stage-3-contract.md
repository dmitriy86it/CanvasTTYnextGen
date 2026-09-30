# Этап реализации 3 (Р3): рабочая копия, baseline, снимки и checkpoint

Обозначения: Р3 = первая часть строки 4 таблицы этапов ROADMAP (рабочая копия и снимки); runner проверок — Р4. Владелец документа — координатор.

Основание: ARCHITECTURE-PROPOSAL §3.2 и правила вызова Git (§3.1, строка «Git вызывается только так»), эксперименты G1–G9 (VALIDATION-MATRIX), контракты Р1/Р2. Модуль main-процесса, пути передаются параметрами; процессов агентов не запускает; к старту приложения не подключён. Только временные репозитории в тестах.

## Владение файлами

| Участник | Файлы |
|---|---|
| workspace-core | `src/main/services/orchestration/git.ts` (безопасный вызов Git), `src/main/services/orchestration/workspace.ts` (проверка исходного репо, создание и открытие копии, baseline, проверка устройства, примитивы снимков и восстановления) |
| workspace-tests | `tests/orchestration-workspace.test.mjs`, `tests/fixtures/orchestration/git-fixtures.mjs` |
| координатор | этот документ; `src/main/services/orchestration/snapshots.ts` (recovery/промежуточные снимки, checkpoint, восстановление копии); события в `journal.ts`/`store.ts`; `tests/orchestration-snapshots.test.mjs`, `tests/orchestration-workspace-store.test.mjs`; `index.ts`; `docs/**` |

## Решение: управляющий репозиторий `control.git`

Архитектура §3.2 создаёт копию `clone --shared`, а config копии «создаёт оркестратор и сверяет fingerprint». Но `.git` копии доступен агенту на запись: filter-драйвер в его config вместе с `.gitattributes` в дереве исполняет команду при `add`/`checkout`, и сверка это обнаружит только после факта. Поэтому:

- **Все Git-операции оркестратора** (baseline, снимки, checkpoint, восстановление) выполняются с `GIT_DIR=<run>/workspace/control.git` — bare-репозиторий, созданный оркестратором: свой config (без filter/diff-драйверов, `core.autocrlf=false`, `gc.auto=0`), `objects/info/alternates` → объекты исходного репо, `info/exclude` — копия `info/exclude` исходного репо на момент создания. Рабочее дерево и индекс задаются явно (`GIT_WORK_TREE`, временный `GIT_INDEX_FILE`).
- **`.git` копии** (`clone --shared --no-checkout`) остаётся агенту для его собственных `git status/diff/commit`. Оркестратор его не использует ни для чего, кроме однократного `checkout` baseline при создании (config в этот момент создан самим `clone`), и сверяет его fingerprint перед опасными операциями.
- **Исходный репо** оркестратор только читает (`rev-parse`, `ls-files`, `cat-file`, `for-each-ref`) и добавляет в него объекты и refs `refs/canvastty/<runId>/*` (`fetch` из `control.git` + создание ref «только если нет»). Индекс, дерево, HEAD и ветки не меняются.

## Безопасный вызов Git (`git.ts`)

- `execFile(gitPath, [...hardened, ...args])`, без shell; `gitPath` — абсолютный путь (параметр; `findGit(env)` — поиск в PATH).
- **Окружение с нуля:** `PATH=<каталог git>:/usr/bin:/bin`, `LANG=C`, `LC_ALL=C`, `HOME` и `XDG_CONFIG_HOME` = пустой служебный каталог run, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `GIT_ALLOW_PROTOCOL=file`, `GIT_ASKPASS=`, `SSH_ASKPASS=`, `GIT_SSH_COMMAND=false`, `GIT_PAGER=cat`, `GIT_EDITOR=false`; явные `GIT_DIR`, при необходимости `GIT_WORK_TREE`, `GIT_INDEX_FILE`; для `commit-tree` — фиксированные `GIT_AUTHOR_*`/`GIT_COMMITTER_*` (`CanvasTTY <canvastty@localhost>`). Discovery не используется никогда.
- **Флаги `-c`:** `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.untrackedCache=false`, `core.pager=cat`, `core.editor=false`, `core.askPass=`, `credential.helper=`, `core.sshCommand=false`, `diff.external=`, `core.alternateRefsCommand=`, `protocol.allow=never`, `protocol.file.allow=always`, `gc.auto=0`, `maintenance.auto=false`, `fetch.writeCommitGraph=false`.
- Таймаут (по умолчанию 30 с, SIGKILL) и лимит вывода (по умолчанию 16 МиБ stdout, 64 КиБ stderr в ошибке). Ошибки: `GitError {code: git_failed | git_timeout | git_output_limit | git_spawn, exitCode, stderr}`.
- **Исключение (единственное):** список неигнорируемых untracked файлов исходного репо для baseline (`ls-files --others --exclude-standard`) выполняется с глобальным config пользователя (`HOME=<userHome>`, без `GIT_CONFIG_GLOBAL=/dev/null`), чтобы игнор совпадал с `git status` пользователя (иначе файл вроде `.env`, игнорируемый только глобальным `core.excludesFile`, попал бы в копию). Команда не запускает filters/hooks; `core.fsmonitor=false` и `core.hooksPath=/dev/null` из командной строки перекрывают config. Без `userHome` глобальный игнор не учитывается (задокументировано). Проверяется тестом с фиктивным HOME, где `.gitconfig` задаёт fsmonitor/hook-скрипты.
- Флаги сами по себе безопасность не доказывают: каждый вектор (hook, fsmonitor, filter clean/smudge, `diff.external`, `core.alternateRefsCommand`, подмена `.git`/`commondir`) проверяется тестом со скриптом-маркером.

## Раскладка

```
<root>/runs/<runId>/workspace/workspace.json   маркер владения (JSON, см. ниже)
<root>/runs/<runId>/workspace/repo/            копия (clone --shared --no-checkout + checkout baseline)
<root>/runs/<runId>/workspace/control.git/     управляющий bare-репозиторий
<root>/runs/<runId>/workspace/tmp/             временные индексы, служебный HOME
```

`runs/<runId>` должен существовать (создаётся Store `createRun`), иначе `run_not_found`. `workspace.json`: `{v:1, runId, sourcePath, sourceGitDir, gitVersion, createdAt, controlFingerprint, copyGitFingerprint}` (realpath). Удаление run в Store удаляет и копию.

## Проверка исходного репо (до любых изменений)

| Условие | Результат |
|---|---|
| `<source>/.git` отсутствует | `not_a_repository` |
| `.git` — файл (linked worktree, submodule checkout) или bare-репо | `unsupported_repository` |
| `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, `rebase-apply/`, `BISECT_LOG`, `sequencer/` | `operation_in_progress` |
| Индекс с конфликтными стадиями | `operation_in_progress` |
| `.gitmodules` в индексе, в HEAD или как untracked-файл рабочего дерева, либо gitlink (`160000`) в индексе или HEAD | `submodules_unsupported` |
| `filter=lfs` в любом `.gitattributes` (индекс, рабочее дерево) или `info/attributes` | `lfs_unsupported` |
| Неигнорируемый untracked каталог с собственным `.git` (вложенный репо) | `nested_repository` |
| Нет первого коммита (HEAD не рождён) | **поддерживается**: baseline — коммит без родителя, `head: null` |

## Baseline

Содержимое = **рабочее дерево** для путей: отслеживаемые (из индекса исходного репо, `ls-files --cached`) ∪ неигнорируемые untracked (исключение выше). Удалённые из дерева отслеживаемые — отсутствуют. Частично staged файл — версия рабочего дерева (индекс в baseline не отражается). Игнорируемые, но отслеживаемые — включаются (они отслеживаются). Игнорируемые неотслеживаемые — не включаются. Symlink сохраняется как symlink. `.gitattributes` в дереве применяется Git (eol-нормализация при `text`), filter-драйверы не исполняются (в `control.git` их нет).

Порядок: временный индекс в `control.git` (`read-tree --empty`) → `update-index --add -z --stdin` для существующих путей (`GIT_WORK_TREE=<source>`) → `write-tree` → проверка отсутствия `160000` → `commit-tree` (родитель — HEAD, если есть; сообщение с trailer `CanvasTTY-Snapshot: <runId>:baseline`) → публикация в `refs/canvastty/<runId>/baseline` исходного репо.

## Публикация ref в исходном репо (create-only)

`publishRef(name, commit)`: (1) `rev-parse --verify -q <ref>^{commit}` в исходном: есть и совпадает → `exists_same`; есть и другое → **`ref_conflict`** (с найденным sha), ничего не меняется. (2) `fetch --no-tags --no-write-fetch-head <control.git> <control-ref>:refs/canvastty/<runId>/tmp-<uuid>` (объекты попадают в исходный репо под временным ref). (3) `update-ref <ref> <commit> 0000…` — создание только если ref отсутствует (атомарно). (4) `update-ref -d` временного ref. Существующий ref никогда не перезаписывается (fetch с fast-forward мог бы перезаписать — поэтому не fetch прямо в целевой ref). Сбой между (2) и (4) оставляет `tmp-*` ref — объекты защищены, чистится явно.

## Создание рабочей копии

`createWorkspace({root, runId, source, gitPath, userHome?})`:
1. Проверка исходного репо (таблица) — **до любых изменений**.
2. `mkdir` `workspace/` эксклюзивно; существует → `workspace_exists` (ничего не трогается; повторное обращение — только `openWorkspace`).
3. `control.git`: `init --bare`, свой config, alternates, `info/exclude`.
4. Baseline (выше) → `publishRef(baseline)`. `ref_conflict` для baseline → если дерево и родитель существующего baseline совпадают с новым — `exists_same` (тот же результат); иначе отказ `baseline_conflict`, каталог workspace удаляется (исходный репо не менялся, кроме уже существовавшего ref).
5. `clone --shared --no-checkout <source> repo` (hardened) → `checkout --detach <baseline>` в копии.
6. Fingerprints, `workspace.json` (tmp → fsync → rename). Только после этого копия считается созданной.
Сбой на шагах 3–6 — каталог `workspace/` удаляется; опубликованный baseline ref **остаётся** (не удаляется автоматически) и при повторе с неизменным исходным деревом переиспользуется как `exists_same`.

Git worktree как fallback **не** используется.

## Открытие и проверка устройства

`openWorkspace({root, runId, gitPath})`: маркер существует и `runId` совпадает (иначе `workspace_foreign`); `verifyWorkspace` перед каждой опасной операцией:
- `workspace/`, `repo/`, `control.git/` — реальные каталоги (`lstat`, не symlink), realpath внутри `runs/<runId>/workspace` → иначе `workspace_tampered`;
- fingerprint `control.git` (config, `objects/info/alternates`, `info/*`, список и содержимое `hooks/`, `HEAD`) = записанному → иначе `workspace_tampered`;
- `.git` копии — каталог (не файл/symlink), без `commondir`/`gitdir`, fingerprint (config, `objects/info/alternates`, `info/*`, `hooks/`) = записанному → иначе `copy_git_tampered` (архитектурный `paused(shared_git_tampered)`);
- исходный репо: `sourceGitDir` — тот же realpath.

Исправления восстановления по внешнему ревью (три исхода `applyRestore`, проверка состояния копии, применимая база снимка) — в [stage-3-review-fixes.md](stage-3-review-fixes.md); при расхождении верен он.

## Снимки (координатор, `snapshots.ts`)

| Вид | Ref | Где |
|---|---|---|
| baseline | `refs/canvastty/<runId>/baseline` | исходный репо (+ `control.git`) |
| checkpoint этапа `n` | `refs/canvastty/<runId>/stage-<n>` | исходный репо (+ `control.git`) |
| recovery-снимок | `refs/canvastty/<runId>/recovery-<k>` | исходный репо (+ `control.git`) |
| промежуточный | `refs/canvastty/snapshot/<id>` | только `control.git` |

Снимок копии: временный индекс `control.git` ← дерево базы (последний checkpoint или baseline) → `ls-files --others --exclude-standard` (игнор: `.gitignore` дерева копии + `info/exclude` из исходного; **глобальный игнор пользователя не применяется** — в снимок копии попадает больше, не меньше) → `update-index --add --remove` для изменённых/удалённых/новых путей → `write-tree` → `160000` → отказ `nested_repository` → `commit-tree`.

**Служебная ссылка зависимостей (исправление по серии Р6).** Единственное исключение из «все неигнорируемые untracked»: ссылка `node_modules` в корне копии, которую оркестратор создал для проверок Р4 (`linkDependencies`). Она не входит в снимки, checkpoint и в сверку `fromTree` при восстановлении, только если одновременно (1) путь не отслеживается деревом базы, (2) это symlink, (3) его цель, inode и время создания совпадают с `workspace/deps-link.json`, записанным при создании. Файл лежит вне копии, рядом с `workspace.json`. Любой другой объект с этим именем (каталог проекта, отслеживаемая ссылка проекта, заново созданная, перенаправленная или чужая ссылка) учитывается как обычный путь и никогда не удаляется. Восстановление (`read-tree -m -u`) исключённую ссылку не трогает: её нет ни в одном из деревьев.

- **Checkpoint** — только по явному вызову `createCheckpoint(ws, n, {expectedTree?})` доверенного сервиса; модуль этап не принимает. Родитель — checkpoint `n-1` или baseline. Повтор: ref `stage-<n>` есть и дерево+родитель совпадают → тот же результат; иначе `checkpoint_conflict` (существующий не перезаписывается). `expectedTree` (если задан) должен совпасть с деревом копии — иначе `tree_changed`.
- **Восстановление копии** — два шага, между ними события журнала. `prepareRestore(ws, {name: "baseline" | "stage-<n>", commit}, base)`: `verifyWorkspace` → `commit` должен совпасть с ref в исходном (иначе `restore_target_mismatch`) → recovery-снимок опубликован в исходном; копия ещё не менялась. `applyRestore(ws, prepared)`: `verifyWorkspace` → проверка «в пути» → временный индекс = дерево recovery-снимка → `read-tree -m -u <recoveryTree> <targetTree>` в `control.git` с `GIT_WORK_TREE=repo`. Неигнорируемые файлы, которых нет в цели, удаляются (они в recovery-снимке). **Игнорируемые файлы не трогаются**; путь цели, занятый файлом вне recovery-дерева (игнорируемый файл или каталог с игнорируемыми файлами), → `restore_conflict {path}` до любых изменений. Проверка своя: Git 2.50 `read-tree -m -u` считает игнорируемые файлы расходуемыми и молча их перезаписывает (T45). `.git` копии (HEAD, индекс агента) не меняется. Исходный проект не сбрасывается и не очищается. После восстановления агент автоматически не запускается. Исходы `applyRestore` (отказ до записи, частичный или неизвестный результат, подтверждённый успех), проверка состояния копии и применимая база снимка — в [stage-3-review-fixes.md](stage-3-review-fixes.md).

## Связь со Store и частичные отказы

Новые события v1 (строгие схемы, в журнале только sha и числа; путь исходного репо — только в `workspace.json`, в журнале — его sha256):

| type | data |
|---|---|
| `workspace.created` | `{sourcePathSha256, baseline: {commit, tree}, head: sha \| null}` |
| `snapshot.created` | `{kind: "recovery" \| "intermediate", ref, commit, tree}` |
| `checkpoint.created` | `{stage: int ≥ 1, commit, tree, parent}` |
| `workspace.restore_started` | `{target: "baseline" \| "stage-<n>", targetCommit, recoveryCommit}` |
| `workspace.restored` | `{target, targetCommit, recoveryCommit}` |

**Порядок:** Git-операция (ref создан create-only) → затем событие журнала. Журнал отражает только подтверждённые Git-результаты.

- Ref создан, событие не подтверждено (крах, `write_failed`): после повторного открытия этап **не** считается принятым (в `RunState` нет checkpoint); `inspectWorkspaceRefs` показывает `unjournaled: [{ref, commit}]`; ничего не удаляется. Повторный вызов той же операции с тем же деревом возвращает тот же ref (`exists_same`) и записывает событие; с другим деревом — конфликт.
- Восстановление: `snapshot.created(recovery)` → `workspace.restore_started` → изменение дерева копии → `workspace.restored`. `restore_started` без `restored` после перезапуска → `RunState.workspace.pendingRestore` (состояние копии неизвестно); автоматического повтора и запуска агента нет.
- Ошибка Git — события нет, журнал не меняется.
- Наличие копии **не** доказывает изоляцию процесса агента (это Р4 и песочница провайдера).

## Ограничения (заявляются явно)

- `gc --prune` в исходном репо удаляет недостижимые объекты; baseline, checkpoint и recovery защищены refs, объекты промежуточных снимков и собственные коммиты агента в копии — нет (копия и `control.git` используют alternates). Конкурентные изменения исходного репо во время создания baseline не обнаруживаются (снимок — то, что прочитано).
- Глобальный игнор учитывается только при переданном `userHome`.
- LFS через макрос атрибута (`[attr]x filter=lfs`) не обнаруживается: проверяется только прямое `filter=lfs`. Без git-lfs в `control.git` pointer-файлы попадут в снимки как есть; smudge не выполняется.
- eol-атрибуты `.gitattributes` применяются Git при снимке (содержимое снимка = то, что записал бы `git add`).
- Linux и Windows: `git.ts` не зависит от платформы, тесты — macOS; Windows не поддерживается движком (Р1).

## API

```ts
// git.ts (workspace-core)
export interface GitContext {
  gitPath: string;              // absolute
  gitDir: string;               // explicit GIT_DIR, never discovery
  workTree?: string;            // GIT_WORK_TREE
  indexFile?: string;           // GIT_INDEX_FILE
  home: string;                 // empty service dir used as HOME/XDG_CONFIG_HOME
  userHome?: string;            // only for the documented exception (global ignore); otherwise GIT_CONFIG_GLOBAL=/dev/null
}
export interface GitRunOptions { input?: string | Uint8Array; timeoutMs?: number; maxOutputBytes?: number; identity?: boolean /* fixed author/committer env */; useUserGlobalConfig?: boolean }
export function git(ctx: GitContext, args: readonly string[], options?: GitRunOptions): Promise<{ stdout: Buffer; stderr: string }>;
export class GitError extends Error { code: "git_failed" | "git_timeout" | "git_output_limit" | "git_spawn"; exitCode: number | null; stderr: string }
export const HARDENED_CONFIG: readonly string[];   // the -c key=value list above
export function findGit(env: NodeJS.ProcessEnv): string | null;

// workspace.ts (workspace-core)
export class WorkspaceError extends Error { code: WorkspaceErrorCode; detail: unknown }
// codes: run_not_found, not_a_repository, unsupported_repository, operation_in_progress, submodules_unsupported,
// lfs_unsupported, nested_repository, workspace_exists, workspace_foreign, workspace_not_found, workspace_tampered,
// copy_git_tampered, baseline_conflict, ref_conflict, restore_conflict, invalid_input, git_error
export interface SnapshotInfo { commit: string; tree: string; parent: string | null }
export interface Workspace {
  runId: string; root: string; dir: string; repo: string; control: string; tmp: string;
  sourcePath: string; sourceGitDir: string; gitPath: string;
  baseline: SnapshotInfo; head: string | null;
}
export function inspectSource(source: string, opts: { gitPath: string; userHome?: string; tmp: string }): Promise<{ path: string; gitDir: string; head: string | null }>;
export function createWorkspace(opts: { root: string; runId: string; source: string; gitPath: string; userHome?: string }): Promise<Workspace>;
export function openWorkspace(opts: { root: string; runId: string; gitPath: string }): Promise<Workspace>;
export function verifyWorkspace(ws: Workspace): Promise<void>;                          // throws workspace_tampered / copy_git_tampered
// primitives for snapshots.ts (all run in control.git with a fresh temp index; none touches the source index/tree/HEAD):
export function snapshotCopyTree(ws: Workspace, baseTree: string): Promise<string>;      // tree of the copy's working tree (rules above); nested_repository
export function commitSnapshot(ws: Workspace, tree: string, parent: string | null, message: string): Promise<string>;
export function readCommit(ws: Workspace, commit: string): Promise<SnapshotInfo>;        // via control.git
export function setControlRef(ws: Workspace, ref: string, commit: string): Promise<void>; // refs/canvastty/... inside control.git, create-only
export function publishRef(ws: Workspace, name: string, commit: string): Promise<"created" | "exists_same">; // name like "stage-3"; ref_conflict {existing}
export function readSourceRef(ws: Workspace, name: string): Promise<string | null>;       // refs/canvastty/<runId>/<name>
export function listSourceRefs(ws: Workspace): Promise<{ name: string; commit: string }[]>;
export function applyTreeToCopy(ws: Workspace, fromTree: string, toTree: string): Promise<void>; // read-tree -m -u; restore_conflict
```

```ts
// snapshots.ts (coordinator). Each call returns its Git result; the caller records the matching Store event.
export class SnapshotError extends Error { code: "checkpoint_conflict" | "checkpoint_out_of_order" | "tree_changed" | "restore_target_mismatch" | "invalid_input"; detail: unknown }
export function createSnapshot(ws, kind: "recovery" | "intermediate", base: SnapshotInfo): Promise<{ kind; ref; commit; tree }>;
export function createCheckpoint(ws, stage: number, opts?: { expectedTree?: string }): Promise<{ stage; commit; tree; parent; reused: boolean }>;
export function prepareRestore(ws, target: { name: "baseline" | `stage-${number}`; commit: string }, base: SnapshotInfo): Promise<PreparedRestore>; // recovery published, copy unchanged
export function applyRestore(ws, prepared: PreparedRestore): Promise<{ status: "restored" }>;                                  // see stage-3-review-fixes.md for the three outcomes
export function inspectWorkspaceRefs(ws, state: WorkspaceState | null): Promise<{ unjournaled; missing; temporary }>;          // reports only, deletes nothing

// store.ts RunWriter (coordinator)
recordWorkspaceCreated(data); recordSnapshot(data); recordCheckpoint(data); recordRestoreStarted(data); recordRestored(data);
```

Из `index.ts` экспортируются только `createWorkspace`, `openWorkspace`, `verifyWorkspace`, функции `snapshots.ts`, классы ошибок и типы. Примитивы `workspace.ts` остаются внутренними: сами они `verifyWorkspace` не вызывают.

## Уточнения по реализации (workspace-core, приняты)

- `inspectSource` дополнительно отказывает: sparse checkout (skip-worktree), `core.bare=true`, `commondir` в `.git` (`unsupported_repository`); путь не в UTF-8 → `invalid_input` (не проходит через строки JS без потерь).
- Проверка источника идёт с одноразовым `HOME` (`mkdtemp`), который удаляется после проверки; служебный HOME run — `workspace/tmp/home`.
- `control.git` создаётся с `--template=` и `--object-format` источника (sha1/sha256).
- `publishRef` сам создаёт временный ref в `control.git` (`refs/canvastty/tmp/<uuid>`) и в исходном (`refs/canvastty/<runId>/tmp-<uuid>`); оба удаляются после успеха.
- `setControlRef` идемпотентен: тот же sha → успех, другой → `ref_conflict`.
- `openWorkspace` проверяет раскладку, маркер, fingerprint `control.git`, `sourceGitDir` и совпадение baseline в `control.git` и исходном; `.git` копии проверяет только `verifyWorkspace`, который вызывают функции `snapshots.ts` перед каждой операцией.
- Операции над всем деревом (`HEAVY`): таймаут 10 мин, лимит вывода 256 МиБ.
- Проверка «в пути» перед `read-tree -m -u` (см. «Восстановление копии»).
- Кто вызывает `verifyWorkspace`: все функции `snapshots.ts` перед операцией. Кроме того, `applyTreeToCopy` — единственный примитив, который пишет в рабочее дерево, — вызывает его сам (защита в глубину: при `repo/` → symlink на источник прямой вызов не запишет в источник). Остальные примитивы только читают копию и пишут в `control.git`/refs.
- `openWorkspace` намеренно не проверяет `.git` копии: run с испорченной копией можно открыть и показать пользователю, а любая операция над копией даст `copy_git_tampered`.
