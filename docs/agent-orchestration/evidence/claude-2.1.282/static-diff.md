# Claude Code 2.1.281 → 2.1.282: статическое сравнение

Дата: 2026-09-25. Бинарники: `~/.local/share/claude/versions/2.1.281` (221 МБ) и `~/.local/share/claude/versions/2.1.282` (222 МБ), Mach-O arm64; `~/.local/bin/claude` указывает на 2.1.282.
Запускались только `--version` и `--help`, бинарники читались как байты. Модель не вызывалась, пользовательские конфиги не читались.

## Что адаптер берёт у Claude

**Нативный режим (этапы 12–13, `providers.ts` buildNativeTurn → `sessions.ts` claudeHostDriver):**
- argv: `-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio [права] --json-schema <s> (--session-id <uuid> | --resume <uuid>)`.
- Права (`access.ts`): terminal — без флага; acceptEdits/auto — `--permission-mode <m>`; full — `--dangerously-skip-permissions`. Режимы берутся из `--help` (`--permission-mode <mode> … (choices: …)`).
- Отправляется: первое сообщение `{type:"user", message:{role,content}, parent_tool_use_id:null, session_id:""}`; ответы `control_response {subtype:"success"|"error", request_id, response|error}`; прерывание — `control_request {subtype:"interrupt"}`.
- Принимается:
  - `system/init`: `session_id`, `model`, `permissionMode`, `tools`, `mcp_servers[{name,status}]`, `skills`, `plugins`, `slash_commands`, `agents`, `output_style`, `apiKeySource`, `cwd`;
  - `assistant` и `user`: content-блоки text/thinking/tool_use/tool_result, `is_error`, `parent_tool_use_id`;
  - `result`: `subtype`, `is_error`, `session_id`, `structured_output`, `total_cost_usd`, `num_turns`, `duration_ms`, `permission_denials`;
  - `control_request`: `can_use_tool` (`tool_name`, `input`, `permission_suggestions`, `matched_ask_rule`, `decision_reason_type`, `requires_user_interaction`, `description`, `blocked_path`, `decision_reason`; особо обрабатываются `AskUserQuestion` и `ExitPlanMode`) и `elicitation` (`mcp_server_name`, `message`, `mode`, `url`, `requested_schema`); на остальные подтипы отвечаем `error`;
  - `control_cancel_request`.
- Ответ на `can_use_tool`: `{behavior:"allow", updatedInput, updatedPermissions?(destination:"session")}` или `{behavior:"deny", message}`. Ответ на `elicitation`: `{action:"accept"|"decline", content?}`.
- Конец хода: `result` → закрываем stdin → CLI завершается, supervisor собирает группу процессов.
- «Окружение» (`probe.ts`): `control_request` `initialize` и `mcp_status` без пользовательского сообщения.

**structured-edit (исполнитель, режим копии, `buildClaude`):**
- argv: `-p --output-format stream-json --verbose --json-schema … --safe-mode --restricted --settings {"permissions":{"blockReadsOutsideWorkingDirectories":true}} --tools Read,Edit,Write,Glob,Grep --strict-mcp-config --allowedTools … --disallowedTools … --disable-slash-commands --permission-mode dontAsk --permission-prompts none [--max-budget-usd] [--model] (--session-id|--resume)`.
- Контракт: `system/init.tools` = {Read, Edit, Write, Glob, Grep, StructuredOutput}, `mcp_servers` = [], `permissionMode` = "dontAsk"; `result.structured_output`, `permission_denials`.

## `--help`

`claude --help` у 2.1.281 и 2.1.282 **совпадает побайтно** (`diff` пуст, по 306 строк). Во всех нужных флагах изменений нет: `-p/--print`, `--input-format`, `--output-format` (stream-json), `--verbose`, `--permission-prompt-tool`, `--permission-prompts`, `--permission-mode` (choices: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan), `--dangerously-skip-permissions`, `--resume`, `--session-id`, `--model`, `--max-budget-usd`, `--settings`, `--setting-sources`, `--safe-mode`, `--restricted`, `--tools`, `--allowedTools`, `--disallowedTools`, `--json-schema`, `--strict-mcp-config`, `--disable-slash-commands`.
`claudeModesFromHelp` на реальном `--help` обеих версий даёт `terminal, acceptEdits, auto, full`.

## Протокол в бандле

Метод: байтовый поиск идентификаторов в обоих бинарниках. Для zod-схем и кода вокруг якорей брались окна текста; короткие минифицированные имена заменялись на `I`, после чего окна сравнивались.

