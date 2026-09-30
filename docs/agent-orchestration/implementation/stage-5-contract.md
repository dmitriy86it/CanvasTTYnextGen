# Этап реализации 5 (Р5): OrchestrationService — машина состояний и автоматический цикл

Сервис ведёт один run от цели до `completed` без UI и IPC: план лида → ход исполнителя → разрешённые проверки Р4 → ревью лида → исправление или checkpoint → следующий этап → финальное ревью. Все решения, нужные для восстановления, пишутся в журнал Р2 **до** соответствующих действий. Сервис не подключается к старту приложения, UI и IPC; реальные модели не запускаются.

Опирается на: ARCHITECTURE-PROPOSAL §7 (модель, команды, восстановление), §8, §9 (прогресс); контракты [Р1](stage-1-contract.md), [Р2](stage-2-contract.md), [Р3](stage-3-contract.md) с [исправлениями](stage-3-review-fixes.md), [Р4](stage-4-contract.md). Где §7 расходится с принятыми контрактами Р1–Р4, действуют контракты (например, `paused.reason` хранится именем без параметров — Р2, уточнение 10).

## Владение файлами

| Участник | Файлы |
|---|---|
| координатор | `src/main/services/orchestration/{orchestrationService,cycle,progress,agents,checkService,index}.ts`; `tests/orchestration-service.test.mjs`, `tests/orchestration-cycle.test.mjs`; `tests/fixtures/orchestration/test-agents.mjs`; документация |
| ledger (схемы событий и восстановление) | `src/main/services/orchestration/{journal,store}.ts`; `tests/orchestration-journal-orch.test.mjs`, `tests/orchestration-recovery-orch.test.mjs` |
| chaos (гонки и отказы) | `tests/orchestration-service-races.test.mjs`, `tests/fixtures/orchestration/chaos-*.mjs` |

Файлы Р1, Р3 и Р4 (`turn.ts`, `providers.ts`, `supervisor.mjs`, `workspace.ts`, `snapshots.ts`, `git.ts`, `checkRunner.ts`, `sandbox.ts`) не меняются; `checkService.ts` меняется только добавлением отменяемого запуска. Временные каталоги: префиксы `canvastty-svc-`, `canvastty-ledger-`, `canvastty-chaos-`; чужие не удаляются. Код — TypeScript без `enum`, `namespace` и parameter properties (тесты импортируют `.ts` через type stripping, Node 22 и 26). Производственный код **не импортирует** `tests/fixtures/**`.

## 1. Термины

- **Внешняя операция** — ход агента (один процесс CLI или вызов тестового адаптера) или одна проверка Р4. Для run одновременно выполняется не больше одной внешней операции.
- **Внутреннее действие** — запись журнала, снимок дерева, checkpoint Р3. Выполняется между внешними операциями и не считается шагом.
- **Раунд этапа** — ход исполнителя по этапу `s`, затем проверки его результата и ревью лида. Номер раунда `r` = порядковый номер хода исполнителя по этапу `s` (с 1).
- **step** — из `paused` выполнить **ровно одну внешнюю операцию** (вместе с внутренними действиями до неё) и остановиться в `paused(step_done)`. Если следующее решение — пауза или завершение, step применяет его без внешней операции.
- **revision** — число записей `run.status` плюс число команд, завершённых с `accepted`. Меняется при любой смене статуса или причины и при любой принятой команде; ход и проверка сами по себе revision не меняют.

## 2. Цель и лимиты

Цель неизменяема: сервис валидирует её и записывает **канонический JSON** как текст `run.created.goal`. Критерии меняются только новой целью.

```ts
interface GoalInput {
  text: string;                    // 1..8000
  criteria: readonly string[];     // 1..32, каждый 1..500
  checks: readonly string[];       // обязательные проверки: id из реестра Р4, 1..16, без повторов
  reviewPlan?: boolean;            // false по умолчанию: цикл не останавливается на плане
  limits?: Partial<RunLimits>;
}
interface RunLimits {
  turns: number;            // 40   все ходы run
  roundsPerStage: number;   // 8    ходов исполнителя на этап
  replans: number;          // 3    планов после первого
  noProgressRounds: number; // 3    раундов подряд без прогресса → loop_suspected
  runMs: number;            // 4 ч  от создания run по часам сервиса
  leadTurnMs: number;       // 20 мин
  executorTurnMs: number;   // 45 мин
}
// В журнале: {v:1, text, criteria, checks, reviewPlan, limits (полные), createdAt (мс часов сервиса)}
```

