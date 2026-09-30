# Этап реализации 2 (Р2): OrchestrationStore — журнал и восстановление

Обозначения: «Р1», «Р2» — этапы реализации; в таблице этапов ROADMAP Р1 = строка 2 (supervisor и `providerTurn`), Р2 = строка 3 (Store). Владелец документа — координатор.

Основание: ARCHITECTURE-PROPOSAL §7 (статусы, правила восстановления, команды), §8 (журнал и хранение) с уточнением ниже. Store — модуль main-процесса, корень хранения передаётся параметром. Он не запускает процессы и не подключён к старту приложения. Тесты работают только во временных каталогах.

## Владение файлами

| Участник | Файлы |
|---|---|
| store-core | `src/main/services/orchestration/journal.ts` (канонический JSON, хэш, схемы событий, разбор, replay — чистые функции), `src/main/services/orchestration/store.ts` (файлы, блокировка, писатель, тексты, чтение, удаление) |
| recovery-tests | `tests/orchestration-store.test.mjs` (функциональные), `tests/orchestration-store-recovery.test.mjs` (повреждения, отказы, аварийный процесс), `tests/fixtures/orchestration/store-crash-child.mjs` |
| координатор | этот документ, `tests/orchestration-store-provider.test.mjs` (сценарий «намерение → ход → итог» через `startProviderTurn`), экспорт в `index.ts`, `docs/**` |

## Раскладка на диске

```
<root>/runs/<runId>/journal.jsonl      источник истины, append-only
<root>/runs/<runId>/locks/writer-<N>.json  поколения блокировки писателя (см. «Исправления по ревью Р2»; прежний writer.lock заменён)
<root>/runs/<runId>/texts/<sha256>     тексты пользователя и отчёты, ≤ 65 536 байт
<root>/runs/<runId>/quarantine/        сохранённые байты оборванного хвоста (только после явного разрешения)
```

`runId` — UUID (строчные hex); иное → `invalid_run_id` (защита от выхода за корень). `state.json` **не создаётся**: replay журнала на этом этапе дешёвый, кэш не нужен.

## Формат записи (версия 1)

Одна строка — одна запись, UTF-8, завершается `\n`:

```
{"data":{...},"hash":"<64 hex>","prevHash":"<64 hex>","runId":"<uuid>","seq":<n>,"ts":"<ISO-8601>","type":"<тип>","v":1}
```

- **Канонический JSON:** ключи объектов отсортированы по кодовым единицам UTF-16 (`Array.prototype.sort` по умолчанию), без пробелов, строки и числа — как `JSON.stringify`. Разрешены: string, boolean, null, конечные числа, массивы, простые объекты. `undefined`, функции, `NaN`/`Infinity`, не-простые объекты → ошибка.
- **Хэш:** `hash = sha256_hex(canonical(record без поля hash))`. Строка в файле = `canonical(record с hash) + "\n"`. При чтении строка обязана **побайтно совпасть** с каноническим видом разобранной записи — иначе `non_canonical`.
- **Цепочка:** `seq` начинается с 0 и растёт на 1; `prevHash` записи 0 — 64 нуля, далее — `hash` предыдущей. `runId` совпадает с каталогом.
- **Версия:** `v !== 1` → `unsupported_version`. Лишние или недостающие поля записи, неизвестный `type`, нарушение схемы `data` → `invalid_event`.
- Максимум строки — 64 КиБ (`line_too_large`), журнала при чтении — 64 МиБ (`journal_too_large`).

## События v1 (строгие схемы `data`, лишние поля запрещены)

| type | data |
|---|---|
| `run.created` | `{goal: TextRef}` |
| `run.status` | `{status: RunStatus, reason: PausedReason \| null}` (`reason` обязателен и не null только для `paused`) |
| `command.received` | `{commandId: uuid, kind: string ≤ 64, payloadHash: sha256}` |
| `command.completed` | `{commandId, result: {status: "accepted" \| "rejected", code: string ≤ 64 \| null}}` |
| `turn.intent` | `{turnId: uuid, commandId: uuid \| null, role: "lead" \| "executor", provider: "codex" \| "claude", mode: string ≤ 64, sessionId: string ≤ 128 \| null, task: TextRef}` |
| `turn.finished` | `{turnId, outcome: TurnOutcome \| "contract_violation", nextTurnAllowed: boolean, sessionId: string \| null, contract: {status: "verified" \| "violated", errors: string[] ≤ 16 × 256}, report: {status: ReportStatus, ref: TextRef \| null}, transport: {outcome: TurnOutcome, exitCode: int \| null, signal: string \| null, groupCleared: boolean}}` |
| `run.recovered` | `{unfinishedTurns: uuid[], unfinishedCommands: uuid[], previousStatus: RunStatus}` |
| `journal.tail_repaired` | `{offset: int, bytes: int, sha256, quarantine: string (имя файла)}` |

