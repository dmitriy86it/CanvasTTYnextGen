# Этап реализации 4 (Р4): runner проверок проекта

Доверенный сервис запускает заранее заданную проверку в управляемой копии Р3, ограничивает её Seatbelt-профилем, отслеживает завершение через supervisor Р1 и сохраняет проверяемый результат в журнал Р2. Модели не запускаются, UI и IPC не реализуются, OrchestrationService не пишется.

Опирается на: ARCHITECTURE-PROPOSAL §4, §6, §9; контракты [Р1](stage-1-contract.md), [Р2](stage-2-contract.md), [Р3](stage-3-contract.md) и [исправления Р3](stage-3-review-fixes.md); прототип `experiments/permissions/sb/`.

## Владение файлами

| Файл | Владелец |
|---|---|
| `src/main/services/orchestration/checkRunner.ts`, `tests/orchestration-check-runner.test.mjs` | runner-core |
| `src/main/services/orchestration/sandbox.ts`, `src/orchestration/sandbox-probe.mjs`, `tests/orchestration-sandbox.test.mjs`, `tests/fixtures/orchestration/sandbox-fixtures.mjs` | sandbox-tests |
| `src/main/services/orchestration/{checks,evidence,journal,store,index}.ts`, `tests/orchestration-check-store.test.mjs`, `tests/fixtures/orchestration/check-project/`, документация | координатор |

Файлы Р3 (`git.ts`, `workspace.ts`, `snapshots.ts`) не меняются. Чужие временные каталоги не удаляются; у каждого участника свой префикс `mkdtemp`.

## 1. Команда проверки и реестр

Команда задаётся программно, доверенной конфигурацией. Из ответа агента принимается **только `id`** из разрешённого списка.

```ts
export interface CheckCommand {
  id: string;                    // ^[a-z][a-z0-9-]{0,63}$
  title: string;                 // для отчёта, не влияет на запуск
  executable: string;            // абсолютный путь, существует, realpath совпадает (не symlink)
  argv: readonly string[];       // отдельные аргументы, без shell; ни один не раскрывается glob'ом
  timeoutMs: number;             // 1..3_600_000
  maxOutputBytes: number;        // 1..65_536 (лимит текста Store)
}
export interface CheckRegistry { commands: readonly CheckCommand[] }   // id уникальны
export function resolveCheck(registry: CheckRegistry, id: unknown): CheckCommand;  // иначе unknown_check
```

- `cwd` проверяемого процесса — всегда `workspace/repo` этого run, параметром не передаётся.
- `env` — фиксированный минимальный набор (ниже), из конфигурации и из ответа агента не берётся.
- Shell не используется: `execFile`-семантика, argv как есть. Аргумент вида `*.test.mjs` дойдёт до программы буквально; раскрытие glob — задача самой программы, поэтому команды формулируются без расчёта на shell.
- Реестр неизменяем после создания (`Object.freeze`), runner новых команд не добавляет и не разрешает.

## 2. Профиль macOS (минимальный)

Сеть, localhost, Unix-сокеты, PTY — **запрещены**, opt-in возможностей прототипа (`pty`, `localhost`, `unix`, `denyhome`) на этом этапе нет.

Профиль генерируется в `<root>/runs/<runId>/checks/<checkRunId>/profile.sb` из шаблона в `sandbox.ts`: канонические (`realpath`) пути подставляются в текст как `(literal "…")` с экранированием. Параметры через `-D` не используются — это устраняет вопросы кавычек и делает профиль самодокументируемым; sha256 текста профиля входит в evidence.

Фактическая раскладка Р3 (пути прототипа **не** переносятся как есть):