Команда `raise_limit{kind,value}` пишет `limits.changed`; действует значение из последнего события, иначе из цели. Поднимаются `turns`, `roundsPerStage`, `replans`, `runMs`; значение должно быть больше текущего, а для `runMs` ещё и давать дедлайн в будущем (`createdAt + value > now`), иначе `rejected(invalid_command)`.

**Дедлайн run** = `createdAt + runMs` (с учётом `limits.changed`), по часам сервиса; время, пока прогон закрыт, тоже идёт. Он действует всё время, а не только между операциями (§7).

## 3. Агенты

```ts
type TurnPurpose = "plan" | "execute" | "review" | "final_review";
interface AgentTurnRequest {
  purpose: TurnPurpose; role: "lead" | "executor";
  cwd: string;                  // рабочая копия Р3 (repo)
  task: string;                 // собирает сервис
  schema: AnswerSchema;         // по purpose, §4
  sessionId: string | null;     // resume той же роли
  timeoutMs: number;
}
interface AgentAdapter {
  // До журнала: отказ → run не пишет turn.intent и встаёт в paused(permission_denied).
  prepare(req: AgentTurnRequest): { ok: true; provider: "codex" | "claude"; mode: string; start(): AgentTurn }
                                | { ok: false; reason: "unsupported_capability" | "unavailable"; detail: string };
}
interface AgentTurn { sessionId: string | null; stop(): void; result: Promise<ProviderTurnResult> }
```

- `start()` вызывается **после** подтверждённой записи `turn.intent`. Исключение из `start()` или отклонённый `result` превращаются сервисом в `ProviderTurnResult` с исходом `harness_error` (`agents.ts: failedTurnResult`).
- **Реальный адаптер** (`createProviderAgents`, `agents.ts`) строится на `startProviderTurn` Р1. Лид — Codex `structured-readonly` в копии. Исполнитель: единственный доказанный режим Claude — `structured-no-tools`, он **не может менять файлы**, поэтому `prepare({purpose:"execute"})` возвращает `unsupported_capability` с объяснением. Реальный адаптер не выдаёт себя за исполнителя и не расширяет права.
- **Тестовый адаптер** (`tests/fixtures/orchestration/test-agents.mjs`) выполняет сценарий: отчёт, задержка, правка файлов **только во временной копии**, игнорирование stop, исход. Производственный код его не импортирует.
- Самоотчёт исполнителя (`done`, `summary`) ничего не подтверждает: этап принимается только по проверкам Р4 и ревью лида.

## 4. Отчёты агентов (AnswerSchema Р1)

| purpose | Отчёт | Сервис дополнительно проверяет |
|---|---|---|
| `plan` | `{stages: [{title, task}], question: string \| null}` | 1..50 этапов; `title` 1..200, `task` 1..4000 |
| `execute` | `{summary: string, done: boolean}` | — (не доверяется) |
| `review` | `{verdict: "accept" \| "fix" \| "replan" \| "question", findings: string[], question: string \| null}` | `findings` ≤ 50 × 1..1000; `question` обязателен при `verdict=question` |
| `final_review` | `{verdict: "complete" \| "replan" \| "question", findings: string[], question: string \| null}` | то же |

Отчёт, прошедший схему Р1, но не прошедший эти проверки, → `paused(invalid_report)`.

## 5. Цикл: выбор следующего действия

`nextAction(state, goal, snapshot)` в `cycle.ts` — чистая функция воспроизведённого состояния (§8), цели и снимка копии (`snapshot = {tree, runKey, checkKeys}` §10). Первое подходящее правило:

| # | Условие | Действие |
|---|---|---|
| 1 | статус не `running` | нет |
| 2 | время run ≥ `runMs`; или следующее действие по правилам 3–15 — внешняя операция (ход или проверка), а ходов ≥ `turns` | пауза `limit_reached`. После дедлайна не выполняется **ничего**, включая внутренние шаги (checkpoint, `stage.accepted`, `completed`): поздний ответ не превращает истёкший run в `completed`. Лимит `turns` внутренние шаги не блокирует: прогон, уложившийся в число ходов, завершается |
| 3 | `stage.accepted` без `checkpoint.created` | checkpoint этапа (внутреннее) |
| 4 | открыт вопрос (`question.asked` без ответа) | пауза `awaiting_answer` |
| 5 | нет плана, или последнее ревью — `replan` после последнего плана | ход `plan` (перепланов > `replans` → `limit_reached`) |
| 6 | `reviewPlan`, план версии 1 и ещё не было `paused(plan_review)` после него | пауза `plan_review` |
| 7 | текущий этап `s` = принятых + 1 ≤ этапов плана: нет хода исполнителя после последнего ревью `fix` (или вообще) | ход `execute(s, r+1)` (раундов > `roundsPerStage` → `limit_reached`) |
| 8 | есть обязательная проверка без **актуального результата** (ниже) | проверка (по порядку `goal.checks`) |
| 9 | нет ревью этого раунда, или оно устарело: его `runKey` не текущий либо после него дан ответ на вопрос | ход `review(s, r)` |
| 10 | ревью `accept` и все обязательные проверки `passed` на текущих ключах | `stage.accepted` (внутреннее; затем правило 3) |
| 11 | ревью `accept` при непройденной проверке, или `fix` | как правило 7 (лид не может принять этап с падающей проверкой) |
| 12 | все этапы приняты: проверка без актуального результата | проверка |
| 13 | нет финального ревью на текущих `runKey` и версии уточнений | ход `final_review` |
| 14 | финальное ревью `complete` на текущих `runKey` и версии уточнений, все обязательные проверки `passed` на текущих ключах | `completed` |
| 15 | финальное ревью `complete` при непройденной проверке | как `replan` (правило 5) |

**Актуальный результат** проверки — последний `check.assessed` с `checkKey`, равным ключу, посчитанному сейчас, у которого исход не `not_verified(stopped | interrupted | store_failed)` (операция не завершилась — проверка повторяется). Результат на том же ключе переиспользуется в любом раунде: повторный прогон на том же состоянии ничего не добавляет. `failed` и `not_verified` — актуальные результаты, но обязательной проверке не удовлетворяют. Новый `checkRunId` сам по себе ничего не меняет.

Раунды считаются в пределах текущей версии плана: после перепланирования этап `s` начинается с раунда 1. Ход, завершившийся не `completed` (кроме `recover: accept` для хода исполнителя), свою роль не выполнил: следующее действие повторяет его новым ходом.

Перед каждым правилом 7–15 сервис проверяет прогресс (§10); `loop_suspected` → пауза.

## 6. Статусы и команды

Статусы и причины — Р2 (`RunStatus`, `PausedReason`). Сервис меняет статус только так:

| Из | Событие / команда | В |
|---|---|---|
| — | `createRun` | `preparing` → `running` (сразу, без команды) |
| `running` | нет следующей операции по правилу паузы | `paused(<reason>)` |
| `running` | `pause_after_turn{on:true}` | `pausing` |
| `pausing` | `pause_after_turn{on:false}` | `running` |
| `pausing` | текущая операция закончилась | `paused(user_request)` |
| `running` (из step) | одна внешняя операция закончилась | `paused(step_done)` |
| `paused` | `resume` | `running` |
| `paused` | `step` | `running` с бюджетом 1 операция |
| `preparing`, `running`, `pausing`, `paused` | `stop` | `stopping` → `stopped` после завершения активной операции (или сразу без неё) |
| `running` | финальное правило 14 | `completed` |
| `running` | ошибка, после которой продолжение невозможно (цель не читается, копии нет) | `failed` |

Допустимость команд (иначе `rejected(invalid_state)`):

