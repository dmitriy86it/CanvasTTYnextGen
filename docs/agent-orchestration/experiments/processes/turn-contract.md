# Контракт `runTurn` (ревизия 4, владелец — координатор)

Меняется только координатором. Участник, которому нужно изменение, пишет координатору.

## Владение файлами (`experiments/processes/`)

| Участник | Файлы |
|---|---|
| turn-harness | `turn.mjs` (новый), `schema.mjs` (новый), `jsonl.ts`, `jsonl.test.ts`, `turn-limits.test.mjs` (новый), `supervisor.mjs` (только при необходимости, с уведомлением координатора) |
| mock-validation | `mock-codex.mjs`, `mock-claude.mjs` (новые), `mock-cli.mjs`, `proc-ledger.mjs` (новый), `turn.test.mjs` (новый), `supervisor.test.mjs` |
| координатор | `turn-contract.md`, `README.md`, `results.txt`, все `*.md` верхнего уровня `docs/agent-orchestration/` |

Не трогать: `stop-exp.mjs`, `electron-utility/`, `mem-check.ts`, `../permissions/`.

## API

```js
import { runTurn } from "./turn.mjs";
const h = runTurn(spec);   // синхронно запускает supervisor; бросает только на ошибке spec (preflight)
h.stop();                  // пользовательский Stop; идемпотентно
const r = await h.result;  // TurnResult; никогда не reject
```

### spec

```js
{
  provider: "codex" | "claude",
  argv: [cmd, ...args],          // окончательный argv CLI. Токен "{REPORT_FILE}" заменяется путём файла ответа
  cwd: "/abs/existing/dir",      // рабочая папка CLI (supervisor запускается с этим cwd)
  env: { NAME: "value" },        // ровно это окружение CLI; имена → SUP_ENV_ALLOW; значения нигде не логируются
  task: string | Buffer,         // в fd4, затем EOF
  schema: object,                // подмножество JSON Schema (type, properties, required, additionalProperties:false, enum, items, minLength, maxLength)
  attemptDir: "/abs/existing/dir", // только codex: файл ответа = attemptDir/report-<randomUUID>.json; не должен существовать до старта
  expectSessionId: string | null,  // для продолжения: id сессии, который обязан прийти
  limits: {                      // все обязательные, значения по умолчанию — DEFAULT_TURN_LIMITS из turn.mjs
    maxMessageBytes, maxStreamBytes,       // фреймер stdout
    maxHistoryEvents, maxHistoryBytes,     // сохраняемая история событий (оба)
    maxStderrBytes,                        // хранится хвост/голова stderr, остальное считается
    maxDiagnostics,                        // записи diagnostics[]
    maxReportBytes,                        // файл ответа codex / JSON structured_output claude
    timeoutMs,                             // таймаут хода → Stop с причиной timeout
    stdoutGraceMs,                         // ожидание конца stdout после exit лидера
  },
  supervisor: { graceIntMs, graceTermMs, leftoverMs }, // → SUP_GRACE_*_MS
}
```

### TurnResult

```js
{
  outcome: "completed" | "invalid_report" | "failed" | "stopped" | "timeout" | "protocol_error" | "harness_error",
  transport: { status, reason },          // reconcile(); транспорт отдельно от ответа
  report: { status: "valid" | "invalid_json" | "schema_mismatch" | "missing" | "too_large" | "not_checked", errors?: string[], value?: any },
  sessionId: string | null,               // codex: thread.started.thread_id; claude: system/init.session_id (и result.session_id совпадает)
  sessionMismatch: boolean,               // expectSessionId задан и не совпал → outcome "failed"
  stopCause: null | "user" | "timeout" | "stdout_held_open" | "protocol_error" | "lifeline",
  nextTurnAllowed: boolean,               // только outcome=completed и без принятого Stop
  process: { exitCode, signal, stdoutEnded, signalsToLeader, groupCleared, supervisorExitCode, supervisorDone: boolean },
  counters: { stdoutBytes, frames, keptEvents, droppedEvents, droppedEventBytes, stderrBytes, stderrDroppedBytes, droppedDiagnostics },
  history: Frame[],                        // ограничено maxHistoryEvents и maxHistoryBytes
  terminal: { type, index, at } | null,   // всегда сохраняется, даже если история обрезана
  errors: Frame[],                         // ошибки фрейминга; первые N + счётчик, но хотя бы первая всегда
  stderr: { head: string, tail: string, bytes, droppedBytes },
  diagnostics: [{ at, what, ... }],        // причины остановки, превышения лимитов; ограничено
  timeline: [{ at, ev }],                  // at — только performance.now() main; supervisor-время (Date.now) не сравнивается
  pids: { supervisor, pgid },              // для учёта процессов в тестах
  reportFile: string | null,
}
```