`TextRef = {sha256: 64 hex, bytes: int 0..65536}`. `RunStatus`, `PausedReason` — списки §7. `nextTurnAllowed = true` допустим только при `outcome = "completed"`.

Нормализация: события **не содержат** env, argv, stderr, историю событий CLI, диагностику, настройки MCP, тексты модели. Тексты (цель, задание хода, структурированный отчёт) — только через `texts/`. Сами тексты могут содержать секреты; полная очистка не обещается.

## Replay (чистая функция журнала)

`replay(records) → RunState`, детерминирован, не зависит от `ts`:

- `run.created` — только seq 0; первая запись обязана быть `run.created`. Начальный статус — `preparing`.
- `run.status` — переходы не проверяются этим этапом (это задача сервиса), кроме: из терминального (`stopped|completed|failed`) — `invalid_transition` (ошибка целостности).
- `command.received` — повтор `commandId` в журнале → ошибка (писатель такого не пишет). `command.completed` без `received` или повторный → ошибка.
- `turn.intent` → ход `in_flight`; повтор `turnId` → ошибка. `turn.finished` без intent или повторный → ошибка. Итог: `outcome` из события.
- `run.recovered` — ходы из списка → `outcome_unknown`, команды → `unfinished`; статус: терминальный сохраняется, иначе `paused(outcome_unknown)` при непустом `unfinishedTurns`, иначе `paused(recovered)`. Список обязан совпадать с фактически незавершёнными на этот момент (иначе ошибка).

`RunState = {runId, status, pausedReason, lastSeq, lastHash, goal: TextRef, turns: Record<turnId, TurnState>, commands: Record<commandId, CommandState>}`; `TurnState.status ∈ in_flight | outcome_unknown | <outcome из turn.finished>`; `CommandState.status ∈ received | completed | unfinished`.

## Чтение и целостность

`readRun(root, runId) → {state: RunState | null, integrity, canContinue}` — **только читает**, блокировку не берёт, файлы не меняет.

- `integrity.status = "ok"` — все строки валидны, файл пуст после последнего `\n`.
- `"torn_tail"` — последний фрагмент без `\n` (оборванная последняя запись), все предыдущие строки валидны. `detail: {offset, bytes}`. State — по валидным записям; фрагмент не отбрасывается молча: он виден в `integrity`, файл не меняется.
- `"corrupt"` — строка с `\n` не прошла разбор/схему/хэш/цепочку/replay. `detail: {line, offset, code}`. State — по записям до повреждения (для показа), `canContinue = false`.
- `canContinue = integrity.status === "ok"` (для `torn_tail` — после явного восстановления писателем, см. ниже).

**Граница цепочки (уточнение §8):** хэш-цепочка без независимо сохранённого последнего хэша **не обнаруживает удаление целого корректного хвоста** (журнал, обрезанный по границе записи, выглядит исправным) и не защищает от переписывания файла процессом с правом записи. Внешний якорь — не в этом этапе.

## Писатель

```ts
createRun(root, runId, { goal: string, clock?, io? }): Promise<RunWriter>     // run_exists, если каталог есть
openRun(root, runId, { acceptTornTail?: boolean, clock?, io? }): Promise<RunWriter>
readRun(root, runId): Promise<RunReadResult>
deleteRun(root, runId): Promise<void>
readText(root, runId, ref): Promise<Buffer>

interface RunWriter {
  readonly runId: string;
  state(): RunState;                                         // после последней подтверждённой записи
  putText(content: string | Uint8Array): Promise<TextRef>;
  recordCommand(commandId, kind, payload): Promise<CommandCheck>;
  completeCommand(commandId, result): Promise<void>;
  recordTurnIntent({ turnId, commandId, role, provider, mode, sessionId, task: string }): Promise<void>;
  recordTurnResult(turnId, result: ProviderTurnResult): Promise<void>;
  setRunStatus(status, reason): Promise<void>;
  close(): Promise<void>;
}
type CommandCheck =
  | { status: "new" }                                        // записан command.received, можно исполнять
  | { status: "duplicate_completed"; result }                // тот же id и payload: вернуть сохранённый результат
  | { status: "duplicate_in_progress" }                      // тот же id и payload, не завершена: не исполнять и не считать выполненной
  | { status: "command_id_reused" };                         // тот же id, другой payloadHash: отказ, в журнал не пишется
```

