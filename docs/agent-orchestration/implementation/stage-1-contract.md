# Этап 1: движок одного хода — контракт между участниками

Владелец документа — координатор. Изменения — только через координатора.
Источник проверенного поведения: `docs/agent-orchestration/experiments/processes/` (`turn-contract.md` с разделом «Ревизия 5», `turn.mjs`, `supervisor.mjs`, `jsonl.ts`, `schema.mjs`, тесты). Переносится поведение, а не файлы: код приложения **не импортирует** `docs/` и mock-провайдеры.

## Владение файлами

| Участник | Файлы |
|---|---|
| turn-core | `src/main/services/orchestration/types.ts`, `jsonl.ts`, `schema.ts`, `turn.ts`; `tests/fixtures/orchestration/**` (mock-codex, mock-claude, proc-ledger, общие хелперы фикстур); `tests/orchestration-jsonl.test.mjs`, `tests/orchestration-schema.test.mjs`, `tests/orchestration-turn.test.mjs` |
| electron-launch | `src/orchestration/supervisor.mjs` (helper, вне asar); `src/main/services/orchestration/supervisorLaunch.ts`, `smoke.ts`; хук smoke в `src/main/index.ts`; `electron-builder.yml`; `scripts/smoke-orchestration.mjs`; скрипт `smoke:orchestration` в `package.json`; `tests/orchestration-supervisor.test.mjs`, `tests/orchestration-launch.test.mjs`; правки существующих тестов упаковки (`tests/packaging-fuses.test.mjs` и т. п.), если они перечисляют `extraResources` |
| координатор | `src/main/services/orchestration/providers.ts`, `index.ts`; `tests/orchestration-providers.test.mjs`; ADR; `docs/**` |

Общие правила: TypeScript с расширениями `.ts` в импортах (как в проекте); без `enum`, `namespace`, parameter properties (тесты импортируют `.ts` напрямую через type stripping); код и тесты работают на **Node 22** (CI, `/opt/homebrew/opt/node@22/bin/node` локально) — без `import.meta.main`, без API новее Node 22; supervisor работает и под Electron 43 в Node-режиме (Node 24). Никаких новых зависимостей.

## API (turn-core реализует, остальные используют)

```ts
// types.ts
export type OrchestrationProvider = "codex" | "claude";

export interface SupervisorLaunch {          // строит electron-launch (supervisorLaunch.ts); в тестах — { command: process.execPath, args: [<путь к supervisor.mjs>], env: {} }
  command: string;                           // process.execPath (Electron в приложении)
  args: readonly string[];                   // [supervisorPath]; argv CLI добавляется после
  env: Readonly<Record<string, string>>;     // только { ELECTRON_RUN_AS_NODE: "1" } в приложении; {} под Node
}

export interface TurnLimits { maxMessageBytes; maxStreamBytes; maxHistoryEvents; maxHistoryBytes; maxStderrBytes;
  maxDiagnostics; maxReportBytes; timeoutMs; stdoutGraceMs }   // все number > 0
export interface SupervisorTimings { graceIntMs?; graceTermMs?; leftoverMs? }

export interface TurnSpec {
  provider: OrchestrationProvider;
  argv: readonly string[];                   // [cliExecutable, ...args]; "{REPORT_FILE}" только у codex
  cwd: string;                               // абсолютная существующая папка
  env: Readonly<Record<string, string>>;     // точное окружение CLI; запрещены ELECTRON_*, NODE_*, SUP_*
  task: string | Uint8Array;                 // fd4 → stdin CLI, затем EOF
  schema: AnswerSchema;                      // см. schema.ts; неподдерживаемая схема → throw в preflight
  attemptDir?: string;                       // codex: файл ответа attemptDir/report-<uuid>.json, не должен существовать
  expectSessionId?: string | null;
  limits: TurnLimits;
  supervisor?: SupervisorTimings;
}

export type TurnOutcome = "completed" | "invalid_report" | "delivery_failed" | "failed" | "stopped" | "timeout"
  | "protocol_error" | "cleanup_unverified" | "harness_error";
export interface TurnResult { ... }          // поля как TurnResult в turn-contract.md + ревизия 5:
  // outcome, transport{status,reason}, report{status,errors?,value?}, delivery{status,errors[]}, sessionId, sessionEvent,
  // sessionMismatch, stopCause, nextTurnAllowed, process{exitCode,signal,stdoutEnded,signalsToLeader,groupCleared,
  // supervisorExitCode,supervisorDone}, counters, history, terminal, errors, stderr{head,tail,bytes,droppedBytes},
  // diagnostics, timeline, pids{supervisor,pgid}, reportFile

// turn.ts
export const DEFAULT_TURN_LIMITS: TurnLimits;
export function startTurn(spec: TurnSpec, launch: SupervisorLaunch): { stop(): void; result: Promise<TurnResult> };
export function decideOutcome(...): TurnOutcome;   // правила ревизии 5 в том же порядке
```