### Правила

1. Порядок завершения: результат готов только после **всех**: статус `done` на fd3 (или EOF fd3), выход supervisor, конец stdout (или истёк `stdoutGraceMs` → Stop, `stopCause=stdout_held_open`, `protocol_error`), конец stderr. `exit` сам по себе не означает, что stdout прочитан.
2. Один источник порядка: `performance.now()` в процессе main — для кадров (`at`), момента Stop, таймаута, timeline. `stopRequestedAt` для `reconcile` — тоже из этих часов.
3. Транспорт ≠ ответ. Codex: `turn.completed` — только завершение; ответ — файл `-o` этой попытки (уникальное имя, не существовал до старта, размер ≤ `maxReportBytes`, JSON, схема). Claude: `result.structured_output` (сериализованный размер ≤ `maxReportBytes`, схема); `result.result`-текст не является ответом.
4. Ответ проверяется только при `transport.status === "completed"`; иначе `report.status = "not_checked"`.
5. `outcome`: транспорт `completed` + ответ `valid` (+ нет `sessionMismatch`) → `completed`; транспорт `completed` + ответ невалиден → `invalid_report`; `stopCause=timeout` → `timeout`; иначе статус транспорта.
6. Лимиты независимы: лимит числа событий не заменяет лимит байтов. Отбрасывание истории не теряет терминальное событие и первую ошибку. Превышение лимита — запись в `diagnostics` и счётчик, не неограниченный вывод.
7. `nextTurnAllowed=false` после Stop, таймаута, любой ошибки или невалидного ответа.
8. Потеря main: supervisor видит EOF fd0 и останавливает группу (уже проверено в `supervisor.test.mjs`); интеграционный тест запускает `runTurn` в отдельном процессе и убивает его SIGKILL.

## Учёт процессов в тестах (`proc-ledger.mjs`)

- Основной механизм: pid, созданные самим тестом (`pids` из TurnResult, pid потомков, которые mock пишет в ledger-файл из env `MOCK_LEDGER`). Проверка `process.kill(pid, 0)`: `ESRCH` → нет; успех → жив (ошибка теста); `EPERM` → **unverifiable** (явно в выводе теста, не «нет процессов»).
- Глобальный поиск по маркеру через `ps` — дополнительный: при ошибке запуска (`EPERM`, ENOENT) — «проверка недоступна», тест не падает и не считает это успехом очистки.
- Убивать только pid из своего ledger. Реальные ошибки очистки (жив после таймаута) — провал теста.

## Уточнения после реализации (приняты координатором)

1. `sessionMismatch=true` также при внутреннем конфликте id: у Claude `result.session_id` ≠ `system/init.session_id`, у Codex второй `thread.started` с другим id (`sessionConflict` коллектора).
2. `done` с ошибкой spawn (например ENOENT) → `transport = {status:"failed", reason:"supervisor spawn <code>"}` без `reconcile`.
3. Нет `done`, fd3 закрыт → `outcome = "harness_error"`, diag `status_eof_without_done`. Защитный срок = `timeoutMs` + grace supervisor + 1 с + 2×`stdoutGraceMs` + 5 с; по истечении — `harness_error` с `diagnostics.missing`, fd0 закрывается.
4. Preflight (throw): у Codex в argv обязателен `{REPORT_FILE}`, у Claude он запрещён; имена env — `[A-Za-z_][A-Za-z0-9_]*`, без `SUP_*`, `ELECTRON_*`, `NODE_*` (последние влияли бы на сам supervisor, т.к. он получает то же окружение); все ключи `limits` обязательны и > 0; `spec.supervisor` необязателен.
5. `h.stop()` после `done` ничего не делает. Если после выхода supervisor поток держит сбежавший потомок, через `stdoutGraceMs` harness закрывает поток: `stdoutEnded=false`, `protocol_error(stdout_held_open)`, `stopCause=null`.
6. `nextTurnAllowed = outcome==="completed" && stopCause===null && !done.stopRequested`.
7. Файл ответа — symlink (открывается с `O_NOFOLLOW`) или не обычный файл → `report.status="missing"` с `errors`.
8. История (`history`) — непрерывный префикс: после первого отброшенного события отбрасываются все последующие; первая ошибка фрейминга сохраняется всегда.
9. `sessionMismatch=true` и когда `expectSessionId` задан, а id не пришёл вовсе (Stop до init, ошибка запуска). `outcome` при этом определяется транспортом (`stopped`, `failed`, …); `failed(session_mismatch)` ставится только при `transport=completed`.
10. `maxStderrBytes` — лимит сохранённых **байтов** (голова + хвост). Строки `stderr.head/tail` декодируются с заменой: разрезанная UTF-8 последовательность на границе даёт U+FFFD, поэтому длина декодированной строки в байтах может немного отличаться.

