# Оркестрация «Лид Codex → Исполнитель Claude»: согласованное предложение

Статус: **Proposed**, ревизия 3 (2026-09-22); **реализовано в Р1–Р9, расхождения — §0 (Р10); MVP принят для macOS с известными ограничениями (2026-09-24, [ROADMAP, «Приёмка MVP»](ROADMAP.md#приёмка-mvp-2026-09-24))**. Внешнее ревью ревизии 1 приняло основу; ревизия 2 исправила её замечания; ревизия 3 исправляет ошибки прототипов, найденные ревью ревизии 2 (доставка задания и окружение supervisor, модель `reconcile`, лимиты потока, описание замера памяти, несоответствие runner заявленной политике, исключённая из MVP связь мышью). Реализация продукта не начата.

Связанные документы: [VALIDATION-MATRIX](VALIDATION-MATRIX.md), [ROADMAP](ROADMAP.md), [TROUBLESHOOTING](TROUBLESHOOTING.md). Эксперименты этапа 0A: `docs/agent-orchestration/experiments/`.

Условные обозначения оснований: **L** — проверено локальным экспериментом без моделей (0A, перепроверки ревизии 3); **R** — установлено чтением кода или бинарника, без запуска; **D** — описано официальной документацией или `--help`; **S** — исходники Codex `rust-v0.155.1` (частный случай R); **H** — гипотеза (проверяется в 0B или позже).

## 0. Реализация и расхождения с предложением (Р10, 2026-09-24)

Предложение реализовано в Р1–Р9 и проверено на тестовых CLI: движок, Store, рабочая копия, runner, сервис, IPC, UI, E2E. Реальные CLI прошли цикл вне UI (Р6) и через UI упакованной сборки (реальная серия R1–R3, [evidence/real-ui/](evidence/real-ui/)). **MVP принят для macOS с известными ограничениями (2026-09-24).** Границы проверки и открытые ограничения — [ROADMAP, «Приёмка MVP»](ROADMAP.md#приёмка-mvp-2026-09-24). Коротко: реальные планы были одноэтапными, многоэтапный цикл проверен на тестовых CLI; выход в R3 — SIGTERM, Cmd+Q отдельно не проверялся; реальные CLI сохраняют свои сессии в `~/.claude/projects/` и `~/.codex/sessions/`. Дальше текст предложения сохранён как история решений. **Где он расходится с реализацией, действует эта таблица.** Точные правила — контракты этапов (`implementation/stage-N-contract.md`). Описание для пользователя — раздел «Оркестрация агентов» в `docs/ARCHITECTURE.ru.md`.

Обозначения: **НР** — не реализовано; **ИН** — реализовано иначе; **УС** — устаревшая формулировка.

| § предложения | Было в предложении | Как реализовано |
|---|---|---|
| заголовок, §13 | «реализация не начата», нужно дополнение ADR runAsNode | **УС.** Этапы Р1–Р10 выполнены и приняты; дополнение ADR принято (`docs/adr/ADR-20260913-packaged-fuses-keep-run-as-node.md`) |
| §3.1 лид | `shell_environment_policy.inherit="core"` | **ИН.** `codex exec --json --ignore-user-config --ignore-rules -m gpt-6-astra -c model_reasoning_effort="high" -c approval_policy="never" --output-schema … -s read-only -C <копия>`; env: `HOME USER LOGNAME LANG CODEX_HOME` и PATH реестра CLI |
| §3.1 исполнитель | `claude -p --permission-mode dontAsk`, Bash под Seatbelt Claude, отказ запуска при несовпадении init | **ИН.** Режим `structured-edit` (кандидатный, Р6): Read/Edit/Write/Glob/Grep, без shell, `--safe-mode --restricted`, `blockReadsOutsideWorkingDirectories`, запрет `Edit(/.git/**)`, `--max-budget-usd 1`. Это политика CLI, не граница ОС. Несовпадение init проверяется после хода → `paused(protocol_error)` |
| §3.1, §8 | `state.json` в userData | **НР.** Состояние только из replay журнала |
| §3.1 | отпечаток конфигурации копии до и после хода | **ИН.** `verifyWorkspace` перед каждой внешней операцией (`shared_git_tampered`); git оркестратора — через отдельный `control.git` |
| §3.2 | `<userData>/runs/<runId>/repo`; baseline через временный индекс исходного репозитория; fetch прямо в `stage-<n>`; worktree как запасной вариант | **ИН.** `<userData>/orchestration/runs/<runId>/workspace/{repo,control.git,tmp}`. Временный индекс — в `control.git`. Публикация — fetch во временную ссылку, затем `update-ref` только на создание. Есть также `recovery-<k>`. Worktree не используется. Отказов больше: незавершённая операция, вложенный репозиторий, sparse, bare |
| §4 runner | supervisor вне песочницы, `sandbox-exec -p … -D`; лид выбирает проверки; opt-in `denyhome/unix/localhost/pty`; самотест не реализован | **ИН / НР.** Supervisor внутри профиля, пути подставлены литералами. Проверки — `goal.checks` по порядку; каталог приложения — один `node-test` (`node --test`, 600 с, 64 КиБ). Opt-in нет. Самотест (55 проб) идёт перед каждой проверкой. Env добавляет `LC_ALL=C TZ=UTC CI=1`. Причины `not_verified` — список в `journal.ts`; `unsupported_repo` нет |
| §4, §6 | sweep по токену (`CANVASTTY_RUN_TOKEN`, `ps -axE`, `lsof`), показ «возможно оставшихся» процессов | **НР.** Проверка: сканирование экземпляра песочницы. Ход: группа процессов CLI и lifeline supervisor |
| §5 | Stop после результата → `completed`; повтор отчёта | **ИН / НР.** Любой Stop пользователя → `stopped`. Некорректный отчёт → `paused(invalid_report)` без повтора |
| §7 цель | модель лида в цели, `workspacePath`, `layoutRevision` | **ИН.** Модели и версии зафиксированы в приложении: Codex 0.155.1 `gpt-6-astra` high; Claude Code 2.1.281 `claude-sonnet-5`. Геометрия — в `canvas.json` |
| §7 статусы | причины с параметрами, `StageStatus`, `TurnStatus` с `queued` | **ИН / НР.** Причины без параметров; этапы выводятся из `stage.accepted`/`checkpoint.created`; ход — `in_flight`/`outcome_unknown`/исход |
| §7 восстановление | `recovery.inspected{orphansFound, killed}`, снимок и diff при восстановлении | **НР.** Открытие пишет только `run.recovered`. До открытия `list`/`get` показывают run так, как его запишет открытие (Р9). Поиска осиротевших процессов при старте нет: если убить всю группу main, CLI переживёт supervisor |
| §7 `recover: accept` | сохраняет recovery-снимок | **ИН.** `accept` пишет только `recovery.decided`; снимок `recovery-<k>` делает только `reset_to_checkpoint`. После любого `recover` — `paused(user_request)` |
| §8 | `display/`, IPC `events`, сырой JSONL с TTL, команда «удалить run», редакция, ошибка цепочки → `paused(journal_corrupt)` | **НР / ИН.** UI читает `orchestration:history` (страницы журнала), `orchestration:text`, события `orchestration:event`. Удаления run в UI нет, редакции нет. Повреждённый журнал: открытие отказывает с `journal_corrupt`, `list` показывает `integrity` |
| §9 | учёт токенов и стоимости, денежный лимит пользователя | **НР.** В приложении нет. Есть только `--max-budget-usd 1` на ход Claude. Лимиты по умолчанию совпадают: 40/8/3/3, 4 ч, 20/45 мин |
| §10 UI | «Новый агент» в палитре; диалог цели сразу после связи; Delete для выбранной связи; панель рядом со связью; «Новая цель» на пустом холсте и в меню терминала | **ИН / НР.** Два пункта контекстного меню холста; связь и с клавиатуры. Цель — кнопкой на плашке связи; удаление — «×»; панель справа. Палитры, миникарты и меню терминала нет |
| §11 платформы | на Windows функция скрыта; Linux | **ИН.** Пункты видны, создание отказывает `unsupported_platform`. На Linux ходы идут, но проверки дают `sandbox_unavailable` (только Stop), поэтому run не завершится |
| результат для пользователя | checkpoint `refs/canvastty/<runId>/stage-<n>`, ветка пользователя не двигается | **Совпадает.** Слияния в приложении нет, и UI не показывает имена ссылок. Как забрать изменения git-командами — `docs/ARCHITECTURE.ru.md` |

Остальное совпадает с реализацией:
- основа §1, лид read-only и `lead_modified_tree`, флаги hardened git;
- фрейминг и лимиты потока, `reconcile`;
- механизм supervisor, каналы и тайминги Stop;
- список `RunStatus`, отсутствие автоповтора, `commandId`/`expectedRevision`;
- журнал с хэш-цепочкой и `texts/`;
- правила прогресса и `loop_suspected`;
- правила связи.

## 1. Принятая основа (без изменений)

- `OrchestrationService` в main — единственный писатель новой сущности `OrchestrationRun`, у неё свой `revision`. `TerminalManager`, `SessionStatus` и ADR-20260913 (единственный писатель статуса PTY-сессий) не затрагиваются.
- Headless-адаптеры: Codex — лид (`codex exec --json`), Claude Code — исполнитель (`claude -p --output-format stream-json --verbose`).
- Точные id разговоров: Claude — `--session-id <uuid>`, назначенный до spawn; Codex — `thread_id` из `thread.started`. Варианты `--last` и `--continue` не используются.
- Лид и исполнитель работают последовательно в отдельной рабочей копии. Checkpoint после принятого этапа делает оркестратор.
- Renderer общается с main через типизированный allow-listed IPC (`handleMain`/`onMain` + `assertMainRenderer`, `src/main/ipc/registerIpc.ts:82-97`, `:644-657`).

## 2. Что изменилось относительно ревизии 1

| Было в ревизии 1 | Стало | Основание |
|---|---|---|
| `git worktree` как рабочая копия | `git clone --shared --no-checkout` в каталог запуска; результат забирается `fetch` в `refs/canvastty/<runId>/*` исходного репо | L: hook и `core.fsmonitor`, записанные из linked worktree, исполняются в исходном репо (TROUBLESHOOTING T1) |
| Проверки выполняет оркестратор вне песочницы по allow-list | Проверки выполняются только в ограниченном runner (Seatbelt на macOS). Без песочницы результат — `not_verified` | Замечание ревью 2; L: профиль `runner.sb` на фикстуре (§4, ревизия 3) |
| Длинные строки JSONL обрезаются | Строки не обрезаются до `JSON.parse`; слишком большое сообщение — протокольная ошибка хода | Замечание ревью 3; L: прототип `jsonl.ts` |
| Stop = SIGINT→SIGTERM→SIGKILL группе из main, по образцу `ProviderElectronSmoke.terminate` | Supervisor на каждый процесс через `ELECTRON_RUN_AS_NODE=1` с lifeline-pipe; обещание Stop ограничено | Замечание ревью 4; L: сценарии a–e |
| После перезапуска run всегда на паузе | Терминальные статусы сохраняются; на паузу — только прерванные нетерминальные | Замечание ревью 5 |
| Raw JSONL провайдера в `turns/*.jsonl` | По умолчанию только нормализованные события; raw — opt-in с TTL | Замечание ревью 6 |
| Доказательство = `(checkId, treeSha)` | Доказательство = `(checkId, evidenceFingerprint)` | Замечание ревью 7 |
| APFS-клон `node_modules` как шаг подготовки | Зависимости готовит пользователь; в копии read-only symlink; APFS — отложенная оптимизация | Замечание ревью 7; L |
| Денежные лимиты 5/30 USD | Денежные лимиты не заданы; выбирает пользователь | Замечание ревью 7 |

## 3. Политика доступа (замечание 1)

Ни один механизм ниже не является полной изоляцией. Режим read-only, `dontAsk` и deny-списки ограничивают отдельные каналы, а не агента целиком. Рабочая копия — не песочница.

### 3.1. Роли и каналы

Каждая ячейка: механизм принуждения → способ проверки → статус.

**Лид (Codex, `codex exec -s read-only`)**

| Канал | Механизм | Проверка | Статус |
|---|---|---|---|
| Окружение CLI (авторизация) | `--ignore-user-config` не читает `$CODEX_HOME/config.toml`, но auth по-прежнему берётся из `CODEX_HOME` | `--help`; `v155_cli.rs:39` | D/S |
| Workspace/managed-конфиг | Подтягивается по авторизации, отключить нельзя | `v155_lib.rs:485` | S; показывать пользователю |
| Окружение команд | `-c shell_environment_policy.inherit="core"` + минимальный env процесса CLI от оркестратора | 0B: `env` в команде лида | H |
| Файловые инструменты | Отдельных нет; всё через shell | исходники | S |
| Shell и потомки | Seatbelt read-only **запрещает запись, но разрешает чтение всего диска**, включая `~/.ssh`, `~/.claude`, `~/.codex/auth.json` и userData CanvasTTY. Read-only не даёт конфиденциальности | 0B C1: чтение фиктивного секрета вне репо | H (ожидается: читается) |
| Сеть | В read-only сеть sandboxed-команд выключена; запросы модели идут от процесса CLI | 0B | H |
| Общая `.git`, журналы, исходная папка | Запись запрещена Seatbelt; чтение разрешено | 0B | H |
| Унаследованное | `--ignore-rules` отключает execpolicy `.rules`; MCP и hooks из user config отключены вместе с `config.toml`. Грузятся ли проектный `.codex/config.toml` и hooks без trust — неизвестно | 0B C1: фиктивный hook-маркер в репо | H |

Лид может изменить дерево, только если read-only не сработал. Поэтому после каждого хода лида оркестратор сверяет fingerprint копии; изменение → `paused(lead_modified_tree)`. Это событие безопасности, а не рабочий случай.

Открытый вариант (не принят): запускать весь процесс Codex CLI под собственным Seatbelt-профилем с deny на секреты, кроме `auth.json`. Тогда `auth.json` останется читаемым для команд лида. Выигрыш неочевиден; оценить после 0B.

**Исполнитель (Claude, `claude -p --permission-mode dontAsk`)**

| Канал | Механизм | Проверка | Статус |
|---|---|---|---|
| Окружение CLI | OAuth/keychain; `~/.claude.json` читается всегда; managed policy грузится независимо от `--setting-sources` | agent-sdk claude-code-features «What settingSources does not control» | D |
| Окружение команд | Оркестратор запускает claude с явным минимальным env: `PATH HOME USER LANG TMPDIR CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 ENABLE_CLAUDEAI_MCP_SERVERS=false` (без `USER` или с фиктивным HOME `claude auth status` даёт `loggedIn=false` — L, ревизия 4), плюс `sandbox.credentials` | 0B K3: `env` через Bash | H |
| Файловые инструменты (Read/Edit/Write) | **Не проходят через Seatbelt.** Ограничены только permission rules и рабочими каталогами: явные deny `Read/Edit` на исходный репо, `.git` копии, `~/.ssh/**`, `~/.aws/**`, `~/.codex/**`, `~/.claude/**`, userData | permissions.md; 0B K3: Edit `.git/config` → deny | D/H |
| Bash и потомки | Seatbelt Claude sandbox: `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands:false`, `autoAllowBashIfSandboxed:false`, `filesystem.denyRead` для секретов | sandboxing.md; 0B K3 | D/H |
| Сеть | Прокси sandbox без `allowedDomains` + `strictAllowlist:true` в `--settings`; WebFetch/WebSearch не в `--tools` | sandboxing.md; settings-reference | D |
| Общая `.git` | В режиме clone своя `.git` копии лежит в cwd. Claude защищает только `hooks/` и `config`; refs и HEAD копии агент изменить может. Не критично: результат берётся из снимка дерева, а не из refs копии | sandboxing.md «Git worktrees» | D |
| Исходный репо | Путь вне cwd → запись Bash запрещена Seatbelt; файловые инструменты — deny rule | 0B H6 | D/H |
| Унаследованное | `--setting-sources ""`, `--strict-mcp-config`, `--disallowedTools "mcp__*"` (коннекторы claude.ai грузятся при OAuth), `--disable-slash-commands`, `disableAllHooks` в `--settings`. Managed policy отключить нельзя: сравниваем `system/init` с ожидаемым набором; расхождение → отказ запуска. Принимает ли `--setting-sources` пустую строку — не проверено; базовые пробы 0B используют `--safe-mode` | D; 0B K1/K3 | D/H |

`Bash(git commit *)` в deny не мешает изменить Git через `git -c`, `sh -c`, `env git`, прямую запись в `refs/` или файлы-указатели. Защита строится не на deny-списке, а на изоляции копии (clone) и сверке fingerprint после хода.

**Runner проверок** — см. §4.

**Оркестратор (main, доверенная зона, без песочницы)**

- Git вызывается только так: `GIT_DIR=<gitdir> GIT_WORK_TREE=<copy> GIT_INDEX_FILE=<tmp> GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c core.hooksPath=/dev/null -c core.fsmonitor=false …`. Discovery (`git -C <copy>`) не используется (L: подмена `commondir` и файла `.git` даёт исполнение кода при discovery).
- Остаётся локальный config копии (filters, `diff.external`, `core.sshCommand`). Config копии создаёт оркестратор; его fingerprint сверяется до и после каждого хода. Изменение → `paused(shared_git_tampered)`.
- Журнал и `state.json` в userData пишет только оркестратор. Агентам запрещены чтение и запись userData (Seatbelt Bash — D, файловые инструменты — deny rules, H).

### 3.2. Рабочая копия

1. `git clone --shared --no-checkout <src> <userData>/runs/<runId>/repo`, затем `checkout --detach <baseline>` — делает оркестратор с hardened-флагами. Обычный локальный clone не использовать: он делает жёсткие ссылки на объекты (L).
2. Baseline при незакоммиченных изменениях — снимок через временный индекс исходного репо (`read-tree HEAD; add -A; write-tree; commit-tree`) с hardened-флагами. Исходный индекс и дерево не меняются (L). Снимок сразу получает ref `refs/canvastty/<runId>/baseline`, иначе `gc` может его удалить.
3. Checkpoint принятого этапа: снимок дерева копии → `commit-tree` → `fetch` в `refs/canvastty/<runId>/stage-<n>` исходного репо с hardened-флагами (L: хуки не срабатывают). Ветка пользователя не создаётся и не двигается автоматически.
4. Риск `--shared`: `git gc --prune` в исходном репо может удалить объекты, нужные копии. Мера: fetch результата сразу после каждого checkpoint; baseline защищён ref'ом.
5. Worktree остаётся только как fallback. В этом режиме fingerprint общего gitdir (`for-each-ref`, `packed-refs`, `config`, `hooks/*`, `info/*`, `worktrees/*/{commondir,gitdir,HEAD}`, файл `.git`) сверяется до и после каждого хода. Детекция срабатывает после факта: hook мог уже выполниться.
6. Submodules и LFS в MVP не поддерживаются. Детектор при старте: gitlink в `ls-files -s`, наличие `.gitmodules` или LFS-атрибутов → отказ с объяснением.

## 4. Ограниченный runner проверок (замечание 2)

Разрешённое имя команды и неизменный `scripts.test` не делают код неизменяемым: тесты и `src/` меняет агент. Гарантию даёт только песочница. Результат runner — данные для ревью, а не доказательство безопасности.

**Граница доказательств.** Всё ниже проверено на прототипе runner (`experiments/permissions/sb/`, `validate.sh`) на одноразовой фикстуре с фиктивным HOME и фиктивным userData. Это доказательства только для runner проверок; изоляцию Claude Code (его sandbox и файловые инструменты) и read-only режим Codex они **не** доказывают (§3.1, 0B).

**Цепочка процессов:** supervisor (вне песочницы, чтобы слать сигналы) → `sandbox-exec -p <runner.sb + opt-in фрагменты> -D …` → `/usr/bin/env -i HOME=<run>/home PATH=[TOOLCHAIN/bin:]/usr/bin:/bin TMPDIR=<run>/tmp LANG=C` → команда (прототип `sb.sh`). Обёртка отказывается запускаться (rc=2), если параметр — не существующий разрешённый путь: Seatbelt сравнивает реальные пути (`/tmp` ≠ `/private/tmp`).

Метод проверки: `validate.sh` строит фикстуру; каждая проверка сначала выполняется **вне** песочницы тем же probe с тем же env (положительный контроль: файл существует и доступен), затем внутри — прямо, у внука (`sh -c 'sh -c …'`) и у detached-потомка. rc≠0 при любом непрошедшем контроле или несовпадении. Итог последнего прогона: 39/39 проверок в каждом из 6 вариантов, `PASS` (L).

**Минимальный профиль `runner.sb` (без сети и без PTY):**

| Аспект | Политика | Статус |
|---|---|---|
| Команда | Задаётся конфигом цели и подтверждается пользователем, например `node --test --test-concurrency=1 tests/*.test.mjs`. Лид выбирает только из этого списка; новая команда → `awaiting_answer` | — |
| Рабочая копия внутри userData | Deny всего `USERDATA`, затем узкий allow read/write на `<userData>/runs/<runId>/{repo,tmp,home}`; в Seatbelt выигрывает последнее совпавшее правило. Копия, tmp, фиктивный HOME доступны; `state.json`, листинг userData, соседний run — нет | L |
| Окружение | `env -i`: внутри только `HOME LANG PATH TMPDIR` + служебные `PWD SHLVL _ OLDPWD` оболочки и `__CF_USER_TEXT_ENCODING` у node. Выставленные снаружи `FAKE_PARENT_TOKEN`, `ELECTRON_RUN_AS_NODE` внутрь не попадают | L |
| Фиктивный HOME | `HOME=<run>/home` | L |
| Секреты | Deny read/write под `REALHOME`: `.ssh .aws .codex .claude .claude.json .config/gh .config/git .npmrc .gitconfig .netrc .docker .kube .gnupg Library/Keychains` — все 14 фиктивных файлов и `ls ~/.ssh` denied. Это **deny-список**: прочие файлы `$HOME` в минимальном профиле читаемы | L (фикстура) |
| Весь `$HOME` | Opt-in `denyhome`: deny всего `REALHOME` + узкие allow (run, зависимости, `TOOLCHAIN` read-only). Проверено: чтение `~/notes.txt` denied. **Не обеспечено:** запуск бинарника из запрещённого каталога разрешён (deny чтения не мешает exec); toolchain под `$HOME` (на этой машине node в `~/.hermes/node`) требует явного `TOOLCHAIN` | L, частично |
| Исходный репо | Deny `SRCREPO`; read-only allow только `SRCREPO/node_modules` (symlink из копии) и `SRCREPO/.git/objects` (без них `git log` в `clone --shared` даёт `bad object HEAD`). Запись в `node_modules` — denied. Объекты истории исходного репо читаемы | L |
| Метаданные предков | `file-read-metadata` (stat, не readdir) для предков разрешённых путей: без него не работают `cd`, `realpath`, поиск alternates git | L |
| Запись | Только копия, tmp, фиктивный HOME, `/dev/null`. Запись в `REALHOME`, `outside/`, `DARWIN_USER_TEMP_DIR`, `state.json`, корень userData, соседний run, `SRCREPO` — denied | L |
| Сеть | Никакой: localhost, внешний TCP и DNS — denied. Ревизия 2 утверждала «внешний TCP и DNS запрещены», но `net.js` падал с `require is not defined` (корневой `package.json` — `"type":"module"`), так что тот вывод ничего не доказывал; исправлено (`net.cjs`) и перепроверено с положительным контролем | L |
| PTY | Нет: openpty и открытие чужого pty — denied | L |
| Keychain | Файловый deny на фиктивный `login.keychain-db` — L. Доступ к securityd и реальный элемент не проверялись | L частично / H |
| Дочерние процессы | Seatbelt наследуют внуки и detached-потомки (39/39 у каждого). Kill группы и sweep — supervisor (§6) | L |
| Hardlink | Политика path-based: hardlink на секрет, созданный **вне** песочницы внутри копии, читается; изнутри создать нельзя | L; не обеспечено для внешних hardlink |
| Лимит числа процессов | На macOS не принуждается (нет cgroups) | не обеспечено |
| Зависимости | Пользователь готовит `node_modules` в исходном репо; в копии symlink, только чтение. Хэш `package-lock.json` копии ≠ baseline → `not_verified(deps_changed)`. `npm ci` в MVP не выполняется | L (symlink) |
| Самотест | Перед проверками runner прогоняет probe с положительным контролем; непрошедший контроль или отказ → `not_verified(sandbox_unavailable)` | прототип `validate.sh` (L); встроенный самотест — не реализован |
| Тесты проекта в профиле | Не запускались | H12 |
| Linux, Windows | Реализации нет → `not_verified(sandbox_unavailable)` | — |

**Дополнительные возможности (opt-in, по одной на проверку, выбирает пользователь в конфиге цели; по умолчанию выключены):**

| Возможность | Что даёт | Что не обеспечено |
|---|---|---|
| `unix` | Unix-сокеты только внутри `TMP`: свой сокет работает; подключение к сокету и listen вне `TMP` — denied (L) | Путь `<userData>/runs/<id>/tmp/…` длиннее лимита `sun_path` (104 байта) — сокет открывается по относительному пути из cwd=TMP. **Рекомендуемая замена TCP** для тестов, которым нужен локальный сервер |
| `localhost` + `PORT` | TCP только на `localhost:PORT`: свой сервер работает; случайный порт и чужой сервис на другом порту — denied (L) | Правило различает порт, а не владельца: **чужой сервис на том же порту доступен**. Bind `0.0.0.0:PORT` разрешён, и сервер в песочнице принимает подключения на LAN-IP машины (проверено с этой же машины). Хост в правиле — только `localhost` или `*`, сузить нельзя |
| `pty` | openpty для тестов node-pty (L) | openpty требует read+write на все `/dev/ttys*`; **открывается и чужой tty того же uid** (проверено на pty, созданном вне песочницы). Вариант `(allow pseudo-tty)` + только `/dev/ptmx` не работает. Сузить не удалось. TIOCSTI не проверялся |

Эти ограничения не являются принятыми рисками: пользователь их не принимал. До решения по ним проверки, которым нужен `localhost` или `pty`, в MVP получают `not_verified` либо запускаются только после явного включения возможности в конфиге цели с показом перечисленных ограничений; какой вариант выбрать — вопрос ревью ревизии 3.

**Статусы проверки:** `passed | failed | not_verified{sandbox_unavailable | timeout | cleanup_unverified | deps_changed | unsupported_repo | interrupted}`. `not_verified` никогда не превращается в успех. `passed` требует exit 0, `process.exited.groupCleared=true` и пустого sweep; для беглецов из группы sweep работает по возможности (§6).

**Node/Electron ABI:** `node_modules/node-pty/build/Release/pty.node` экспортирует `napi_register_module_v1` и не импортирует символы v8, собран `electron-rebuild` под Electron 43.2.0 (установлено чтением бинарника: `nm`, `otool -L`, `config.gypi`). Это **не** доказывает, что модуль загрузится в обычном node, и не доказывает обратного: N-API-экспорт не исключает других несовместимостей (зависимости, путь сборки, поведение при загрузке). Загрузка не запускалась — H9. `npm test` импортирует node-pty транзитивно через `src/main/services/TerminalManager.ts:4`. Для повторного использования `node_modules` между платформами гарантий нет: `electron-rebuild` и prebuilds зависят от ОС и arch, поэтому копия всегда использует `node_modules` той же машины.

## 5. Поток событий (замечание 3)

Прототип: `experiments/processes/jsonl.ts`, регрессионные тесты `jsonl.test.ts` — 16/16 (L, ревизия 3).

| Параметр | Значение |
|---|---|
| Фрейминг | Разбор по байту `0x0A` в `Buffer` до декодирования. Незавершённая строка — один растущий `Buffer` (удвоение, потолок = `maxMessageBytes`), без объекта на каждый фрагмент. Разрезанный UTF-8 невозможен по построению |
| Декодирование | `TextDecoder('utf-8', {fatal: true})` для полной строки, снятие `\r`, пустые строки пропускаются |
| `maxMessageBytes` | 16 МиБ на строку (калибровка в 0B) |
| `maxStreamBytes` | 512 МиБ на процесс |
| Накопление | `TurnCollector{maxEvents, maxErrors}` хранит первые N событий и ошибок, остальное только считает (`droppedEvents/droppedErrors`, одна запись `overflowAt`). Терминальные события (до 2) и индекс последнего кадра учитываются точно, поэтому `reconcile` корректен и после переполнения |

| Случай | Поведение |
|---|---|
| UTF-8 разрезан между chunk'ами | Собирается корректно (тест на каждой границе байта) |
| Много мелких фрагментов | Корректно; тест на ≥ 1e5 фрагментов по 1–3 байта без квадратичного роста времени |
| Неизвестный `type` | Событие сохраняется, ход не падает |
| Строка > лимита | `oversized` эмитится **один раз сразу в `push()`** в момент превышения, без ожидания `\n`/EOF; далее строка отбрасывается подсчётом до `\n` без накопления, затем разбор возобновляется. Ход → `protocol_error` и Stop |
| Невалидный UTF-8/JSON, не объект, нет `type` | `protocol_error` с видом ошибки |
| Хвост без `\n` при конце stdout | `unterminated_tail`: не разбирается и не считается терминальным событием (после `oversized` не дублируется) |
| Поток > 512 МиБ | `stream_limit`, дальше не копится |
| Терминальное событие | Codex: `turn.completed`/`turn.failed`. Claude: `result` (успех только при `subtype=success` и `is_error=false`) |

**Память (L, `node --expose-gc mem-check.ts`, один прогон на этой машине).** Метод: `gc()` дважды → baseline; `process.memoryUsage()` раз в 16 chunk'ов по 64 КиБ, пик по каждому полю; `gc()` дважды → «после».

| Сценарий | heapUsed, пик | arrayBuffers, пик | RSS, пик / после gc |
|---|---|---|---|
| A: одна строка 200 МБ, лимит 16 МиБ; байты сверх лимита **отбрасываются**, не хранятся | +0,7…0,9 МиБ | +31,9 МиБ (≈ 2× лимита: удвоение буфера + отставание GC) | +26…28 МиБ / не возвращено ОС |
| B: 200 МБ строками по 1 КиБ, коллектор `maxEvents=1000` | +3,2…3,3 МиБ | +0,1 МиБ | +7,4…7,5 МиБ |

Прежняя формулировка ревизии 2 («строка 200 МБ при пике 18,8 МиБ») была неверной: 200 МБ отбрасывались, а 18,8 МиБ — только `arrayBuffers`. Ограничения замера: выборка может пропустить всплески между точками; `arrayBuffers/external` включают ещё не собранные буферы; RSS включает кодовые страницы и резерв аллокатора и не возвращается ОС сразу; замерен только фреймер и коллектор, а не продукт; это не доказательство отсутствия утечек.

**Итог хода: три разных факта.**

1. **Результат агента** — терминальное событие в stdout.
2. **Завершение процесса** — `exit` лидера (код/сигнал) **и** конец stdout; отдельно — был ли сигнал отправлен supervisor (`signalsToLeader` из статуса `done`, сигнал или код `128+n`).
3. **Решение цикла** — после принятого Stop следующий ход не запускается при любом итоге хода: `nextTurnAllowed(outcome, stopAccepted) = !stopAccepted && outcome = completed`.

Порядок: терминальное событие → завершение процесса → решение цикла. Время кадров и момент Stop берутся по часам main: результат считается «до Stop», только если main получил его строго раньше, чем отправил Stop.

**`reconcile(collector, processFacts)`**, первое сработавшее правило:

1. Ошибка фрейминга → `protocol_error`.
2. Больше одного терминального события → `protocol_error(multiple_terminal_events)`.
3. stdout не закрылся через 2 с после `exit` → kill группы → `protocol_error(stdout_held_open)`.
4. Терминального события нет: supervisor просигналил живого лидера по Stop и процесс завершён нашим сигналом или `exit 0` → `stopped`; Stop был, но выход другой (например `exit 42`) → `failed(exit_during_stop)`; Stop не было или он пришёл после выхода → `protocol_error(no_terminal_event)`.
5. События после терминального → `protocol_error(events_after_terminal)` (правило может ослабнуть по итогам 0B).
6. Терминальное событие неуспеха → `failed`.
7. Успех и `exit 0` → `completed`.
8. Успех и ненулевой выход → `completed` **только** если Stop отправлен после получения результата и процесс завершён нашим сигналом; иначе `failed`. Сам факт Stop не превращает произвольную ошибку (`exit 42`, чужой сигнал) в успех.

Тесты покрывают Stop до результата, Stop после результата (ход `completed`, `nextTurnAllowed=false`) и Stop одновременно с ошибкой (успех + 42, 42 без результата, `turn.failed` + наш сигнал, чужой сигнал, результат после Stop, Stop после выхода) — ни один не даёт `completed` (L).

Конец хода определяется по `exit` **и** концу stdout, а не по `close`: 'exit' может прийти до данных (L), а потомок, удерживающий stdout, блокирует 'close' навсегда (L). Обрезка текста — только для отображения после разбора.

Структурированный отчёт (`--output-schema` у Codex — финальное сообщение попадает в файл `-o`, stdout после `turn.completed` пуст (S); `--json-schema` у Claude — `result.structured_output` (D)) валидируется в main. JSON разобран, но не прошёл схему → `paused(invalid_report)`.

## 6. Остановка и владение процессами (замечание 4)

**Ограничения существующего кода** (не копировать):
- `ProviderElectronSmoke.ts:539-551` — `terminate` возвращается, если лидер вышел; потомки в группе выживают (L, сценарий a). SIGKILL проверяет только лидера. Нет фазы SIGINT. Таймер `unref` — при выходе приложения не срабатывает.
- `LimitsService.ts:842-866` — `child.kill()` бьёт только прямого потомка; группа не используется; SIGKILL через `unref`-таймер.

**Механизм:** supervisor на каждый процесс провайдера и каждую проверку. Это отдельный Node-процесс из `process.execPath` с `ELECTRON_RUN_AS_NODE=1` (прототип `experiments/processes/supervisor.mjs`, тесты `supervisor.test.mjs` на mock CLI — 14/14, L).
- Supervisor в своей группе, цель — в своей отдельной группе. stdout/stderr цели идут напрямую в main.
- **Каналы разделены:**
  - fd0 — lifeline и управление. Команда — только целая строка `{"cmd":"stop"}`; прочее → `control_ignored`, строки > 4 КиБ отбрасываются. **EOF fd0 = main потерян** → остановка.
  - fd4 — байты задания; supervisor передаёт их в stdin цели как есть и на EOF fd4 закрывает stdin цели. **EOF задания — не остановка.** Строка «stop» в задании ничего не останавливает: этот канал не разбирается.
  - fd3 — статус: `started{pgid, env:[имена]}`, `task_eof`, `task_write_error{code}`, `stop_requested`, `leader_exit`, `done{…}` ровно один раз.
- **Окружение цели** — только имена из allow-list (`SUP_ENV_ALLOW`, по умолчанию `PATH HOME USER LOGNAME SHELL TMPDIR LANG LC_ALL LC_CTYPE TERM TZ`); переменные авторизации CLI main перечисляет явно. `ELECTRON_RUN_AS_NODE` и `SUP_*` вырезаются всегда. В статус попадают только имена, значения не печатаются.
- Отсутствие исполняемого файла → `done{error:"spawn", code:"ENOENT"}`, exit 1; EPIPE при записи задания не роняет supervisor.
- **Один путь завершения:** обработчики exit/stop/lifeline только записывают факты. Stop во время работы: SIGINT лидеру (5 с; у Codex это единственный путь к interrupt, S) → SIGTERM группе (3 с) → SIGKILL группе. Естественный выход лидера: 2 с на выход остальных (Stop сокращает ожидание), затем та же эскалация. Потеря main: то же, начиная с SIGTERM лидеру. Лидеру сигнал шлётся только до reap, группе — только пока `kill(-pgid, 0)` успешен.
- Устранённые гонки ревизии 2: `process.exit` из обработчика exit во время эскалации stop; два независимых цикла ожидания/сигналов; сигнал опустевшей группе; подстрока `stop\n` в любом месте fd0 останавливала запуск; задание не доходило (`stdin=ignore`); цель наследовала `ELECTRON_RUN_AS_NODE`.

Почему supervisor: на macOS нет `PR_SET_PDEATHSIG` и pidfd; kqueue `EVFILT_PROC` из Node без нативного модуля недоступен. Electron `utilityProcess` при SIGKILL main умирает за < 300 мс без JS-очистки (L, d′). Supervisor через `ELECTRON_RUN_AS_NODE` убрал группу за ≤ 1,5 с после краха main (L, d″; перепроверено на протоколе ревизии 3). В тестах SIGKILL промежуточного «main», держащего fd0, → группа и supervisor исчезли ≤ 3 с (L). Без supervisor молчаливая detached-группа живёт бесконечно (L, d).

Цена: новая точка запуска с `runAsNode`. Нужно дополнение к ADR-20260913-packaged-fuses-keep-run-as-node (инварианты 4–5).

**Обещание Stop (точная формулировка для UI и документации):**

> Stop прерывает текущий ход и завершает все процессы, оставшиеся в группе процессов запуска: сначала мягко (SIGINT CLI, затем SIGTERM), потом принудительно SIGKILL, в сумме не позже чем примерно через 10 с. При аварийном завершении CanvasTTY то же делает supervisor. Не гарантируется завершение процессов, которые сами вышли из группы (setsid, detached-демоны, запущенные агентом или его инструментами), а также процессов, если supervisor тоже убит принудительно. Найденные «возможно оставшиеся» процессы CanvasTTY показывает, но без подтверждения не завершает.

Зависание main (не краш) lifeline не обнаруживает; heartbeat не делается, пока нет такого сценария.

**Поиск беглецов (sweep), best effort:**
- env-маркер `CANVASTTY_RUN_TOKEN` (128 бит) через `ps -axE -ww` виден **только у не-платформенных бинарников своего uid** (node — да; `/bin/sh`, `/bin/sleep`, `/usr/bin/perl` — нет, L);
- второй признак — cwd внутри копии через `lsof -d cwd` (H: проба ревизии 2 недостоверна, VALIDATION-MATRIX P14);
- оба признака обходятся (очистка env, `chdir`).

**Сигналы после краха приложения:**
- Сохранённому PID/PGID без подтверждения не сигналим: на этой машине pid прокручиваются примерно за 6 минут (~290/с, L).
- В норме supervisor уже убрал группу, recover ничего не сигналит.
- Если процесс найден по токену (свой uid) и `LC_ALL=C ps -o lstart` ≥ времени старта запуска — сигнал поштучно, с перепроверкой непосредственно перед `kill`.
- Остаточная гонка: между проверкой и `kill` процесс может выйти, а его pid достаться новому процессу. Окно — миллисекунды, вероятность порядка 1e-5 и ниже, но не ноль. Полностью снимает риск только живой supervisor (родитель лидера) с `kill(-pgid)` при непустой группе: пока группа существует, её pgid не переиспользуется.

## 7. Модель, восстановление и команды (замечание 5)

**Goal** (неизменяемая): цель, критерии приёмки, allow-list проверок, модель лида, `reviewPlan` (по умолчанию `false`: run стартует автоматически и не останавливается на плане). Лид сообщает `goalCriteriaStatus`, но критерии не меняет. Критерии меняет только пользователь, создавая новую цель.

**Run:** `workspacePath`, `baseline`, `limits` (версионируются только командами пользователя), план, счётчики, `revision`, `layoutRevision` (геометрия трёх подслоёв; не сбивает CAS команд).

**RunStatus:** `preparing | running | pausing | paused | stopping | stopped | completed | failed`. Терминальные — `stopped`, `completed`, `failed`; после перезапуска они не меняются. Нетерминальный run, прерванный крахом, получает при перезапуске `paused(outcome_unknown)`, если был незавершённый ход или грязная сверка, иначе `paused(recovered)`.

**paused.reason:** `user_request`, `step_done`, `plan_review`, `awaiting_answer{questionId}`, `recovered`, `outcome_unknown`, `invalid_report`, `protocol_error{kind}`, `limit_reached{kind}`, `permission_denied`, `loop_suspected`, `lead_modified_tree`, `environment_error`, `shared_git_tampered`, `journal_corrupt`, `sandbox_unavailable`.

**StageStatus:** `pending | active | review | fixes_requested{round,max} | accepted{checkpointSha} | blocked | superseded`.

**TurnStatus:** `queued | running | completed | failed | stopped | protocol_error | outcome_unknown` (смысл — §5). `outcome_unknown` выставляет только восстановление. Повтор формирования отчёта — `attempt 1` того же хода.

**CheckRunStatus:** §4. Прерванная проверка после перезапуска → `not_verified(interrupted)`, без автоповтора.

**Правила восстановления:**
- Незавершённый ход с неизвестным исходом никогда не повторяется автоматически.
- Отсутствие записанного `thread_id` не означает отсутствия побочных действий: процесс мог писать файлы до первого события.
- При восстановлении: снимок дерева копии, diff против последнего checkpoint, fingerprint gitdir, sweep по токену и cwd. Результат — событие `recovery.inspected{orphansFound, killed:[pid+lstart]}` и показ пользователю.
- Повтор формирования отчёта (один раз, решение ревизии 1) — только если ход завершился `completed` по §5, а JSON не прошёл схему. После Stop или краха повтора нет.

**Команды:** `orchestration:command {runId, commandId, expectedRevision, command}`.
- `commandId` — UUID от UI, пишется в журнал (`command.received`). Повторная доставка возвращает сохранённый результат и не исполняется второй раз. Тот же `commandId` с другим payload → отказ `command_id_reused`.
- `expectedRevision` решает другую задачу — отказ команде от устаревшего UI. Механизмы ортогональны.

| Команда | Допустимо из |
|---|---|
| `pause_after_turn{on}` | `running` → `pausing`; `off`: `pausing` → `running` |
| `stop` | `preparing`, `running`, `pausing`, `paused` (любая причина) |
| `step` / `resume` | `paused`: `user_request`, `step_done`, `plan_review`, `permission_denied`, `loop_suspected`, `environment_error`, `recovered`. Из `invalid_report` и `protocol_error` — только `step` |
| `answer{questionId,text}` | `paused(awaiting_answer)` с тем же id |
| `clarify{text}` | `preparing`, `running`, `pausing`, `paused` (кроме `journal_corrupt`) |
| `recover{accept \| retry_turn \| reset_to_checkpoint, confirm}` | только `paused(outcome_unknown)` |
| `raise_limit{kind,value}` | `paused(limit_reached)` |
| `dismiss` | `stopped`, `completed`, `failed` |

- `recover: accept` — сохранить найденные изменения как recovery-снимок (trailer `CanvasTTY-Snapshot: <runId>:<turnId>:recovery`, это **не** checkpoint) и отправить их на проверки и ревью. Этап не принимается, критерии не отмечаются.
- `recover: retry_turn` — новая сессия провайдера; сохранённый id хода сбрасывается.
- `recover: reset_to_checkpoint` — к последнему принятому checkpoint, если его нет — к baseline; только с `confirm`; только в копии; снимок перед откатом остаётся в `refs/canvastty/` для аудита.
- `lead_modified_tree`, `shared_git_tampered`, `journal_corrupt`, `sandbox_unavailable` в MVP допускают только `stop` (и экспорт журнала). Это события безопасности или целостности; продолжение без расследования не предлагается.

**Уточнения пользователя:**
- `clarify` пишет событие `clarification.added{version, textRef}`; версии монотонны.
- Уточнение доставляется следующим resume-ходом лида. В идущий ход оно не попадает: задание передаётся в stdin CLI целиком и закрывается EOF; дописывать в идущий ход некуда (§6).
- Ревью и `final_verdict` хранят `clarificationVersion`. Ревью с устаревшей версией помечается stale.
- Переход в `completed` разрешён только при финальном ревью на актуальной `clarificationVersion` и актуальном fingerprint. Если `clarify` пришёл во время финального ревью, после него выполняется ещё один ход лида; запуск не завершается без учёта принятого уточнения.
- Лид не вправе менять критерии; уточнение, противоречащее критериям, лид возвращает как `question` → `awaiting_answer`.

## 8. Журнал и хранение (замечание 6)

- **Авторитетный источник** — `runs/<runId>/journal.jsonl` (append-only, `prevHash`, fsync). `state.json` и UI-представление — производные: при старте они восстанавливаются replay журнала; при расхождении прав журнал.
- **По умолчанию** в журнал пишутся только нормализованные события с перечисленными полями: тип, время, `runId/turnId/commandId`, статусы, коды выхода и сигналы, хэши и id снимков, имена изменённых файлов и счётчики `+/-`, длительности, usage. Без текста модели, вывода команд, содержимого файлов и аргументов инструментов.
- **Лента для UI** (`events` в IPC) строится из того же журнала. Короткие фрагменты текста для отображения (сообщения агента, хвост вывода команд) хранятся отдельно в `runs/<runId>/display/` с лимитом на событие и удаляются вместе с run.
- **Raw JSONL провайдера** — только opt-in на один run, отдельный файл, TTL 7 дней с автоудалением, пометка в UI «может содержать секреты и содержимое файлов».
- **Тексты пользователя и отчёты агентов** (цель, уточнения, план, ревью) — `texts/<sha256>` до 64 КБ, журнал ссылается по хэшу. Ограничения: эти тексты могут содержать то, что пользователь или агент в них написали, включая секреты; удаление — только вместе с run (команда «удалить run»). Провайдеры хранят свои транскрипты сами (`~/.codex`, `~/.claude`); CanvasTTY ими не управляет и не удаляет их.
- **Redaction** — best effort по известным форматам (`sk-…`, `ghp_…`, `AKIA…`, PEM). Распознавание всех секретов не обещается.
- **Граница хэш-цепочки:** она обнаруживает перестановку, удаление и порчу отдельных записей внутри файла и оборванную последнюю запись. **Уточнение (Р2):** прежняя формулировка «обнаруживает обрезку» неверна — без независимо сохранённого последнего хэша удаление целого корректного хвоста (обрезка по границе записи) не обнаруживается: оставшийся префикс — исправная цепочка. Цепочка не защищает и от переписывания файла процессом с правом записи — тот пересчитает её. Защита от переписывания — только запрет записи в userData для агентов (§3). Внешний якорь хэша — отложено. Ошибка цепочки → `paused(journal_corrupt)`, автоматических действий нет.

## 9. Прогресс, доказательства и бюджет (замечание 7)

**Прогресс** — хотя бы одно из:
- новая проверка на новом fingerprint с другим исходом (failed → passed или сократился набор падающих проверок);
- замечание закрыто и это подтвердил лид в ревью (слов исполнителя в `addressedFindings` недостаточно);
- этап принят;
- пользователь ответил или уточнил.

**Не прогресс:** повторный зелёный прогон на том же fingerprint; изменение дерева само по себе («активность»); selfChecks исполнителя; исследовательский ход лида.

**`loop_suspected`** (пауза, не ошибка) — при любом из условий:
1. N (технический дефолт 3) раундов «исполнитель → ревью» подряд без прогресса;
2. одинаковый набор нормализованных открытых замечаний в двух ревью подряд, хотя дерево между ними менялось;
3. повтор пары «fingerprint + набор исходов проверок» без прогресса между повторами (A → B → A с теми же падениями).

Одиночный возврат дерева к прежнему состоянию — только сигнал в UI, не доказательство зацикливания. Откаты через `reset_to_checkpoint` исключаются.

**`evidenceFingerprint`** — хэш от: treeSha копии (с неигнорируемыми untracked); хэшей `package-lock.json` и `node_modules/.package-lock.json`; версий node, npm, electron, git; platform/arch; определения проверки (argv и текст скрипта — для воспроизводимости, не для безопасности); env allow-list (имена и хэши значений); хэша профиля sandbox и результата самотеста; режима изоляции копии; хэшей явно перечисленных игнорируемых конфигов (например `.env*`, только хэш).

Честно не охватывается: глобальные кэши (`~/.npm`, кэш Electron), прочие инструменты в PATH, внешние сервисы, время и локаль, flaky-тесты, состояние ОС и дисплея, игнорируемые файлы вне списка. Смена fingerprint делает доказательство устаревшим (нужен перезапуск проверки), а не проваленным.

**Usage, стоимость и ограничения:**

| Что | Источник | Статус |
|---|---|---|
| Токены Codex | `turn.completed.usage` | факт провайдера (S) |
| Токены Claude | `result.usage` | факт провайдера (D) |
| Стоимость Claude | `result.total_cost_usd` | клиентская оценка; при resume может быть накопительной → считаем дельту (H до 0B) |
| Стоимость Codex | нет | не показывается |
| `--max-budget-usd X` | Claude | обеспечивается только на один процесс `claude`, не на Codex и не на серию; срабатывает после превышения, не точно (D) |
| `--max-turns N` | Claude | в `claude --help` 2.1.278 **отсутствует** (R, ревизия 4); прежнее основание — только документация. Не использовать, пока способ не подтверждён |
| Ходы, раунды, перепланирования, ходы без прогресса | мы | обеспечиваем сами; технические дефолты 40 / 8 на этап / 3 / 3 / 3, пользователь меняет |
| Время run и таймаут хода | мы (supervisor) | обеспечиваем сами; технические дефолты 4 ч, лид 20 мин, исполнитель 45 мин |
| Денежный лимит на run | — | **не задан**; выбирает пользователь. Если задан — применяется только к Claude (дельты оценки + `--max-budget-usd` на ход); UI явно сообщает, что Codex в него не входит |

## 10. Пользовательский сценарий и связь карточек (замечание 8)

**Наблюдения по коду:** связей между карточками в холсте сейчас нет (grep `edge|connector|link|arrow` по `src/renderer/src` находит только панораму `edgePan.ts`, диалог гиперссылок и иконки). Единственная группировка — `CanvasRegion` (пространственная вложенность, отношений не хранит). Виды слоёв — `canvasSelectionGesture.ts:7`.

**Исходный сценарий (сохраняется):** лид и исполнитель — отдельные управляемые сессии, каждая со своей карточкой агента на холсте. Пользователь соединяет их мышью направленной связью «лид → исполнитель» и задаёт цель. Лид автоматически разбивает цель на этапы; по умолчанию запуск идёт сразу, без остановки на плане. Просмотр плана — переключатель цели `reviewPlan` (по умолчанию выключен); включённый даёт `paused(plan_review)` после первого плана.

**Карточка агента:** слой нового kind `agent` (`agent:<agentId>`): провайдер (Codex/Claude), роль, папка репозитория, статус своей сессии. Создаётся пунктом «Новый агент» в контекстном меню холста и палитре команд. Сессия провайдера принадлежит `OrchestrationService`; PTY-карточки `TerminalManager` агентами не являются и не конвертируются (ADR-20260913).

**Направленная связь (входит в MVP):**
- **Создание мышью:** handle-порт на карточке агента → drag на другую карточку агента. Отдельный handle нужен, потому что обычный drag занят перемещением группы и Shift-marquee (ADR-20260913-shift-drag, ADR-20260914). Направление — от карточки, с которой начат drag (лид), к карточке, где отпущено (исполнитель). Отказ с объяснением: связь с собой, с не-агентом, повтор уже существующей пары, роли не «Codex-лид → Claude-исполнитель» в MVP, карточки указывают на разные репозитории.
- **Сохранение:** сущность `AgentLink {linkId, fromAgentId, toAgentId, createdAt, revision}` в store `OrchestrationService` в main (userData), не в `AppSettings`. Переживает перезапуск приложения. Рисуется CSS-линией со стрелкой по центрам карточек под ними (`<svg>` в TSX запрещён UI_CONTRACT). Геометрия карточек — через `layoutRevision`, не сбивает CAS команд.
- **Цель на связи:** после создания связи открывается диалог «Новая цель» с предзаполненными ролями и папкой; run ссылается на `linkId`. Тот же диалог доступен из меню связи.
- **Удаление:** пункт меню связи и клавиша Delete при выбранной связи. При активном run (`preparing | running | pausing | paused`) удаление запрещено с подсказкой «сначала Stop». Удаление связи не удаляет журнал, refs и карточки агентов; терминальные run остаются доступны в истории.
- Панель run показывается рядом со связью; Stop и `dismiss` — там.

**Дополнительные точки входа:** «Новая цель» в контекстном меню пустого холста и в палитре команд создаёт пару карточек агентов и связь сразу; пункт «Новая цель в этой папке» в меню терминальной карточки предзаполняет папку.

Порядок реализации: сначала движок и IPC (этапы 1–6 ROADMAP), затем UI связи (этап 8). Интерфейс связи из MVP не исключается.

## 11. Платформы

Заявленная поддержка всего CanvasTTY не меняется (`README.md`: Linux x86_64 AppImage/deb, Windows x64, Apple Silicon macOS).

| Категория | Для новой функции |
|---|---|
| Фактически проверено | Только эта машина: macOS arm64, Darwin 27.0.0, git 2.50.1, node 26.8.1, Electron 43.2.0, codex-cli 0.155.1, Claude Code 2.1.278. Проверены `--help`/`--version` и локальные эксперименты 0A без моделей. Модельные вызовы и Electron-сборка не проверялись |
| Предполагается поддержка | macOS arm64 после 0B. Linux x86_64 — по аналогии (группы процессов, bubblewrap у Claude), но runner проверок для Linux не реализован → `not_verified` до отдельной работы |
| Пока недоступна только новая функция | Windows: нет групп процессов и sandbox Claude, `.cmd` требует taskkill или Job Object. Функция скрыта; остальной CanvasTTY работает как прежде |

## 12. Критерии MVP и готовность

Ни один компонент не объявляется готовым к реализации до внешнего ревью ревизии 3 и базовых проб 0B (ROADMAP). Ниже — критерии приёмки MVP, а не отметка о готовности.

**Итоговые критерии MVP (все обязательны):**
1. Пользователь создаёт две карточки агентов (Codex-лид, Claude-исполнитель) — отдельные управляемые сессии.
2. Пользователь **мышью** создаёт направленную связь «лид → исполнитель» через handle-порт; связь **сохраняется** и восстанавливается после перезапуска; пользователь **удаляет** связь (меню или Delete; при активном run — только после Stop).
3. На связи задаётся цель; лид автоматически разбивает её на этапы; по умолчанию run запускается автоматически; переключатель `reviewPlan` включает остановку на плане.
4. Этапы выполняются последовательно в отдельной рабочей копии; принятый этап даёт checkpoint-ref в исходном репо; ветка пользователя не двигается.
5. Stop выполняет обещание §6; после принятого Stop следующий ход не запускается.
6. Перезапуск приложения восстанавливает run по журналу по правилам §7.
7. Проверки на macOS выполняются только в runner с самотестом; иначе `not_verified`.
8. Итог хода определяется по правилам §5 с регрессионными тестами.

**Состояние по основаниям (ревизия 3):**

| Часть | Основание сейчас | Что нужно до реализации |
|---|---|---|
| JSONL-фрейминг, лимиты, `reconcile` (§5) | прототип + регрессионные тесты (L) | калибровка лимитов и порядка событий на реальных CLI (0B) |
| Supervisor, каналы задания и управления (§6) | прототип + тесты на mock CLI (L) | поведение реальных CLI на stdin/EOF и SIGINT (0B); дополнение ADR про `runAsNode` |
| Runner проверок (§4) | профиль и проверки на фикстурах (L, с оговорками §4) | тесты проекта в профиле (H12), решения по opt-in возможностям |
| Изоляция Claude/Codex (§3.1) | документация и исходники (D/S), гипотезы (H) | 0B |
| Модель статусов, команды, восстановление (§7), журнал (§8), прогресс (§9) | спецификация, не проверена кодом | ревью |
| Рабочая копия `clone --shared` (§3.2) | эксперименты git (L) | ревью |
| Карточки агентов и связь (§10) | спецификация | ревью UX; реализация после движка |