| Путь | Доступ |
|---|---|
| `<root>/runs/<runId>/workspace/repo` | чтение и запись (рабочий каталог проверки) |
| `<root>/runs/<runId>/checks/<checkRunId>/tmp` | чтение и запись (`TMPDIR` проверки) |
| `<root>/runs/<runId>/checks/<checkRunId>/home` | чтение и запись (фиктивный `HOME`) |
| `<root>/runs/<runId>/workspace/repo/.git` | чтение и запись (агентский `.git` копии; проверки читают историю) |
| `<root>/runs/<runId>/workspace/control.git`, `workspace.json`, `restore.json`, `tmp` | **запрещено** (управляющие данные Р3) |
| `<root>/runs/<runId>/journal.jsonl`, `texts`, `locks`, `checks/*` кроме своего | **запрещено** |
| `<root>/runs/*` кроме своего run | **запрещено** |
| `<root>/runs/<runId>/workspace/tmp` | **запрещено** (служебный HOME и индексы Git оркестратора) |
| исходный проект: `node_modules` | чтение (подготовленные зависимости) |
| `<sourceGitDir>/objects` | чтение (alternates копии и `control.git`) |
| исходный проект: остальное рабочее дерево | **запрещено** |
| запись куда-либо ещё | **запрещено** |

`sourceGitDir` берётся из `Workspace.sourceGitDir` и подставляется отдельно: путь **не** склеивается как `sourcePath + "/.git"` (Р3 вычисляет его, а не конструирует).