## Ревизия 5: доставка задания, приоритет остановки, серия проб

### Владение файлами (заменяет таблицу выше на время ревизии 5)

| Участник | Файлы |
|---|---|
| turn-fix | `turn.mjs`, `supervisor.mjs`, `jsonl.ts`, `mock-codex.mjs`, `mock-claude.mjs`, `proc-ledger.mjs`, `turn.test.mjs`, `turn-limits.test.mjs`, `supervisor.test.mjs`, `jsonl.test.ts` |
| probe-series | `probe-plan.mjs`, `probe-series.mjs` (новый), `probe-series.test.mjs` (новый) |
| координатор | `turn-contract.md`, `README.md`, `results.txt`, `*.md` верхнего уровня |

### Новые поля TurnResult

```js
delivery: {
  status: "ok" | "failed" | "unconfirmed",
  // ok: main записал всё задание в fd4 и закрыл его без ошибки, supervisor прислал task_eof И task_written
  //     (child.stdin 'finish': все байты переданы в pipe CLI и stdin закрыт). Это НЕ доказывает, что агент прочитал задание.
  // failed: любая ошибка записи/чтения задания на стороне main (fd4) или supervisor (task_read_error, task_write_error) — в любом порядке относительно терминального события
  // unconfirmed: ошибок нет, но подтверждений не хватает (например, нет task_written)
  errors: [{ where: "main" | "supervisor", code, at }],   // at — performance.now() main (момент получения)
},
sessionEvent: object | null,  // событие, давшее sessionId (claude: system/init целиком; codex: thread.started), хранится независимо от обрезки истории
```

Supervisor добавляет статус `task_written` (`child.stdin` 'finish').

### Новые правила outcome (заменяют правило 5 и уточнение 6; первое сработавшее)

1. Нет `done` / guard → `harness_error`.
2. `done.error` (ошибка запуска CLI) → `failed`.
3. `delivery.status !== "ok"` → `delivery_failed` (включая `unconfirmed`). Ответ всё равно проверяется и сохраняется в `report` для диагностики.
4. `stopCause === "timeout"` → `timeout` — **даже если транспорт `completed`** и ответ валиден (ответ сохраняется в `report`).
5. `stopCause === "user"` → `stopped` (то же — ответ сохраняется).
6. Транспорт не `completed` → статус транспорта (`protocol_error`, `failed`, `stopped`).
7. `sessionMismatch` → `failed`.
8. Ответ не `valid` → `invalid_report`.
9. `done.groupCleared !== true` или `supervisorExitCode !== 0` → `cleanup_unverified`.
10. Иначе → `completed`.

`report` проверяется всегда, когда транспорт `completed` (независимо от п.3–5), иначе `not_checked`.

`nextTurnAllowed = outcome === "completed"` (п.10 уже включает: доставка ok, нет stopCause, нет Stop, группа очищена, supervisor без ошибок и с кодом 0).

### Режимы mock, которые добавляет turn-fix (нужны probe-series)

- `no_read_stdin` (оба): не читает stdin, сразу выводит полный успешный ход (claude: init + result с валидным structured_output; codex: thread.started … turn.completed + файл -o) и выходит 0.
- `result_then_hang` (оба): успешный ход целиком, затем не выходит (ждёт сигнала).
- `wrong_token` (оба): валидный по схеме ответ, но `token` не тот, что в задании/контексте.
- `no_context` (оба): resume возвращает валидный ответ без токена из прошлого хода (`token:""`).
- `tools_nonempty` (claude): `system/init.tools = ["Bash"]`.
- Mock принимает все флаги плана (`--safe-mode`, `--tools ""`, `--strict-mcp-config`, `--disallowedTools`, `--disable-slash-commands`, `--permission-mode`, `--permission-prompts`, `--max-budget-usd`, `--json-schema`, `--session-id`, `--resume`; codex: `-m`, `-c`, `-s`, `-C`, `--output-schema`, `-o`, `--json`, `--ignore-*`, `exec resume <id> -`) и в нормальном режиме отвечает `token` = значение `TOKEN=<...>` из задания; при resume — токен из сохранённого первого задания этой сессии. `system/init` у claude: `tools: []`, `mcp_servers: []`, `model: "mock-claude"`.
- Режим задаётся env `MOCK_MODE`; состояние — `MOCK_STATE`; ledger — `MOCK_LEDGER`.

