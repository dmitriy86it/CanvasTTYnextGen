# Контракт этапа Р7: движок в main, типизированный IPC и preload

Строка 6 таблицы этапов ROADMAP. Поверх существующего `OrchestrationService` (Р5/Р6): машина состояний и журнал те же, второго нет. Карточки, связь мышью и панель run — этап 8 (в MVP, не здесь).

## 1. Владелец запусков (`src/main/services/orchestration/manager.ts`)

`createRunManager(deps)` создаётся в `initializeServices` и при создании **ничего не делает**: не создаёт каталоги, не ищет git/node, не вызывает CLI, не открывает журналы. Корень: `<userData>/orchestration` (`runs/<runId>/…` — Store Р2, `attempts/` — каталоги ходов Codex).

- **Один run — один владелец и один писатель.** Менеджер держит не больше одного `RunHandle` на run (`handles`, параллельные открытия и создания делят одно обещание). Блокировка писателя Store (Р2) по-прежнему защищает от второго процесса.
- **Создание** — только явной командой `create` (§1.1). Созданный run сразу идёт автоматически; `reviewPlan: true` ставит паузу `plan_review` после первого плана.
- **Открытие существующего run** — лениво, только по явной `command`: `openWorkspace` → `service.openRun` (Р5: незавершённые команды → `interrupted`, при необходимости `run.recovered`), **ничего не запускается**, пока команда (`resume`/`step`/…) этого не скажет.
- **Чтение без открытия**: `list`/`get` — `readRun` без блокировки, вид `runView(state)` (та же функция, что у `RunHandle.view()`), `open: false`.
- **Выход приложения** (`shutdownServices`, первым): `shutdown()` запрещает новые create/command, ждёт текущие создания и открытия (зарегистрированные до него), у каждого handle вызывает `RunHandle.shutdown()`: активная операция останавливается своим `stop()` (как при дедлайне), новое не начинается, `running`/`pausing` → `paused(user_request)`, писатель закрывается. Терминальные сессии и прочие сервисы не трогаются.

### 1.1. Идентичность запроса создания (исправлено по ревью)

`requestId` (UUID от renderer) становится `runId`. Идентичность запроса — `requestKey = sha256(canonical({source, goal}))`:
- `source` — `realpath` пути проекта: завершающий `/`, `.`/`..`, symlink на каталог, `/var` = `/private/var` дают один проект; подкаталог репозитория — другой источник;
- `goal` — нормализованная цель: `text`, `criteria`, `checks`, `reviewPlan` (по умолчанию `false`), `limits`, дополненные `DEFAULT_LIMITS`.

`requestKey` записывается в текст цели run (`run.created.goal`, поле `requestKey`; цикл его не читает). Второго журнала нет.

| Когда приходит запрос с тем же `requestId` | Тот же `requestKey` | Другой `requestKey` |
|---|---|---|
| создание ещё идёт | ждёт ту же попытку, тот же результат | `request_conflict` сразу, без git и агентов |
| run уже на диске (в том числе после перезапуска) | `{created:false}` | `request_conflict` |

Проверка `closing`, проверка незавершённого создания и регистрация новой попытки выполняются в одном синхронном шаге после `realpath`. Запрос, который ещё читал путь, когда начался `shutdown()`, получает `shutting_down`: ни run, ни писателя, ни агентов (исправлено по повторному ревью). Попытка, зарегистрированная до `shutdown()`, остаётся под его контролем: он ждёт её, созданный run ставится на `paused(user_request)` и закрывается. Проверка незавершённого создания поэтому второй попытки и второго писателя нет. Из двух одновременных разных запросов побеждает тот, что первым прочитал путь; второй получает конфликт, его проект не читается и не меняется. Если проект удалён, повтор получит `invalid_source`: `realpath` невозможен.

### 1.2. Конфигурация провайдеров приложения (исправлено по ревью)

`APP_PROVIDERS` в `manager.ts` — проверенная реальными прогонами Р6 комбинация. Renderer её не передаёт и не меняет; глобальные настройки пользователя не трогаются.