- **Порядок записи append:** очередь на писателя (промис-цепочка) → запись строки в fd, открытый `O_APPEND`, полностью → `fsync(fd)` → только затем промис разрешается и обновляется `state()`. Параллельные вызовы сериализуются; `seq` назначается при выходе из очереди.
- **Отказ записи или fsync** (исключение, неполная запись): писатель переходит в `poisoned`; этот и все последующие вызовы отклоняются (`write_failed` для исходного, `writer_poisoned` для остальных). Состояние файла неизвестно — продолжение только через `close()` и новый `openRun`, который заново читает и проверяет журнал.
- **Тексты:** `putText` проверяет размер (≤ 65 536 → иначе `text_too_large`), пишет во временный файл в `texts/`, `fsync`, `rename` в `texts/<sha256>` (если объект уже есть — сверяет содержимое), `fsync` каталога. Ссылка попадает в журнал только после этого. `readText`: `O_NOFOLLOW`, `fstat` до чтения, размер = `ref.bytes`, хэш = `ref.sha256`; иначе `text_missing` / `text_corrupt`.
- **`recordTurnResult` принимает только `ProviderTurnResult`** (есть `contract` и `transport`); сырой `TurnResult` → `invalid_input`. Итог берётся из `result.outcome`, не из `transport.outcome`. Отчёт (`report.value`) сохраняется как текст канонического JSON; если > 64 КиБ — `report.ref = null`, статус сохраняется. Ошибки контракта — не более 16 по 256 символов.
- **Блокировка писателя (исходная схема, заменена — небезопасна, см. «Исправления по ревью Р2»):** `writer.lock` создаётся `O_CREAT|O_EXCL` с `{pid, token, createdAt}`. Занята живым процессом (`kill(pid,0)` успешен или `EPERM`) или этим же процессом → `writer_locked`. Владелец мёртв (`ESRCH`) → блокировка устаревшая: её содержимое сохраняется в диагностике, файл заменяется. После захвата токен перечитывается. `close()` удаляет свою блокировку (если токен совпадает). Внутри процесса дополнительно — реестр открытых писателей по пути.
- **`openRun`:** берёт блокировку → читает журнал. `corrupt` → блокировка снимается, `journal_corrupt` (с `detail`). `torn_tail` без `acceptTornTail` → `journal_torn_tail`. С `acceptTornTail`: байты хвоста копируются в `quarantine/torn-<offset>-<sha256>.bin` (fsync), журнал усекается до последнего `\n` (fsync), пишется `journal.tail_repaired`. Затем восстановление: если есть `in_flight` ходы, незавершённые команды или статус нетерминальный и не `paused` — пишется `run.recovered`. Повторный запуск CLI и повтор команд не выполняются.
- **Удаление run:** только при свободной блокировке; каталог атомарно переименовывается в `<root>/runs/.deleting-<runId>-<uuid>`, затем удаляется рекурсивно. Соседние run и транскрипты провайдеров (`~/.codex`, `~/.claude`) не затрагиваются.
- **Инъекция отказов (`io`)**, только для тестов: `{ write?(fh, buf), sync?(fh) }` — подмена записи строки и `fsync` журнала.

## Ошибки

`StoreError extends Error` с полем `code`: `invalid_run_id`, `invalid_input`, `run_exists`, `run_not_found`, `writer_locked`, `writer_closed`, `write_failed`, `writer_poisoned`, `journal_corrupt`, `journal_torn_tail`, `text_missing`, `text_corrupt`, `text_too_large`, `report_not_stored` (добавлен по ревью). Коды повреждения строки (`detail.code`): `invalid_json`, `invalid_utf8`, `non_canonical`, `unsupported_version`, `invalid_event`, `bad_seq`, `bad_prev_hash`, `bad_hash`, `wrong_run`, `line_too_large`, `journal_too_large`, `invalid_transition`, `replay_conflict`.

## Сценарии отказа и ожидаемое поведение