| Команда | Допустима из |
|---|---|
| `pause_after_turn{on}` | `on`: `running`; `off`: `pausing` |
| `stop` | `preparing`, `running`, `pausing`, `paused` (любая причина) |
| `resume`, `step` | `paused`: `user_request`, `step_done`, `plan_review`, `permission_denied`, `loop_suspected`, `environment_error`, `recovered`; `step` также из `invalid_report`, `protocol_error` |
| `answer{questionId,text}` | `paused(awaiting_answer)`, открытый вопрос с этим id → `running` |
| `clarify{text}` | `preparing`, `running`, `pausing`, `paused` кроме `journal_corrupt` |
| `recover{action, confirm}` | `paused(outcome_unknown)` |
| `raise_limit{kind,value}` | `paused(limit_reached)` → `paused(user_request)` |
| `dismiss` | `stopped`, `completed`, `failed` (состояние не меняет) |

`lead_modified_tree`, `shared_git_tampered`, `journal_corrupt`, `sandbox_unavailable` допускают только `stop`.

`recover`: `accept` — изменения копии остаются и идут на проверки и ревью текущего раунда; `retry_turn` — неизвестный ход повторяется новым ходом с новой сессией; `reset_to_checkpoint` (только с `confirm: true`) — восстановление Р3 к последнему `checkpoint`, иначе к baseline, через `prepareRestore`/`applyRestore` с событиями Р3. Решение пишется `recovery.decided` до действия; после решения — `paused(user_request)`.

### Обработка команды

```ts
command({ commandId, expectedRevision, command }): Promise<{ status: "accepted" | "rejected"; code: string | null }
  | { status: "in_progress" }>
```

1. `recordCommand(commandId, kind, {expectedRevision, command})` (Р2): `duplicate_completed` → сохранённый результат **без повторного действия**; `duplicate_in_progress` → `{status:"in_progress"}`; `command_id_reused` → `rejected(command_id_reused)` без записи.
2. `expectedRevision !== revision` → `rejected(stale_revision)`.
3. Команда недопустима из текущего статуса → `rejected(invalid_state)`; неверный payload → `rejected(invalid_command)`.
4. Решение пишется в журнал (`run.status`, `clarification.added`, …) **до** действия, затем `command.completed(accepted)`.
5. Ответ возвращается сразу: команда не ждёт завершения хода или проверки.

## 7. Pause, Stop, поздний результат, ошибка журнала

- **Pause**: текущая операция доходит до конца, её результат записывается, следующая не начинается.
- **Stop**: `run.status(stopping)` и ответ сразу; затем `stop()` активной операции — хода (`AgentTurn.stop`) или проверки (`startProjectCheck(...).stop`, §9). `stopped` пишется, когда операция завершилась, её факты записаны. Если операция не завершилась за `stopGraceMs` (по умолчанию 20 с), `stopped` пишется без неё: ход остаётся незавершённым в журнале.
- **Дедлайн и таймаут хода** (остановка по нашей инициативе): при запуске операции сервис взводит таймер дедлайна run (остаток `createdAt + runMs − now`), а для хода ещё и таймер `leadTurnMs`/`executorTurnMs`. Агенту передаётся `timeoutMs = min(лимит роли, остаток run)`. Срабатывание → `stop()` той же операции (ход или проверка через runner Р4); результат ждётся не дольше `stopGraceMs`. Затем — однократно — `paused(limit_reached)` для дедлайна или `paused(environment_error)` для таймаута хода. Ход записывается `turn.finished` с исходом адаптера (обычно `stopped`), проверка — `not_verified(stopped)` без `check.assessed`. Если за `stopGraceMs` результата нет, пауза пишется без него; ход остаётся незавершённым, а пришедший позже результат записывается фактом.
- **Поздний результат после остановки по дедлайну или таймауту** записывается фактом (`turn.finished`), но **не** даёт `plan.recorded`, `review.recorded`, `question.asked` или `check.assessed` и не меняет статус. Если пользователь успел поднять лимит и продолжить, цикл идёт от журнала: ход без записи ревью повторяется новым ходом (§5).
- **Stop пользователя** во время остановки по дедлайну побеждает: итог `stopped`.
- **Поздний результат** (после `stopping` или `stopped`): записывается как факт (`turn.finished`, события проверки), не запускает продолжение и не меняет терминальный статус.
- **Ошибка записи журнала**: писатель Р2 `poisoned`. Сервис переходит во внутреннее `halted`: останавливает активную операцию, больше ничего не запускает и не пишет, команды → `rejected(store_failed)` без записи. Продолжение — только новым `openRun` (восстановление Р2).