## Ревизия 6: пересылка вывода и завершение потоков (2026-09-29)

Причина: ложный `protocol_error(stdout_held_open)` после штатного ответа. Supervisor получал stdout/stderr CLI через
`inherit` и сам держал их открытыми, пока ждал оставшихся потомков (`LEFTOVER_MS`), а main одновременно отсчитывал
`stdoutGraceMs` от `leader_exit`. При равных таймерах (2000/2000) потомок со `stdio: 'ignore'`, не державший вывод,
делал ход сбоем. Обратный дефект той же гонки: потомок, реально державший stdout и быстро убитый очисткой, давал
`completed`.

Изменения (заменяют правило 1 порядка завершения, правило 5 и `stopCause=stdout_held_open`):

1. Supervisor запускает CLI со `stdio ["pipe","pipe","pipe"]` и пересылает stdout/stderr на fd1/fd2 с backpressure;
   fd закрывается, когда сторона CLI закрыта и все прочитанные байты записаны. После закрытия номер fd сразу занимается
   `/dev/null`.
2. Как закончился каждый поток, решает supervisor по своему порядку событий, без сравнения часов разных процессов
   (`done.streams.<s>.status`):
   - `eof` — источник закрылся до сигнала группе после выхода лидера;
   - `held_until_cleanup` — источник был открыт в момент сигнала группе;
   - `held_capped` — после выхода лидера в поток записано больше потолка (1 МиБ), сигналов группе не было, источник брошен;
   - `held_abandoned` — группы нет, источник открыт после ограниченного ожидания (держатель вне группы);
   - `relay_failed` — пересылка прервана с непереданными байтами (сбой приложения).
   После выхода лидера supervisor дочитывает источник без backpressure (не больше потолка), поэтому EOF виден
   независимо от скорости main. `done.streams.<s>.bytes` — записано байтов; main сверяет со своим счётчиком,
   расхождение — `relay_incomplete` (сбой приложения).
3. Порядок после естественного выхода лидера: ждать до `LEFTOVER_MS`, пока нет группы и закрыты оба источника (Stop
   прерывает) → SIGTERM → SIGKILL → ограниченное ожидание источников (прерывают Stop, таймаут, lifeline) → сброс
   прочитанного в main (ограничен lifeline и защитным сроком main) → `done`.
4. main не останавливает ход по своему таймеру. Успех требует статуса `eof` у обоих потоков. Любой другой статус —
   сбой: удержание потоком (`stdout_held_open` / `stderr_held_open`, `protocol_error`) или сбой приложения
   (`harness_error`). `stdoutGraceMs` — только страховка после выхода supervisor (`held_after_supervisor_exit`, сбой).
   `stopCause="stdout_held_open"` больше не выставляется. stderr, удержанный выжившим потомком, теперь тоже сбой.
5. `done.error="fd4_unusable"` (код 2): непригодный канал задания — чистая ошибка до запуска CLI.
6. `TurnResult.ending`: шаг окончания (`ok`, `protocol_parse`, `no_terminal_event`, `stream_held_until_cleanup`,
   `stream_held_capped`, `stream_held_abandoned`, `relay_failed`, `relay_incomplete`, `cleanup_failed`,
   `invalid_report`, `delivery`, `stop`, `timeout`, …), статусы потоков, целые мс (терминал → выход лидера, выход → EOF,
   выход → `done`), сигналы, коды ошибок кадрирования, счётчики. Только enum и целые. Сохраняется в activity
   (`turn_finished.detail`), запись журнала `turn.finished` не меняется (её точный набор ключей читает 1.5.5).

Ограничение: процесс, который после выхода лидера пишет в вывод меньше потолка и сам выходит до конца `LEFTOVER_MS`,
не отличим от штатно закрывшегося вывода (как и в ревизии 5).