| Сценарий | Результат |
|---|---|
| Крах между записью строки и fsync, строка полная | запись может быть в файле; append не был подтверждён; сервис не запускал процесс (он запускает только после подтверждённого `turn.intent`) |
| Крах посреди записи строки | `torn_tail`; писатель открывается только с `acceptTornTail`, байты в `quarantine/`, событие `journal.tail_repaired` |
| Порча строки внутри файла / неверная цепочка / неизвестная версия | `corrupt`, `canContinue=false`, `openRun` → `journal_corrupt`; файл не меняется |
| Удаление корректного хвоста целиком | **не обнаруживается** (нет внешнего якоря) |
| Ошибка write или fsync | писатель `poisoned` до повторного открытия |
| Второй писатель (тот же или другой процесс) | `writer_locked` |
| Ход `in_flight` после перезапуска | `openRun` пишет `run.recovered` → `outcome_unknown`, run `paused(outcome_unknown)`; CLI не запускается |
| Команда получена, не завершена, перезапуск | `unfinished`; повторная доставка → `duplicate_in_progress`, не исполняется |
| Текст отсутствует или изменён | `readText` → `text_missing` / `text_corrupt` |

## Уточнения после реализации (решения store-core, закреплены тестами)

1. `detail.line` считается с 1; `offset` — байт начала строки.
2. Порядок проверок строки: размер → UTF-8 → JSON → канонический вид → поля и `v` → схема → `runId` → `seq` → `prevHash` → `hash` → replay. Удалённая или переставленная строка поэтому даёт `bad_seq` раньше `bad_prev_hash`.
3. Пустой журнал или единственный фрагмент без `\n` — `corrupt(replay_conflict)` на строке 1, не `torn_tail`: нет корректной `run.created`, до которой можно усечь.
4. (Заменено поколениями, см. ниже.) `writer.lock` публикуется через `link()` временного файла с уже записанным телом (эксклюзивность как у `O_EXCL`, блокировка никогда не бывает пустой). Устаревшая заменяется `rename` поверх; данные прежнего владельца — в `RunWriter.staleLock`. Неразбираемая блокировка → `writer_locked` без автоматического снятия (смерть владельца не доказана); снимается вручную.
5. `payloadHash = sha256(canonical(payload))` — от порядка ключей не зависит.
6. Писатель прогоняет каждое событие через replay на копии состояния до записи; событие, которое replay отверг бы (завершение незарегистрированной команды, `turn.finished` без intent, выход из терминального статуса, переполнение 64 МиБ), → `invalid_input`, в журнал ничего не пишется.
7. Ошибка записи **текста** не переводит писателя в `poisoned` (журнал не тронут); ссылка не записывается.
8. `completeCommand` допустим для команды `unfinished` (сервис закрывает её явным отказом); автоматически это не делается.
9. `io.sync` подменяет только fsync записей журнала; fsync при усечении хвоста — настоящий.
10. `PausedReason` хранится именем без параметров (`awaiting_answer` без `questionId` — появится вместе с командами сервиса).

## Ограничения гарантий

- «Успешный append» = строка полностью записана и `FileHandle.sync()` (fsync) завершился. На macOS fsync не сбрасывает кэш накопителя (нужен `F_FULLFSYNC`, Node его не даёт); устойчивость к отключению питания **не доказана и не заявляется**. Тест с SIGKILL процесса доказывает только сохранность подтверждённых записей при крахе процесса.
- Удаление целого корректного хвоста журнала и переписывание файла с пересчётом цепочки не обнаруживаются (нет внешнего якоря).
- ~~Одновременный захват одной устаревшей блокировки двумя процессами — узкая гонка~~ — **ошибка, воспроизведена ревью: два активных писателя, журнал `corrupt/bad_seq`**. Исправлено блокировкой поколениями (ниже).
- Крах после `rename` в `deleteRun` оставляет `runs/.deleting-*`; очистка при старте не реализована.
- Тексты могут содержать секреты; redaction не выполняется.

## Исправления по ревью Р2 (2026-09-22)

Владелец `journal.ts` и `store.ts` на время исправлений — координатор. Участник «lock-tests» пишет только `tests/orchestration-store-lock.test.mjs` и `tests/fixtures/orchestration/store-lock-child.mjs`.

### Блокировка писателя: поколения вместо одного `writer.lock`

Прежняя схема (`writer.lock` + `rename` поверх устаревшей) допускала двух писателей: два процесса читают одну устаревшую блокировку, первый заменяет её и проверяет свой токен, второй затем заменяет уже новую блокировку и тоже проходит проверку (воспроизведено ревью, журнал → `corrupt/bad_seq`). Повторное чтение токена гонку не закрывает.