## 8. События журнала (добавляются к v1, строгие схемы, лишние поля запрещены)

| type | data | Правила replay |
|---|---|---|
| `orch.turn` | `{turnId, purpose, stage: int≥1 \| null, round: int≥1 \| null, planVersion: int≥1 \| null, clarificationVersion: int≥0}` | пишется **до** `turn.intent` того же `turnId`; `plan`, `final_review` → `stage = round = null`; `execute`, `review` → оба заданы; `turnId` уникален |
| `plan.recorded` | `{turnId, version, plan: TextRef, firstStage, stageCount: 1..50}` | ход `turnId` — `plan`, завершён `completed`; `version` = предыдущая + 1; `firstStage` = принятых этапов + 1 |
| `review.recorded` | `{turnId, stage: int \| null, verdict, findings: TextRef \| null, findingsKey: sha256, findingsCount: 0..50, clarificationVersion, runKey: sha256}` | ход `review` (stage задан, verdict `accept\|fix\|replan\|question`) или `final_review` (stage null, verdict `complete\|replan\|question`), завершён `completed`; один раз на ход |
| `question.asked` | `{questionId, turnId, text: TextRef}` | ход завершён; открытых вопросов не больше одного |
| `question.answered` | `{questionId, commandId, text: TextRef}` | вопрос открыт |
| `check.assessed` | `{checkRunId, stage: int \| null, round: int \| null, checkKey: sha256, runKey: sha256}` | проверка `check.finished`; один раз |
| `stage.accepted` | `{stage, reviewTurnId, tree}` | `stage` = принятых + 1 ≤ этапов плана; ревью этого хода — `accept` по этому этапу |
| `clarification.added` | `{version, commandId, text: TextRef}` | `version` = предыдущая + 1 |
| `limits.changed` | `{commandId, kind: "turns" \| "roundsPerStage" \| "replans" \| "runMs", value: int ≥ 1}` | — |
| `recovery.decided` | `{commandId, action: "accept" \| "retry_turn" \| "reset_to_checkpoint", turnId}` | ход `outcome_unknown`, решения по нему ещё не было |

`findingsKey` = sha256 канонического JSON отсортированного списка нормализованных замечаний (trim, схлопнутые пробелы, нижний регистр). Тексты (план, замечания, вопросы, ответы, уточнения) — только через `texts/`.

`RunState.orch` (replay):

```ts
interface OrchState {
  revision: number;
  turns: Record<string, { purpose; stage; round; planVersion; clarificationVersion }>;   // из orch.turn
  plan: { version; turnId; ref; firstStage; stageCount; seq } | null;
  planReviewPaused: boolean;        // был run.status paused(plan_review) после plan.recorded версии 1
  reviews: { turnId; stage; verdict; findings /* ref */; findingsKey; findingsCount; clarificationVersion; runKey; seq }[];
  accepted: Record<string, { reviewTurnId; tree; seq }>;  // stage.accepted, ключ — номер этапа
  pendingCheckpoint: number | null; // принятый этап без checkpoint.created
  clarifications: number;           // версия уточнений
  clarificationRefs: TextRef[];     // тексты уточнений по версиям (идут в задачи агентов)
  clarificationSeqs: number[];
  question: { questionId; turnId; ref; answered: boolean; answerRef: TextRef | null; answeredSeq: number | null; seq } | null;   // последний
  answers: number;
  answerSeqs: number[];             // для прогресса §10
  lastPausedSeq: Partial<Record<PausedReason, number>>;  // seq последнего paused(<reason>): loop_suspected не поднимается повторно до нового ревью
  assessed: Record<string, { stage; round; checkKey; runKey; seq }>;
  limitOverrides: Partial<Record<LimitKind, number>>;
  recoveryDecisions: Record<string, string>;              // turnId → action
}
```

Writer Р2 получает методы `recordOrchTurn`, `recordPlan`, `recordReview`, `recordQuestion`, `recordAnswer`, `recordCheckAssessed`, `recordStageAccepted`, `recordClarification`, `recordLimitsChanged`, `recordRecoveryDecision` — каждый проверяет событие через replay до записи (как все события Р2).

## 9. Проверки и отмена