Окружение проверяемого процесса: `PATH` (каталог `executable` плюс `/usr/bin:/bin`), `HOME`, `TMPDIR`, `LANG=C`, `LC_ALL=C`, `TZ=UTC`, `CI=1`. Ничего больше; `ELECTRON_*`, `SUP_*`, `NODE_*` и переменные пользователя не передаются (фильтр `SUP_ENV_ALLOW` supervisor'а).

**Что остаётся читаемым и не является конфиденциальностью.** Профиль строится как «запрещено всё, кроме перечисленного» для записи, но **чтение вне перечисленных каталогов запрещается списком**, а не полным deny: системные каталоги (`/usr`, `/bin`, `/System`, `/Library`, `/private/var/db/timezone`, `/dev/null`, `/dev/urandom`, `dyld`-кэш) читаемы — иначе не запустится ни один инструмент. Поэтому: **конфиденциальность домашнего каталога на этом этапе не обеспечена и не заявляется** — обеспечено лишь то, что перечислено в таблице выше и проверено самотестом. Точный перечень читаемого фиксируется в профиле и в VALIDATION-MATRIX.

Linux и Windows → `not_verified(sandbox_unavailable)`, без попытки запуска. **Перехода к запуску без песочницы после ошибки `sandbox-exec` нет ни в одной ветке.**

## 3. Самотест профиля

До запуска команды проекта `sandbox.ts` выполняет самотест: доверенный probe приложения (`src/orchestration/sandbox-probe.mjs`, запускается тем же `process.execPath`, в приложении с `ELECTRON_RUN_AS_NODE=1`) плюс искусственные файлы-маркеры, созданные в каталоге самотеста.

Порядок для каждой проверки: **положительный контроль вне песочницы** (probe доказывает, что ресурс существует и доступен) → **та же операция внутри песочницы** (ожидается запрет). Обратный порядок не принимается: запрет недоступного ресурса ничего не доказывает.

Обязательный набор: разрешённая запись в `repo` и в свои `tmp`/`home`; запрет записи вне копии; запрет чтения и записи управляющих файлов run — `control.git`, `workspace.json`, `restore.json`, `workspace/tmp`, `journal.jsonl`, `texts/`, `locks/`, соседний `checks/<other>`; запрет чтения соседнего run (его `runId` — валидный UUID); запрет чтения исходного рабочего дерева при разрешённом чтении `node_modules` и `.git/objects`; отсутствие сети (внешний TCP, DNS, localhost); отсутствие Unix-сокетов; отсутствие PTY; наследование ограничений дочерним и detached-потомком; **область сигналов**, на которой держится скан очистки (§4): сигнал 0 своему ребёнку внутри разрешён (`allow.signal-own-child`), процессу вне песочницы — запрещён (`deny.signal-outside`, в том числе у дочернего и detached-потомка). После исправлений ревью самотест судит 55 проверок.

Настоящие секреты пользователя не читаются: маркеры — искусственные файлы в каталогах самотеста. Код проекта вне песочницы как положительный контроль не выполняется.

Самотест не прошёл, не запускался или сам упал → `not_verified(sandbox_unavailable)` с деталями; команда проекта **не запускается**. Результат самотеста (число проверок, что именно провалилось, sha256 профиля) входит в evidence.

## 4. Запуск и завершение

Используется supervisor Р1 (`src/orchestration/supervisor.mjs`) без протокола структурированных ответов: он не зависит от JSONL-фрейминга и передаёт fd1/fd2 цели как есть.

- запуск (исправление ревью Р4, дефект 3): **supervisor работает внутри песочницы проверки** — `spawn("/usr/bin/sandbox-exec", ["-f", profile, "--", launch.command, supervisorPath, executable, ...argv])` с `SUP_SANDBOX_SWEEP=1` в env, `cwd = workspace/repo`, `stdio = [pipe(0 управление), pipe(1 stdout), pipe(2 stderr), pipe(3 статус), fd(4 задание → открытый `/dev/null`)]`. `"ignore"` для fd ≥ 3 не годится: Node 22 и 26 отдают ребёнку не `/dev/null`, а pipe-подобный fd, supervisor падает на нём с `ENOTTY` и проверка не запускается вовсе. Поэтому runner сам открывает `/dev/null` на чтение, передаёт этот дескриптор и закрывает его у себя сразу после `spawn` (найдено runner-core);
- `stop()` → `{"cmd":"stop"}` в fd0; закрытие fd0 (смерть main) → supervisor сам останавливает группу;
- таймаут — в runner: по истечении `timeoutMs` посылается stop, результат `not_verified(timeout)`;
- лимит вывода: stdout и stderr считаются суммарно; при превышении `maxOutputBytes` сохраняется голова и хвост, счётчики отброшенного пишутся в результат, запускается stop, результат `not_verified(output_limit)`;
- ошибка запуска (`spawn` в supervisor) → `not_verified(spawn_failed)` с кодом;
- очистка процессов: `done.groupCleared` supervisor'а **плюс** скан экземпляра песочницы (ниже). Sweep по токену в окружении (`CANVASTTY_RUN_TOKEN`, `ps -axE`) **удалён**: он не видел платформенные бинарники (`/bin/sh`, `/bin/sleep`), а процесс мог просто сбросить токен, поэтому пустой результат ничего не доказывал.

**Скан экземпляра песочницы (`SUP_SANDBOX_SWEEP=1`, `supervisor.mjs`).** Внутри Seatbelt с `(deny default)` и `(allow signal (target same-sandbox))` вызов `kill(pid, 0)` успешен только для процессов **того же экземпляра** песочницы: для остальных — EPERM (в том числе для другого `sandbox-exec` с тем же текстом профиля), для отсутствующих — ESRCH. Все потомки проверки, включая ушедших через `setsid`, платформенные бинарники и процессы без токена, остаются в этом экземпляре: покинуть песочницу нельзя, вложенный `sandbox_apply` профилем запрещён. После завершения группы supervisor:

1. guard: при старте `kill(ppid, 0)` обязан дать EPERM (родитель — main, того же uid; EPERM возможен только при ограничении сигналов песочницей). Проверка берётся при старте, потому что после смерти main `ppid` = launchd, а `kill(1, 0)` даёт EPERM и без песочницы. Не прошла → `error: "not_sandboxed"`, **ни одного сигнала**;
2. перебирает pid 2…99999 (≈200 мс). Зомби отвечают на `kill(pid, 0)` из любой песочницы, чьи бы они ни были, поэтому попадание засчитывается, только если `getpriority` видит процесс (зомби → ESRCH). Если скан «нашёл» родителя — `not_sandboxed`, ничего не убивается;
3. SIGKILL только pid из завершённого скана, поштучно (никогда `-1` и отрицательные pid); повтор до **двух пустых сканов подряд** или до `SUP_SWEEP_MS` (3000) → `error: "deadline"`.

Скан выполняется на всех путях: естественный выход, Stop, таймаут, смерть main (EOF на fd0). `done.sandbox = { cleared, killed, scans, error }`. В результат: `cleanup { groupCleared, sandboxCleared, killed, observed: "process_group_and_sandbox_scan" }`; поле отсутствует или `cleared !== true` → `sandboxCleared: false`.

**Остаточное ограничение.** Процесс, который непрерывно делает fork и exit быстрее одного скана, может в него не попасть: заморозить экземпляр песочницы без привилегий нельзя. Два пустых скана подряд сужают окно, но не закрывают его. Задокументировано, тестом не воспроизводится.

## 5. Статусы

```ts
export type CheckStatus = "passed" | "failed" | "not_verified";
export type NotVerifiedReason =
  | "sandbox_unavailable" | "spawn_failed" | "timeout" | "stopped" | "output_limit"
  | "cleanup_unverified" | "deps_changed" | "tree_changed" | "workspace_unverified"
  | "restore_incomplete" | "interrupted" | "store_failed";
```

- **passed** — команда завершилась с кодом 0 **и** `groupCleared === true` **и** `sandboxCleared === true` (скан подтвердил, что в экземпляре песочницы ничего не осталось; найденное и убитое сканом допустимо, недоступный скан — нет) **и** после проверки дерево копии и зависимости совпадают с зафиксированными до неё. Выход лидера с кодом 0 при оставшихся потомках даёт `not_verified(cleanup_unverified)`.
- **failed** — команда завершилась сама с кодом ≠ 0 при `groupCleared === true` и `sandboxCleared === true`: это вердикт инструмента.
- **not_verified(reason)** — всё остальное. Невыполненная проверка не считается ни неудачным тестом, ни успешной проверкой. Stop, таймаут, ошибка supervisor и неподтверждённая очистка никогда не дают `passed`.

## 6. Зависимости, состояние до и после, evidence

- Зависимости используются **только для чтения**: `node_modules` исходного проекта разрешён профилем как read-only, копия работает через него. `npm install` и `npm ci` не выполняются никогда.
- `createWorkspace` Р3 symlink `node_modules` в копии **не создаёт**. Его создаёт координатор в `preflight`, **до снятия дерева «до»**: `repo/node_modules` → `realpath(preparedDeps.nodeModulesPath)` (symlink, не копия). Порядок важен: правило `.gitignore`, записанное как `node_modules/`, к symlink не применяется, поэтому ссылка, созданная позже, выглядела бы как изменение, которого проверка не делала.
- **Фактически используемые зависимости (исправление ревью Р4, дефект 2).** Принимается только ссылка на подготовленный каталог. Иначе `not_verified(deps_changed)` до запуска, без события, и **ничего не удаляется и не заменяется**: обычный каталог `node_modules` в копии (свой у проекта или созданный агентом — доступен для записи и мог игнорироваться Git), ссылка на другой или несуществующий каталог, любой другой `node_modules` внутри копии (он разрешался бы раньше подготовленного), подготовленный каталог внутри данных оркестрации.
- До запуска фиксируются: realpath подготовленного каталога, идентичность ссылки (`ino` и время создания) и **штамп** каталога — по каждой записи путь, тип и права, размер, `mtime`, `ctime`, `ino`, цель ссылки (ссылки внутри не разыменовываются). После запуска всё снимается заново; любое расхождение → `deps_changed`: ссылка заменена каталогом, удалена и создана заново (даже с той же целью), подготовленный каталог изменён снаружи во время проверки. Зависимости сверяются **раньше** дерева: замена ссылки меняет и дерево, но причина — зависимости.
- **Ссылки внутри подготовленного каталога (повторное ревью Р4).** Ссылка принимается, только если **конечная цель всей цепочки** (`realpath`) лежит внутри подготовленного каталога: тогда цель — запись того же обхода и тоже входит в штамп. Обычные `.bin`, псевдонимы пакетов и цепочки внутри `node_modules` работают. Цель вне каталога (в том числе через промежуточную внутреннюю ссылку) или неразрешимая ссылка → `deps_changed` до запуска, без события `check.started`; `detail` называет ссылку, её текст и конечную цель. Ссылки не удаляются и не переписываются, песочница под внешние каталоги не расширяется. После запуска проверка повторяется: ссылка, подменённая на внешнюю во время проверки, и изменённое содержимое внутренней цели → `deps_changed`. Раньше штамп записывал только `lstat` и текст ссылки, и содержимое внешней цели могло меняться под проходящей проверкой.
- Штамп — не хеш содержимого: `ctime` из пользовательского режима не откатить, поэтому любая запись видна, но штамп описывает именно эти файлы на этой машине и между машинами не переносится (`ponytail:` в `checkService.ts`).
- Запись в подготовленные зависимости изнутри запрещена профилем (разрешено только чтение `subpath nodeModules`, исходное дерево закрыто): проверено через ссылку и через абсолютный путь — EPERM.
- Требования «`node_modules` обязан игнорироваться» **нет**. ~~Ссылка, не покрытая правилом, входит в деревья «до» и «после» одинаково~~ — так она попадала и в checkpoint (найдено серией Р6). **Исправлено:** ссылку создаёт `linkDependencies` (`workspace.ts`) и записывает владение в `workspace/deps-link.json` (цель, inode, время создания). Снимки, checkpoint и проверка восстановления исключают её, пока путь не отслеживается базой и ссылка совпадает с записью (контракт Р3). `readDeps` дополнительно требует, чтобы ссылка была этой самой: удалённая и созданная заново (даже с той же целью), перенаправленная или чужая ссылка → `deps_changed` до запуска, ничего не удаляется. Проверка до и после команды (цель, идентичность ссылки, штамп) сохранена. Регрессии — `tests/orchestration-deps-link.test.mjs`.
- Подготовленные зависимости описываются `preparedDeps { lockfileRelPath, lockfileSha256, nodeModulesPath }` (доверенная конфигурация). Перед запуском sha256 lockfile в копии сверяется с `preparedDeps.lockfileSha256`; расхождение → `not_verified(deps_changed)` до запуска процесса. То же сравнение после проверки.
- Состояние копии до и после: `snapshotCopyTree(ws, base.tree)` с применимой базой из журнала (`RunState.workspace.current`). Дерево содержит отслеживаемые и неигнорируемые пути, поэтому **игнорируемые артефакты сборки (`build/`, `out/`, всё из `.gitignore`) допустимы и в сравнение не входят**. `postflight` сравнивает `treeAfter` с `treeBefore` (исправление ревью Р4, дефект 1: раньше `treeAfter` вычислялся, но не сравнивался); любое иное изменение → `not_verified(tree_changed)` с `treeBefore`/`treeAfter` в `detail`: результат не подтверждает прежнее дерево.
- Перед запуском: `verifyWorkspace(ws)` (иначе `not_verified(workspace_unverified)`) и отсутствие незавершённого восстановления (`readIncompleteRestore` → иначе `not_verified(restore_incomplete)`).
- `evidenceFingerprint` — sha256 канонического JSON (`canonical` из `journal.ts`) над:

```
{ v: 2,
  copy: { treeBefore, treeAfter, base: {commit, tree} },
  command: { id, executable, executableSha256, argv, timeoutMs, maxOutputBytes },
  deps: { lockfileRelPath, lockfileSha256, nodeModulesRealpath, nodeModulesStamp },
  tools: { node: process.versions.node, electron: process.versions.electron ?? null, git: <version> },
  platform: { platform, arch, release },
  sandbox: { profileSha256, selftest: { passed, checks, failed: [...] } },
  env: { names: [...] },   // только имена переданных переменных, без значений
  result: { status, reason, exitCode, signal, groupCleared, sandboxCleared } }
```

Значения окружения в evidence не попадают — только имена переданных переменных. Секреты не записываются.

## 7. Store

```
check.started  { checkRunId, checkId, commandSha256, base: {commit, tree}, treeBefore, profileSha256 }
check.finished { checkRunId, checkId, status, reason, exitCode, signal, groupCleared,
                 treeAfter, output: TextRef | null, outputDropped, evidenceFingerprint, durationMs }
```

- `check.started` записывается **до** запуска процесса: намерение сохранено раньше любого выполнения.
- `RunState.checks: Record<checkRunId, {checkId, status, reason, ...}>`. `started` без `finished` при воспроизведении даёт `not_verified(interrupted)` — без нового события и **без автоматического повтора**. Новое событие в `run.recovered` не добавляется: схема v1 не расширяется.
- Ошибка записи `check.finished` → результат не подтверждён: вызывающий получает `not_verified(store_failed)`; `passed` в этом случае невозможен.
- Вывод хранится отдельно от событий, через `putText` (≤ 64 КиБ, content-addressed `texts/`), в событии — только `TextRef`. Окружение, credentials и неограниченные логи не сохраняются.

## 8. API

```ts
// checks.ts (координатор)
export interface PreparedDeps { lockfileRelPath: string; lockfileSha256: string; nodeModulesPath: string }
export function createRegistry(commands: readonly CheckCommand[]): CheckRegistry;
export function resolveCheck(registry: CheckRegistry, id: unknown): CheckCommand;

// sandbox.ts (sandbox-tests)
export function sandboxSupport(platform?: NodeJS.Platform): { supported: boolean; reason?: "sandbox_unavailable" };
export function buildProfile(paths: SandboxPaths): { text: string; sha256: string };
export function runSelftest(opts: { dir: string; ws: Workspace; launch: SupervisorLaunch; paths: SandboxPaths }):
  Promise<{ passed: boolean; checks: number; failed: { name: string; detail: string }[] }>;

// checkRunner.ts (runner-core)
export function startCheck(opts: {
  ws: Workspace; registry: CheckRegistry; id: string; deps: PreparedDeps;
  writer: RunWriter; launch: SupervisorLaunch; clock?: () => number;
}): { checkRunId: string; stop(): void; result: Promise<CheckResult> };

export interface CheckResult {
  checkRunId: string; checkId: string;
  status: CheckStatus; reason: NotVerifiedReason | null;
  process: { exitCode: number | null; signal: string | null; supervisorExitCode: number | null };
  cleanup: { groupCleared: boolean; sandboxCleared: boolean; killed: number | null; observed: "process_group_and_sandbox_scan" };
  output: { ref: TextRef | null; bytes: number; dropped: number };
  copy: { treeBefore: string; treeAfter: string | null };
  sandbox: { profileSha256: string; selftest: { passed: boolean; checks: number; failed: {name: string}[] } };
  evidenceFingerprint: string;
  durationMs: number;
}
```

Порядок в `startCheck`: проверки Р3 → зависимости → `treeBefore` → профиль → самотест → `check.started` → запуск → завершение → `treeAfter` и зависимости → evidence → `check.finished`. Любой отказ до `check.started` возвращает `not_verified` без события; отказ после — с событием.

`runProjectCheck` (координатор) возвращает `CheckResult & { deps: { realpath, stamp } | null }` — ровно те зависимости, которые входят в evidence; `null`, если отказ случился до их чтения.

`startCheck` принимает свои зависимости параметрами (`resolveCheck`, `sandbox`, `preflight`, `postflight`, `evidence`, `writer`): внутри нет ни заглушек, ни ветки «запустить без песочницы». `preflight` и `postflight` — часть координатора: они делают проверки Р3, сверяют зависимости и считают деревья до и после. Таймаут отсчитывается **от запуска процесса**, время проверок Р3 и самотеста в него не входит. Неизвестный id — синхронное исключение `unknown_check`, а не `not_verified`: до него нет ни `checkRunId`, ни каталогов.

`unknown_check` и `store_failed` разделены: ошибка записи `check.started` не оставляет события и не запускает процесс; ошибка записи `check.finished` или вывода даёт `not_verified(store_failed)` поверх любого фактического исхода, поэтому `passed` в этом случае невозможен.

## 9. Совместимость проверок CanvasTTY с минимальным профилем

Профиль не ослабляется ради зелёного результата. Заранее известные ограничения, которые проверяются фактическим прогоном и фиксируются в VALIDATION-MATRIX:

- `npm test` самого CanvasTTY транзитивно грузит `node-pty` (`src/main/services/TerminalManager.ts`), собранный `electron-rebuild` под Electron: загрузка в обычном `node` не проверялась (ARCHITECTURE-PROPOSAL §4, H9), а PTY в минимальном профиле запрещён. Поэтому полный `npm test` проекта в минимальном профиле считается несовместимым, пока обратное не показано прогоном.
- Проверки, которым нужны сеть, localhost, Unix-сокеты или PTY, в минимальном профиле несовместимы по определению.
- Реальный прогон показывается на маленьком проекте-фикстуре (`tests/fixtures/orchestration/check-project/`): проверка, которая проходит, и проверка, которая падает.

## 10. Границы этапа

Не реализуются: OrchestrationService, UI, IPC, полный цикл агентов, выбор проверки моделью. Не запускаются реальные Claude и Codex, авторизация не меняется. Рабочий bundle пользователя (`release/`) не трогается. Профиль не ослабляется ради зелёного результата: проверка, несовместимая с минимальным профилем, отмечается как несовместимая в документации.