`startTurn` спавнит `launch.command, [...launch.args, ...spec.argv]` с `cwd: spec.cwd`, `env: { ...launch.env, ...spec.env, SUP_ENV_ALLOW: <имена spec.env>, SUP_GRACE_*... }`, stdio — 5 pipe. `launch.env` может содержать только `ELECTRON_RUN_AS_NODE` (иначе throw). Протокол supervisor (fd0 control/lifeline, fd3 статус с `task_eof`, `task_written`, `done`; fd4 задание) — как в прототипе ревизии 5.

## Валидатор ответа (`schema.ts`)

Явный контракт: **ограниченное подмножество JSON Schema, не стандарт.** Поддерживаются только `type` (`object|array|string|number|integer|boolean|null` или список), `properties`, `required`, `additionalProperties: false`, `enum`, `items` (одна схема), `minLength`, `maxLength`. Любое другое ключевое слово или `additionalProperties` ≠ `false` → `compileSchema` бросает `UnsupportedSchemaError` с путём; `startTurn` вызывает его в preflight, поэтому неподдерживаемая схема не запускает процесс. Экспорт: `compileSchema(schema): AnswerSchema`, `validateAnswer(schema, value): string[]`, `UnsupportedSchemaError`, `SUPPORTED_SCHEMA_KEYWORDS`.

## Supervisor и запуск (electron-launch)

```ts
// supervisorLaunch.ts
export type SupervisorLaunchResolution =
  | { ok: true; launch: SupervisorLaunch; helperPath: string }
  | { ok: false; reason: "unsupported_platform" | "helper_missing"; detail: string };
export function resolveSupervisorLaunch(input: { platform: NodeJS.Platform; isPackaged: boolean; resourcesPath: string;
  appPath: string; execPath: string; exists?: (p: string) => boolean }): SupervisorLaunchResolution;
export const ORCHESTRATION_PLATFORMS: readonly NodeJS.Platform[];   // ["darwin", "linux"]
```

Путь helper: упакованное приложение — `<resourcesPath>/orchestration/supervisor.mjs`; разработка — `<appPath>/src/orchestration/supervisor.mjs`. `win32` и прочие → `unsupported_platform` без обращения к файловой системе.

Smoke (`smoke.ts` + хук `CANVASTTY_ORCHESTRATION_SMOKE=1` в `src/main/index.ts`, честится и в упакованной сборке): встроенный фиксированный `/bin/sh`-mock (никаких команд/аргументов/задания из окружения), два хода через `startTurn`: (1) доставка задания (длина + `cksum`), структурированный ответ, в окружении CLI нет `ELECTRON_RUN_AS_NODE`/`SUP_*`, группа очищена; (2) Stop во время работы → `stopped`, группа очищена, pid завершены. Печатает `CANVASTTY_ORCHESTRATION_SMOKE_READY <json>` и завершает приложение. Скрипт `scripts/smoke-orchestration.mjs [--packaged]` запускает Electron (`--user-data-dir` во временной папке, пользовательский профиль не трогается), проверяет маркер и json. Настоящие `claude`/`codex` не запускаются.