`checkService.ts` получает `startProjectCheck(opts) → { checkRunId, stop(), result: Promise<ProjectCheckResult> }`; `runProjectCheck` остаётся обёрткой. Сервис запускает только проверки из `goal.checks`, по одной. После `check.finished` сервис пишет `check.assessed` с ключами §10. Результат проверки, закончившейся после Stop, записан runner'ом Р4 (`not_verified(stopped)`) и продолжения не вызывает.

## 10. Ключи состояния и прогресс

`evidenceFingerprint` Р4 включает путь профиля с уникальным `checkRunId` и сам результат, поэтому для сравнения состояний не годится; он остаётся записью конкретного прогона. Стабильные ключи (`progress.ts`):

- `checkKey = sha256(canonical({v:2, tree, checkId, commandSha256, executableSha256, lockfileSha256, nodeModulesRealpath, nodeModulesStamp}))`;
- `runKey = sha256(canonical({v:2, tree, lockfileSha256, nodeModulesRealpath, nodeModulesStamp, checks: [{id, commandSha256, executableSha256}] по id}))`;
- `commandSha256` реестра Р4 покрывает только путь, argv и лимиты. `executableSha256` — sha256 **содержимого** программы, тот же хеш, что входит в evidence Р4. При каждой сверке состояния он пересчитывается (`currentExecutableSha256`), а ключ результата строится из хеша, который видел preflight этого прогона (`ProjectCheckResult.executableSha256`). Замена программы по тому же пути делает прежний результат и ревью на нём устаревшими. Нечитаемая программа даёт метку `unusable:<code>`, не совпадающую ни с одним результатом. Уникальный `checkRunId` и путь профиля в ключ не входят;
- `tree` — `snapshotCopyTree` копии (отслеживаемые и неигнорируемые файлы, Р3); зависимости — `inspectPreparedDeps` (тот же штамп, что в evidence Р4).

Проверка актуальна, если её `check.assessed.checkKey` равен ключу, посчитанному сейчас.

**Прогресс раунда** (раунд `r` этапа `s` против предыдущего раунда того же этапа) — хотя бы одно:
1. этап принят;
2. на новом `runKey` набор падающих обязательных проверок строго уменьшился (или появилась прошедшая, которая раньше падала);
3. лид закрыл замечание: в ревью раунда нет замечания, которое было в предыдущем ревью;
4. пользователь ответил или уточнил после предыдущего ревью.

Не прогресс: новый `checkRunId`, повтор прогона на том же ключе, изменение дерева само по себе, самоотчёт исполнителя.

**`loop_suspected`** — перед ходом исполнителя раунда `r+1`:
1. `noProgressRounds` раундов подряд без прогресса;
2. два ревью подряд с одинаковым `findingsKey` при разных `runKey`;
3. пара (`runKey`, набор исходов обязательных проверок) повторяет пару более раннего раунда этапа без прогресса между ними.

Считается заново из журнала при каждом решении, поэтому одинаково до и после перезапуска.

## 11. Целостность копии

До каждой внешней операции: `verifyWorkspace` и отсутствие незавершённого восстановления (журнал `pendingRestore` и `readIncompleteRestore`), `inspectWorkspaceRefs` без `unjournaled`/`missing`. Нарушение управляющих данных или refs → `paused(shared_git_tampered)`; незавершённое восстановление → `paused(environment_error)` (resume проверит снова и снова остановится, пока восстановление не завершено).

Ход лида: дерево до и после (`snapshotCopyTree`); различие → `paused(lead_modified_tree)` (только `stop`). Ход исполнителя дерево менять может.

Исходы хода: `completed` с валидным отчётом → по §5; `invalid_report` → `paused(invalid_report)`; `protocol_error`, `contract_violation` → `paused(protocol_error)`; `failed`, `delivery_failed`, `timeout`, `cleanup_unverified`, `harness_error`, `stopped` не по нашей команде → `paused(environment_error)`. Результат проверки `not_verified(sandbox_unavailable)` → `paused(sandbox_unavailable)`; прочие `not_verified` — это исход проверки, ревью их видит.

Checkpoint: `createCheckpoint(ws, s, {expectedTree: accepted.tree})` → `recordCheckpoint`. `tree_changed` → `paused(environment_error)`; `checkpoint_conflict` → `paused(shared_git_tampered)`.