**Множество значений `subtype:<literal>("…")` (123 → 124):** все подтипы 2.1.281 есть в 2.1.282. Добавлен один: `session_metadata`. Это исходящее сообщение `{type:"system", subtype:"session_metadata", metadata:{artifacts}}` с пометкой `@internal`, патч external_metadata для облачного воркера. Адаптер неизвестные `system/*` пропускает: драйвер смотрит только `init`, лента активности — только `init`.

**Схемы совпали после нормализации:**

| Якорь | Окон 281/282 | Итог |
|---|---|---|
| `subtype:"can_use_tool"` (все 3 схемы) | 3/3 | совпадает |
| `subtype:"init"` (system/init) | 1/1 | совпадает |
| `subtype:"elicitation"` | 1/1 | совпадает |
| `subtype:"initialize"` | 2/2 | совпадает |
| `subtype:"mcp_status"` | 1/1 | совпадает |
| `subtype:"interrupt"` | 1/1 | совпадает |
| `subtype:"set_permission_mode"` | 1/1 | совпадает |
| `subtype:"request_user_dialog"` | 2/2 | совпадает |
| `subtype:"success"` | 3/3 | совпадает |
| `type:"control_response"`, `type:"control_cancel_request"`, `type:"result"`, `type:"assistant"`, `type:"user"` | 1–2 | совпадает |
| `behavior:"allow"` / `behavior:"deny"` | 4/4 | совпадает |
| `permission_denials:` | 16/16 | совпадает |
| `structured_output:` | 7/7 | совпадает |
| `mcp_servers:` | 16/16 | совпадает |
| `No conversation found with session ID` | 3/3 | совпадает |
| `type:"control_request"`, `--permission-prompt-tool`, `total_cost_usd:`, `updatedPermissions:`, `permission-prompts` | — | расхождения только на краях окон (сдвиг минифицированного кода, соседние функции), идентификаторы протокола те же |

Поля `system/init` в схеме 2.1.282: `agents?`, `apiKeySource`, `startup_timing?` (@internal), `betas?`, `claude_code_version`, `cwd`, `tools`, `mcp_servers[{name,status,source?}]`, `model`, `permissionMode`, `slash_commands`, `terminal_slash_commands?`, `output_style`, `skills`, `plugins[…]`, `plugin_errors…`. Окно совпадает с 2.1.281.

**Число вхождений ключевых строк** (281/282): совпадает у `control_cancel_request` 49, `permission_denials` 28, `ExitPlanMode` 29, `StructuredOutput` 53, `structured_output` 56, `permission_suggestions` 21, `matched_ask_rule` 21, `decision_reason_type` 23, `requires_user_interaction` 20, `updatedPermissions` 57, `mcp_server_name` 36, `requested_schema` 8, `permissionMode` 454, `mcp_servers` 82, `total_cost_usd` 31, `error_during_execution` 36, `AskUserQuestion` 72, `bypassPermissions` 188, `acceptEdits` 85, `--permission-prompt-tool` 29. У `control_request` (152→160), `can_use_tool` (67→68), `mcp_status` (14→15), `"interrupt"` (77→82), `dontAsk` (62→64), `blockReadsOutsideWorkingDirectories` (113→111) счёт разошёлся на единицы. Это новые места использования, а не изменённые схемы: окна схем выше совпадают.

**Прочие новые строковые литералы 2.1.282 (≈515, в основном телеметрия и UI):** среди них интерактивный диалог «This conversation has been inactive… Resuming it will use about N% of your 5-hour usage limit» (`cold_resume_quota`, `new_conversation`). Это Ink-компонент REPL. Прошёл ли он в режим `-p --resume`, статически не видно. Проверяет второй ход probe (resume сразу после первого, то есть без простоя).

## Вывод

В статике несовместимостей с адаптером не нашлось, правка адаптера не нужна. Флаги, значения `--permission-mode`, схемы `system/init`, `can_use_tool`, `elicitation`, `initialize`, `mcp_status`, `interrupt`, `result` и формат `control_response` у 2.1.281 и 2.1.282 одинаковы. Единственный новый подтип сообщения (`system/session_metadata`) адаптер игнорирует безопасно.

Статика поведение не доказывает. Реальную проверку двух ходов делает `scripts/claude-compat-probe.mjs --real` (probe.json, probe.log).

Уже было в 2.1.281 и относится не к 2.1.282: host-подтип `request_user_dialog` драйвер получает как неизвестный и отвечает `error`.