## Адаптеры провайдеров (координатор, `providers.ts`)

Строят `TurnSpec` из входного контракта (`AvailableProviderCli` из `providerCliRegistry`, модель, параметры модели, `cwd`, схема, окружение, `attemptDir`, id сессии) для **проверенных режимов**: Codex `structured-readonly` (0.155.1), Claude `structured-no-tools` (2.1.278; ожидаемые `system/init.tools = ["StructuredOutput"]`, `mcp_servers = []`). Неподдерживаемая версия или режим → отказ, права молча не меняются. План диагностических проб — отдельно, в `docs/`.

## Исправления по внешнему ревью этапа 1 (2026-09-22)

**Один публичный путь провайдерского хода — `startProviderTurn(input, launch)`** (`providers.ts`, экспорт через `index.ts`). `startTurn`, `checkTurnSpec`, `decideOutcome`, `buildProviderTurn` из `index.ts` не экспортируются: транспорт — внутренний слой, его `completed` не является проверенным успехом провайдерского хода.

Порядок: проверка входа во время выполнения → `checkTurnSpec` (все предусловия `startTurn` без запуска) → только затем файл схемы Codex (`wx`) → `startTurn` → **обязательная проверка контракта провайдера** → `ProviderTurnResult`.

`ProviderTurnResult`: `outcome` (исход транспорта; при транспортном `completed` и нарушенном контракте — `contract_violation`), `nextTurnAllowed = outcome === "completed"`, `sessionId`, `report`, `contract {status: verified|violated, errors[], expected, actual}`, `transport` (низкоуровневый результат).

Контракт:
- Claude `structured-no-tools`: первый `system/init` наблюдался; `session_id` — строка, равная запрошенной; `tools` — массив строк, как множество ровно `["StructuredOutput"]` (элементы не приводятся к строкам, дубликаты — нарушение); `mcp_servers` — массив длины 0. Отсутствующее поле, неверный тип и лишний элемент — разные ошибки; отсутствие поля не читается как пустой массив.
- Codex `structured-readonly`: `thread.started` с непустой строкой `thread_id`, при продолжении — равной id продолжаемой сессии.
- Всегда: `sessionMismatch` транспорта — нарушение контракта.
- Диагностика: только имена (до 32, по 128 символов): инструменты, имена MCP-серверов (`name` или `<unnamed>`), id сессии. Конфигурация MCP, окружение и тела событий не сохраняются.
- **Это проверка метаданных CLI, а не доказательство изоляции процесса.**

**Что проверяется во время выполнения, а что только TypeScript:**

| Проверка | Где |
|---|---|
| Неизвестные поля входа; тип и доступность `cli`; `cliVersion` (строка, точная версия); `mode`; `launcher: native`; `cwd` абсолютный и существующий; `model` (шаблон, не начинается с `-`); `modelParams` — объект, ключи из `PROVIDER_MODES[provider].modelParams`, значения из списка (Codex `reasoningEffort`: `low`/`medium`/`high`; реально проверен только `high`; у Claude параметров нет); `maxBudgetUsd` (только Claude, число > 0); `attemptDir` (только Codex, абсолютная существующая папка); `env` — объект строк, имена без `ELECTRON_`/`NODE_`/`SUP_`; `session` — форма, UUID у Claude, id потока Codex не начинается с `-`; схема (подмножество); `limits`, `supervisor`, `task` | во время выполнения, до создания файлов и процессов |
| Точные типы полей `AvailableProviderCli` кроме `state`/`executable`/`environment`/`launcher`/`provider`; литеральные типы `ProviderMode` на этапе компиляции; форма `TurnResult` | только TypeScript |