## 12. Восстановление

`openRun` Р2 уже пишет `run.recovered`: незавершённые ходы → `outcome_unknown`, run → `paused(outcome_unknown)`, иначе `paused(recovered)`; проверки без результата → `not_verified(interrupted)`. Сервис после открытия:

- **ничего не запускает сам**; продолжение — только командой;
- закрывает незавершённые команды `completeCommand(rejected, "interrupted")` — повтор такой команды возвращает этот результат;
- `stage.accepted` без `checkpoint.created` → при продолжении правило 3 повторяет идемпотентный `createCheckpoint`;
- **checkpoint опубликован, но `checkpoint.created` не записан** (сбой записи между публикацией ref и событием): ref `stage-N` виден как `unjournaled`. До общего отказа по неизвестным refs (§11) сервис сверяет его с записанным намерением: N — это `pendingCheckpoint`, коммит строго такой, какой пишет `createCheckpoint` для этого намерения (`matchesCheckpointIntent`, Р3): дерево = `stage.accepted.tree`, единственный родитель = baseline (N = 1) или журнальный checkpoint N−1, автор и коммиттер CanvasTTY, других заголовков нет, сообщение `CanvasTTY checkpoint: stage N` с трейлером этого run. Совпадение → правило 3: `createCheckpoint` возвращает `reused`, пишется `checkpoint.created` с тем же коммитом, ref не пересоздаётся. Любое расхождение, другой этап или произвольный неизвестный ref → `paused(shared_git_tampered)`, как раньше. Сверка — только при явном продолжении (`resume`/`step`); после `openRun` ничего не запускается;
- `orch.turn` без `turn.intent` — ход не начинался (намерение не подтверждено), ничего не требуется;
- блокировки Р3 (`pendingRestore`, `restore.json`) и ошибки Store (`journal_corrupt`, `journal_torn_tail`, `writer_locked`) не обходятся: `journal_corrupt` → `openRun` отказывает; остальное → паузы §11.

## 13. API

```ts
// orchestrationService.ts
export interface OrchestrationDeps {
  root: string; gitPath: string;
  agents: AgentAdapter;
  checks: { registry: CheckRegistry; deps: PreparedDeps; launch: SupervisorLaunch; sandbox?: SandboxApi };
  clock?: () => number;         // мс; лимиты времени
  stopGraceMs?: number;
  storeIo?: StoreIo;            // только тесты
}
export function createOrchestrationService(deps: OrchestrationDeps): {
  createRun(input: { source: string; goal: GoalInput; runId?: string }): Promise<RunHandle>;
  openRun(runId: string): Promise<RunHandle>;
};
export interface RunHandle {
  readonly runId: string;
  view(): RunView;              // статус, причина, revision, этап, раунд, счётчики, halted
  command(input: { commandId: string; expectedRevision: number; command: RunCommand }): Promise<CommandOutcome>;
  idle(): Promise<void>;        // нет активной операции и цикл не запланирован (для тестов)
  close(): Promise<void>;       // только при idle или после stop
}
```

## 14. Критерии завершения Р5

1. Полный цикл на временном проекте с тестовыми агентами, настоящим Store, рабочей копией Р3, runner Р4 и checkpoint: `completed` только при §5 правиле 14.
2. Сценарии с тестами: автоматический старт; `reviewPlan`; исправление после неудачной проверки; Pause / Resume / Step; Stop во время хода и во время проверки; поздний ответ; дубликат команды; устаревшая revision; лимиты; повтор состояния без прогресса; уточнение во время финального ревью; ошибка записи журнала; перезапуск после незавершённой операции без автоматического повтора.
3. Реальный адаптер отказывает исполнителю явно; модели не запускаются.
4. Тесты оркестрации, `npm test`, typecheck, build.

## 15. Границы

Не подключается к старту приложения, UI, IPC. Не запускаются реальные CLI с моделями; авторизация, `release/` и права провайдеров не меняются; ограничения Р1–Р4 не ослабляются. Повтор формирования отчёта (§7 ARCHITECTURE, «attempt 1») в Р5 не реализуется: `invalid_report` → пауза, `step` повторяет ход новым ходом.