| Роль | Версия CLI | Режим | Модель и параметры |
|---|---|---|---|
| лид Codex | `codex-cli 0.155.1` | `structured-readonly` | `-m gpt-6-astra`, `model_reasoning_effort="high"` |
| исполнитель Claude | `2.1.281 (Claude Code)` | `structured-edit` (кандидат, `allowCandidate: true`) | `--model claude-sonnet-5`, `--max-budget-usd 1` на ход |

Версия измеряется `--version` при create/open. Любая другая версия, в том числе 2.1.280 (есть в списке кандидатов `providers.ts`, но реальные серии шли на 2.1.281), получает `unsupported_version` до создания run и до запуска CLI. Тестовые провайдеры проходят ту же проверку версий и ту же конфигурацию: меняются только executable и env fake CLI.

### Что выбирает main (renderer не может передать)

| Что | Откуда |
|---|---|
| supervisor, его executable, argv, env | `resolveSupervisorLaunch` (ADR runAsNode), при create/open |
| git | `findProgram("git")`: PATH процесса + `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` |
| проверки | каталог main: одна проверка `node-test` = `<realpath node> --test`, 600 с, 64 КиБ вывода. Renderer называет только id; неизвестный id отклоняется до разрешения чего-либо |
| подготовленные зависимости | `package-lock.json` и собственный (не symlink) `node_modules` в корне исходного репозитория; иначе `deps_unavailable` до создания run |
| адаптеры | §1.2; CLI из `ProviderCliRegistry`, версия — первая строка `--version`, измеряется при create/open (не на старте); env: `HOME`, `USER`, `LOGNAME`, `LANG`, `CODEX_HOME` |
| тестовые провайдеры | только `developmentEnv("CANVASTTY_ORCHESTRATION_TEST_PROVIDERS")` — абсолютный путь к JSON с fake CLI; в упакованной сборке игнорируется. Через IPC не включается |

## 2. IPC (`src/main/ipc/orchestrationIpc.ts`, типы — `src/shared/orchestration.ts`)

Все каналы регистрируются через `handleMain` из `registerIpc`: вызов не из верхнего фрейма главного окна отклоняется `assertMainRenderer` (вынесен в `src/main/ipc/mainRenderer.ts` без изменения логики) до разбора аргументов. Затем каждый аргумент проверяется: простой объект, **лишние поля запрещены**, UUID, границы строк и чисел, id проверок `^[a-z][a-z0-9-]{0,63}$`, `source` — абсолютный путь. Ошибка формы → `{ok:false, code:"invalid_argument"}` без побочных эффектов (менеджер не вызывается).

Ответ всегда `{ok:true, value} | {ok:false, code, message}` (исключение — только посторонний отправитель).

| Канал | Вход | Результат |
|---|---|---|
| `orchestration:catalog` | — | `{checks:[{id,title}]}` |
| `orchestration:list` | — | снимки всех run (`seq`, `view`, `integrity`, `open`) |
| `orchestration:get` | `runId` | снимок |
| `orchestration:create` | `{requestId, source, goal:{text, criteria, checks, reviewPlan?, limits?}}` | `{runId, created}` |
| `orchestration:command` | `{runId, commandId, expectedRevision, command}` — `command` по одному из 9 видов `RunCommand`, поля точно | `CommandOutcome` сервиса: `accepted`/`rejected` + код (`stale_revision`, `invalid_state`, …) или `in_progress`; повтор `commandId` — записанный результат без повторного действия |
| `orchestration:history` | `runId, fromSeq ≥ 0, limit 1..200` | `{records:[{seq,ts,type,data}], lastSeq, more}`; журнал нумеруется с 0, следующая страница — `last.seq + 1` |
| `orchestration:text` | `runId, sha256` | `{text}` — только текст, на который ссылается журнал этого run (`text_not_found` иначе), ≤ 64 КиБ; пути не принимаются |
| `orchestration:watch` | `runId` | снимок; далее события `orchestration:event` `{runId, seq, tick, view}` этому окну |
| `orchestration:unwatch` | `runId` | — |

Нет каналов для запуска команд, чтения файлов по пути, выбора executable/argv/env или адаптера.

### 2.1. Подписки (исправлено по ревью)