Новая схема:
- `runs/<runId>/locks/writer-<N>.json`, `N` — 12 цифр, с 1. Содержимое `{pid, token, createdAt, released}`.
- **Захват:** прочитать поколение с наибольшим `N`. Если его нет — претендовать на `N=1`. Если оно `released` или его `pid` мёртв (`kill(pid,0)` → `ESRCH`) — претендовать на `N+1`. Иначе (жив, `EPERM`, этот же процесс, файл не читается) → `writer_locked`.
- **Претензия** — эксклюзивное создание `writer-<N+1>.json`: полностью записанный и `fsync`-нутый временный файл публикуется `link()`. `EEXIST` → `writer_locked`: поколение уже занято другим, проигравший **ничего не удаляет и не переписывает**.
- **Файлы поколений не удаляются**, пока существует run (удаляются вместе с ним). Поэтому каждое число `N` создаётся не более одного раза, и среди всех, кто видел поколение `N`, эксклюзивное создание `N+1` выигрывает ровно один. Держатель — владелец наибольшего поколения; следующее поколение создаётся только после его освобождения или доказанной смерти.
- **Освобождение** (`close`): свой файл поколения атомарно заменяется копией с `released: true` (tmp → `rename` → `fsync` каталога), только если токен совпадает.
- **`deleteRun`** захватывает ту же блокировку, затем атомарно переименовывает каталог.
- Безопасный отказ вместо захвата: переиспользованный pid умершего владельца выглядит живым → `writer_locked` до ручного вмешательства. Файлы поколений накапливаются по одному на каждое открытие run.
- Тестовый хук `hooks.beforeLockClaim()` в `OpenRunOptions`: вызывается после решения о претензии и до `link()` — для детерминированных барьеров между процессами.

### Дедупликация команд

`recordCommand` сравнивает **`kind` и `payloadHash`**. `kind` проверяется (строка 1..64) до поиска дубликата. Тот же `commandId` с другим `kind` или payload → `command_id_reused` для незавершённой, завершённой и `unfinished` команды, в том числе после повторного открытия; журнал не меняется.

### Отчёт сверх лимита хранения

- Лимит отчёта один: `MAX_TEXT_BYTES = 65 536` байт канонического JSON. `DEFAULT_TURN_LIMITS.maxReportBytes` движка приведён к тому же значению, поэтому больший отчёт обычно отсекается ещё движком (`report.status = too_large` → `invalid_report`).
- Если валидный отчёт всё же нельзя сохранить (канонический JSON > 65 536 байт — например, числа в экспоненциальной записи раскрываются, или ошибка записи текста): `turn.finished` пишется с фактическим итогом провайдера (`outcome` не меняется), **`nextTurnAllowed: false`**, `report: {status, ref: null, storeError: "too_large" | "write_failed"}`; затем `recordTurnResult` **отклоняется** с `report_not_stored`. JSON не обрезается и не заменяется пустым.
- Схема `turn.finished.report`: `{status, ref: TextRef | null, storeError: null | "too_large" | "write_failed"}`; `storeError ≠ null` ⇒ `ref = null` и `nextTurnAllowed = false`; `status = "valid"` и `storeError = null` ⇒ `ref ≠ null`.
- Если не удалась и запись `turn.finished` (ошибка журнала) — писатель `poisoned`, ход остаётся `in_flight`; после повторного открытия — `outcome_unknown`, CLI автоматически не повторяется.
- Формат остаётся `v: 1`: журналов предыдущей схемы вне тестов не существует.

### Ограничения блокировки и хранения после исправлений

- **Живость владельца определяется по pid** (`kill(pid,0)`). Переиспользованный pid умершего владельца выглядит живым → `writer_locked`, снимается только вручную (T41). Это безопасный отказ, не второй писатель.
- **Неразбираемый файл последнего поколения** → `writer_locked` без автоматического снятия.
- **Взаимное исключение держится на семантике файловой системы**: `link()` атомарно и отказывает `EEXIST` для существующего имени (локальные APFS/ext4). Сетевые ФС, где это не гарантировано, не поддерживаются.
- **Корень хранения не должен быть доступен на запись агентам** (ARCHITECTURE §3): процесс с правом записи может подделать файлы поколений, как и журнал.
- Файлы поколений не удаляются до удаления run: по одному (~100 байт) на каждое открытие.
- Если освобождение при `close` не удалось (ошибка записи файла поколения), поколение остаётся `released: false` с pid этого процесса: run заблокирован (`writer_locked`) до завершения процесса, после чего сменяется следующим поколением. Безопасный отказ, не второй писатель.
- Отчёт > 65 536 байт канонического JSON не сохраняется (`report_not_stored`); его содержимое остаётся только в памяти вызывающего кода.