- Main хранит для каждого webContents текущую страницу: `runId → запись`. Запись создаётся синхронно при `watch`, до ожидания менеджера, с `unwatch = null`.
- Когда `manager.watch` завершился, подписка остаётся, только если страница всё ещё текущая и запись всё ещё та же. Иначе поздний результат сразу освобождается: до этого пришли `unwatch`, новый `watch`, перезагрузка или закрытие окна. Новую подписку это не затрагивает.
- События отправляются только от текущей записи. Отказ установки удаляет только свою запись.
- Обработчики `destroyed` и `did-start-navigation` ставятся один раз на webContents. Перезагрузка (навигация главного фрейма, не same-document) и закрытие освобождают все подписки страницы.
- На одну страницу и один run приходится одна подписка main; повторный `watch` заменяет прежнюю.

### 2.2. Состояние и уведомления (исправлено по ревью)

- `seq` — настоящая позиция журнала (`lastSeq`), искусственно не увеличивается. `tick` — число изменений отображаемого состояния после записи `seq`, которых нет в журнале: началась или закончилась операция (ход агента, проверка проекта), `halted` после ошибки записи. После каждой записи `tick` равен 0.
- `RunHandle.onChange` вызывается после каждой записи и после каждого такого изменения. `view()`, `seq()` и `tick()` в этот момент согласованы; пара `(seq, tick)` в пределах одного открытого handle однозначно задаёт вид и только растёт (лексикографически).
- `tick` не журналируется. При открытии run (в том числе после перезапуска) он начинается с 0, и тогда `active = null`. Поэтому пары сравнимы только в пределах одной подписки: после нового `watch` (перезагрузка, перезапуск) её снимок — новая база.
- Менеджер добавляет слушателя и снимает снимок с handle в одном синхронном шаге: каждое следующее событие новее снимка, ни одно не теряется.

## 3. Preload

`window.canvasTTY.orchestration`: `catalog`, `list`, `get`, `create`, `command`, `history`, `text`, `watch(runId, listener) → {snapshot, unwatch}`. Общего `ipcRenderer` нет; подписка только через `watch`. Логика — `src/preload/orchestrationClient.ts` (без electron, тестируется в node):
- первый слушатель run на странице вызывает `orchestration:watch`, следующие только читают `orchestration:get`; последний ушедший вызывает `unwatch`, повторный `unwatch` ничего не делает;
- слушатель сначала получает снимок как событие, затем только более новые `(seq, tick)`; события, пришедшие раньше снимка, ждут его, а не более новые отбрасываются, так что отката к старому состоянию нет;
- отказ `watch` освобождает слушателя.

## 4. Ошибки

`invalid_argument` (форма), `unsupported_version` (§1.2), `unknown_check`, `invalid_goal`, `invalid_source`, `deps_unavailable`, `provider_unavailable`, `git_unavailable`/`node_unavailable`, `unsupported_platform`/`helper_missing` (supervisor), `request_conflict`, `run_not_found`, `journal_corrupt`, `writer_locked` (run открыт другим процессом), `text_not_found`, `shutting_down`; коды Store/Workspace передаются как есть.

## 5. Восстановление после перезапуска

Старт приложения: менеджер пуст, процессов оркестрации нет. `list` показывает run как их оставил журнал (выход во время хода → `paused(user_request)`; сбой процесса → при открытии Store допишет `run.recovered`, Р2/Р5; до открытия `list`/`get` показывают запуск таким, каким его сделает открытие, — уточнение Р9, [stage-9-contract.md](stage-9-contract.md) §4). Продолжение — только явной командой (`resume`, `step`, `recover`, …) с актуальной `expectedRevision`; команда открывает run и становится его владельцем.

## 6. Проверки

`tests/orchestration-manager-review.test.mjs` (исправления ревью: идентичность запроса, отмена подписок, клиент preload, уведомления об операции и `halted`, argv fake CLI через путь менеджера, отказ версии), `tests/orchestration-manager-ipc.test.mjs` (фальшивые окна, `handleMain` как в `registerIpc`, тестовые агенты, настоящие Store, копия и проверка в песочнице) и `scripts/smoke-orchestration-ipc.mjs` (`npm run smoke:orchestration-ipc`, после `npm run build`: Electron, настоящий preload, fake CLI через `CANVASTTY_ORCHESTRATION_TEST_PROVIDERS`, два запуска на одном userData). Smoke также сверяет argv, который получили fake CLI. Результаты — VALIDATION-MATRIX (I1–I16).
