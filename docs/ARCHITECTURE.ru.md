# Архитектура

[English](ARCHITECTURE.md) · [Русский](ARCHITECTURE.ru.md)

## Границы процессов

Raoden Loom использует трёхслойную модель Electron:

```text
React renderer
    │ типизированный API window.canvasTTY
    ▼
preload bridge (contextBridge)
    │ IPC-каналы из белого списка
    ▼
Electron main process
    ├── SettingsStore  → проверенное атомарное JSON-хранилище
    ├── TerminalManager → lifecycle node-pty, ограниченный scrollback и batching вывода
    ├── LimitsService  → очищенные adapters лимитов и кэш
    ├── PluginManager  → установка из GitHub, manifest, assets, permissions, storage
    ├── PluginSecretsService → защищённое системное шифрование credentials плагинов с fail-closed поведением
    ├── PluginMediaService → разрешённые медиапапки, ranged audio streams, плейлисты
    ├── BrowserService → встроенные вкладки и lifecycle изолированных WebContentsView
    ├── RunManager     → запуски оркестрации агентов, карточки и связи (см. «Оркестрация агентов»)
    ├── canvastty-plugin:// → статические plugin resources под CSP
    ├── canvastty-media:// → локальные аудиопотоки с проверкой разрешений
    └── нативные dialogs/window controls
```

- `src/shared/contracts.ts` — единственный публичный контракт между процессами. Любое изменение межпроцессных данных сначала объявляется здесь.
- `src/preload/index.ts` открывает только типизированные возможности, нужные renderer. Node integration выключен, context isolation и sandbox включены.
- `src/main/ipc/registerIpc.ts` владеет нативными side effects и проверяет доступ к сохраняемым медиа.
- `src/main/services/TerminalManager.ts` — источник истины для живого состояния сессий и PTY buffers. Scrollback хранится в ограниченном chunk-буфере, а PTY data объединяются в IPC-пакеты по 16 мс. Обычный терминал стартует как `idle`, агент остаётся `unavailable` до первого машинного lifecycle-сигнала провайдера. После этого Codex, Claude Code, Qwen Code, Kimi Code, OpenCode, Hermes и Grok Build переходят между `idle`, `working` и `needs_approval` по provider hooks; точные OSC 0/2 markers Claude/Qwen сохранены как fallback совместимости. Человекочитаемый terminal text и само существование PTY не считаются активностью. Завершение процесса даёт только `done` или `failed`.
- `src/main/services/LimitsService.ts` читает Codex через app-server protocol установленного CLI, а Claude, Kimi, OpenCode Go и Grok Build — через provider usage/billing endpoints. Qwen Code мультипровайдерный и не имеет provider-neutral quota-read protocol, поэтому его adapter честно возвращает `cli-not-found` или `unsupported-protocol`, не выдумывая проценты. Credentials читаются только в доверенном main-процессе, отправляются только соответствующему провайдеру по HTTPS, не логируются и не выходят через IPC. Сервис отвечает за timeout, structural normalization, cache, stale fallback и cleanup подпроцессов; сырые ответы провайдеров через IPC не проходят.
- `src/main/services/SettingsStore.ts` нормализует каждое изменение и сохраняет его сериализованной атомарной записью.
- `src/main/services/PluginManager.ts` устанавливает готовые статические репозитории без выполнения package scripts, отклоняет symlinks и слишком большие пакеты, хранит реестр включения, отдаёт только файлы внутри пакета и применяет permissions/storage quotas для каждого плагина.
- `src/main/services/PluginSecretsService.ts` сериализует запись секретов каждого плагина, шифрует весь ограниченный payload через Electron `safeStorage`, отклоняет plaintext-only backend и удаляет зашифрованный файл при uninstall.
- `src/main/services/PluginMediaService.ts` сохраняет разрешения только после нативного выбора папки, скрывает абсолютные пути, пропускает symlinks и отдаёт аудио с HTTP Range. Чтение плейлистов остаётся внутри разрешённых библиотек; ограниченная атомарная запись разрешена только в `Playlists/`.
- `src/main/services/BrowserService.ts` владеет вкладками встроенного браузера в `WebContentsView`. Удалённые страницы используют отдельный persistent partition с выключенным Node, включёнными context isolation/sandbox и отклонением website permissions по умолчанию. Это core service, а не возможность runtime-плагина.
- `src/main/services/agent-runtime/` — отдельная всегда включённая lifecycle-граница, не зависящая от переключателя Browser access. Каждый agent PTY получает собственный capability для защищённого user-local socket/pipe. Provider command hooks и OpenCode event plugin могут передать только фиксированный status enum, ограниченное имя события и необязательный opaque turn/prompt ID; точная schema Gateway отклоняет prompt text, ответы, tool input и произвольную telemetry. При завершении PTY capability и временные файлы отзываются.
- Claude, Codex, Qwen и OpenCode получают lifecycle hooks только на текущий запуск. Для Kimi, Hermes и Grok, которые ищут hooks в home-конфигурации, используются ownership-checked временные записи с совместным владением живых сессий. Kimi и Hermes используют recovery journals и точные backups, Grok — отдельный owned hook file; cleanup восстанавливает исходные байты или удаляет только записи Raoden Loom при конкурентных изменениях.
- `TerminalManager` подмешивает MCP helper, не оставляя постоянных изменений в provider-конфигах. Claude Code, Codex и Qwen Code получают CLI arguments; Qwen получает одну inline-запись `--mcp-config`, которая переопределяет только имя сервера Raoden Loom и не скрывает сторонние user servers. OpenCode — объединённый launch-only `OPENCODE_CONFIG_CONTENT` с одной scoped browser-tool permission, Kimi — per-run MCP config или временную запись с compare-and-swap и recovery journal для старых версий. Hermes получает временную запись `mcp_servers.canvastty_browser` в `HERMES_HOME/config.yaml` (по умолчанию `~/.hermes/config.yaml` в POSIX или `%LOCALAPPDATA%\hermes\config.yaml` в Windows); чувствительные capability-значения остаются ссылками на окружение дочернего процесса. Временная конфигурация Kimi и Hermes живёт до завершения последней владеющей PTY-сессии, после чего исходные байты точно восстанавливаются, если файл не менялся параллельно. Journal восстанавливает Hermes после прерванного запуска при следующем старте Raoden Loom, а compare-and-swap сохраняет одновременные пользовательские изменения. Сторонние MCP-записи, credentials и file/shell permissions не затрагиваются. Qwen, OpenCode и Hermes YOLO остаются launch-only и не меняют постоянные permission-настройки.
- `src/main/services/providerCliRegistry.ts` — единственный владелец обнаружения provider CLI. При запуске main-процесса он создаёт один неизменяемый snapshot для Codex, Claude, Qwen Code, Kimi, OpenCode, Hermes и Grok Build, последовательно проверяя smoke-only overrides, унаследованный `PATH`, системные каталоги платформы и известные пользовательские/provider-каталоги. Доступная запись хранит абсолютный executable, тип launcher-а и дополненный дочерний `PATH`; POSIX-кандидат обязан быть исполняемым файлом, а Windows-кандидат — поддерживаемым native или batch launcher-ом. `TerminalManager`, `LimitsService`, agent-browser probes и provider smoke используют один и тот же snapshot и не повторяют поиск команды. Недоступный CLI создаёт failed-сессию с копируемой диагностикой проверенных путей до создания PTY или временной browser-конфигурации, а соответствующий HOME limit остаётся `cli-not-found`. Raoden Loom не читает shell startup scripts; после установки или перемещения CLI приложение нужно перезапустить.

Основной `BrowserWindow` создаётся и показывается с лёгкой локальной стартовой страницей до инициализации settings, plugins, media и IPC. Успешная инициализация заменяет её доверенным renderer; bootstrap failure показывает видимую error page и сохраняет fallback на native dialog. Main process удерживает single-instance lock и восстанавливает/фокусирует существующее окно при повторном запуске.

Код runtime-плагина никогда не импортируется в main или доверенный renderer bundle. HOME widgets и canvas apps работают в sandboxed iframe с opaque origin. Отдельные plugin windows используют узкий preload, который пересылает тот же message SDK через IPC handler с проверкой фактического sender URL `canvastty-plugin://<id>/<entry>`. Произвольные нативные окна ОС не встраиваются.

Доступ плагина к музыке основан на capabilities, а не на общем доступе к файловой системе. Media scan возвращает library IDs, относительные пути, metadata и `canvastty-media://` stream URLs; сырой текст плейлиста остаётся единственным format-neutral содержимым файла. Media URL разрешается только включённому плагину-владельцу и только внутри ранее выбранного root библиотеки. Удаление плагина отзывает сохранённые folder grants.

Встроенный браузер разделён между поверхностями: `BrowserCard` рисует доверенный внешний chrome окна, вкладки, навигацию, agent badges, downloads, dialogs и canvas geometry, а `BrowserService` размещает активный native view поверх измеренного viewport карточки. Во время движения карточки или камеры native view остаётся live и получает coalesced geometry updates по кадрам; он скрывается только в semantic summary, при редактировании HOME и за trusted modal surfaces. Дробные renderer bounds расширяются до охватывающих device-independent pixels, а активный tab view переподключается только при фактической смене вкладки. Typed pointer bridge возвращает click/hover activity native page в canvas selection и явно восстанавливает фокус страницы, не блокируя её ввод. Само подключение или heartbeat не создаёт presence: badge появляется только после browser-команды, а cursor — только после появления реальной pointer position.

## Границы renderer

`App.tsx` — граница оркестрации. Он загружает settings/sessions, подписывается на события main process, координирует dialogs и persistence. Feature components не вызывают API несвязанных фич.

```text
App
├── WorkspaceCanvas        camera, pan, zoom, пространственная композиция
│   ├── HomeZone           сохраняемая сетка, граница и edit gestures
│   │   ├── homeModel      чистое получение строк лимитов/активных сессий
│   │   └── HomeMediaWidget независимые pick/replace/remove controls
│   ├── TerminalCard       xterm, selection, rename, drag, resize и snap
│   ├── PluginCanvasCard   sandboxed plugin app с bounds и summary
│   └── BrowserCard        доверенный browser chrome и geometry для native view
├── AgentLaunchDialog      фиксированный provider + folder + profile + launch
└── SettingsPanel          General, Appearance, Controls и Plugins
    └── PluginSettingsSection preview, permissions, registry и contributions
```

Domain decisions остаются в чистых selectors вроде `homeModel.ts`, orchestration — в `App.tsx`, rendering/local interaction — в feature components. IPC calls принадлежат `App.tsx` или фиче, которая единолично владеет capability.

## Поток сессии

1. Home запрашивает терминал или открывает provider-specific launch card.
2. `App` отправляет типизированный запрос `terminal:create`.
3. `TerminalManager` проверяет запрос, запускает PTY, хранит metadata и ограниченный chunked scrollback, затем отправляет lifecycle events и data events пакетами по 16 мс.
4. `App` согласует lifecycle snapshots по session ID.
5. `TerminalCard` подписывается на PTY stream, отправляет PTY input/grid resize и фиксирует типизированные canvas bounds после drag или edge resize.

`SessionMetadata` владеет world-space position и размером карточки. `App` согласует bounds, а `TerminalCard` может хранить transient geometry pointer-move до pointer-up. Main process проверяет и ограничивает размеры до отправки session snapshot. Camera wheel обрабатывается только на пустом canvas; интерактивные поверхности сохраняют native scroll/input ownership.

Одна живая `TerminalCard` владеет одним xterm instance на всё время жизни session ID. Смена palette обновляет `terminal.options.theme` на месте; title/settings не должны пересоздавать terminal или его renderer scrollback. Window title обновляется как session metadata через `terminal:rename`. PTY input/resize, пришедшие одновременно с exit, сдерживаются на границе main process и не превращаются в uncaught Electron errors.

Batching вывода — граница IPC/rendering, а не истории: каждый PTY chunk сразу добавляется в ограниченный scrollback, а ожидающий renderer output сбрасывается по таймеру 16 мс, перед exit и перед dispose. Trimming двигается по chunks вместо пересборки всего буфера на каждую запись; snapshot объединяет только сохранённый suffix.

Координаты указателя терминала преобразуются из визуально трансформированного rectangle канваса обратно в layout coordinates xterm до selection/wheel handling. Направления колеса терминала и канваса независимо нормализуются из сохранённых settings. Выделенный текст копируется через типизированный clipboard bridge по `Ctrl+C`, `Ctrl+Shift+C` или `Cmd+C`; вставка использует `Ctrl+Shift+V`, `Cmd+V` или `Shift+Insert` и входит в xterm через `Terminal.paste`, а не synthetic keystrokes. `Shift+Enter` отправляет CSI-u modified Enter напрямую в PTY.

Application shortcuts нормализуются в `SettingsStore`, сопоставляются в `App` и отображаются из тех же сохранённых bindings в canvas hint. `App` владеет эксклюзивным selection canvas application и выбранной terminal session для действий вроде rename. `TerminalCard` владеет xterm focus и inline editor, `BrowserService` — focus native page. Нажатие на пустой canvas снимает любой selection. Опциональный hover focus использует одинаковую настроенную задержку entry/exit для терминалов и встроенного Browser; focus-in/focus-out sequences программного перехода терминала подавляются до PTY input, чтобы TUI агента не сбрасывал позицию истории.

Session counters, progress bars и statuses всегда выводятся из настоящих `SessionSnapshot`. UI не синтезирует telemetry.

## Поток лимитов провайдера

1. `App` запрашивает очищенный `LimitsSnapshot` при bootstrap и каждые 60 секунд.
2. `LimitsService` дедуплицирует refresh и хранит 60-секундный cache.
3. Codex опрашивается через `codex app-server` методом `account/rateLimits/read`. Claude, Kimi, OpenCode Go и Grok Build используют read-only usage/billing endpoints и credentials установленных CLI. Qwen Code возвращает явный unavailable reason: одна Qwen-сессия может работать с разными облачными или локальными провайдерами, а универсального quota-read protocol у CLI нет. OpenCode Go даёт настоящие rolling, weekly и monthly windows, Grok Build — настоящий общий billing period. Реальные ответы структурно проверяются и сокращаются до percentage, window и reset time.
4. Если refresh не удался после успешного чтения, последний валидный snapshot возвращается как stale. Отсутствующие/неподдерживаемые adapters возвращают явную unavailable reason, а не `0%`.
5. Raoden Loom запрашивает Claude usage с OAuth-токеном из CLI credentials текущего пользователя. Отсутствующие или нечитаемые credentials дают `not-authenticated`; локальное состояние credentials не считается доказательством отсутствия подписки. Provider TUI screens не разбираются.

## Оркестрация агентов (лид Codex → исполнитель Claude)

Статус: **MVP принят для macOS с известными ограничениями** (2026-09-24). Этапы 1–10 и финальная реальная серия приняты. Реальные CLI прошли цикл вне интерфейса (этап 6) и через UI проверенной упакованной сборки. Реальная серия R1–R3: цель до завершения, «Стоп» во время хода Claude, выход во время хода и «Продолжить» (`agent-orchestration/evidence/real-ui/`). Проверенная сборка — `/private/tmp/canvastty-r10-pkg-wrc5/release/mac-arm64/CanvasTTY.app` (локальная, подпись ad-hoc, без нотарификации). Первое использование: [agent-orchestration/FIRST-USE.md](agent-orchestration/FIRST-USE.md). Приёмка, доказательства и границы проверки: ROADMAP, «Приёмка MVP». История решений и все результаты проверок: [agent-orchestration/](agent-orchestration/) (ROADMAP, VALIDATION-MATRIX, TROUBLESHOOTING, контракты этапов). Исходный проект `ARCHITECTURE-PROPOSAL.md` отмечает, где реализация от него отличается (§0).

```text
renderer features/orchestration (карточки, связь, диалог цели, панель запуска)
    │ window.canvasTTY.orchestration (preload/orchestrationClient.ts)
    ▼ каналы orchestration:* через handleMain (только верхний фрейм главного окна, каждый аргумент проверяется)
main RunManager (manager.ts) — единственный владелец запусков; сам ничего не открывает
    ├── canvasStore  → <userData>/orchestration/canvas.json (карточки и связи)
    └── OrchestrationService на каждый run (машина состояний, лимиты, восстановление)
        ├── Store     → runs/<runId>/journal.jsonl (хэш-цепочка) и texts/
        ├── Workspace → runs/<runId>/workspace/ (рабочая копия + control.git)
        ├── ходы      → supervisor.mjs (ELECTRON_RUN_AS_NODE) → codex / claude CLI в своей группе процессов
        └── проверки  → supervisor.mjs внутри профиля Seatbelt → node --test
```

Функция оркестрации единолично владеет своей IPC-возможностью (`useOrchestration.ts`), поэтому не идёт через `App.tsx`. Источник истины для запусков, карточек и связей — main. Renderer только сводит снимки и события `(seq, tick)` и предлагает команды, которые разрешает `availableActions()`.

### Запуск цели

1. Правый клик по пустому холсту → «Агент Codex (лид)» и «Агент Claude (исполнитель)» (интерфейс есть только на английском и русском), у обоих одна папка проекта.
2. Порт карточки лида тянется на карточку исполнителя. С клавиатуры: Enter на порту, затем «Связать сюда». Связь идёт только Codex → Claude в пределах одного проекта; на ту же карточку и повторную пару связь не создаётся.
3. «Новая цель» на плашке связи открывает диалог:
   - задача и критерии (по строке);
   - проверки из каталога приложения (только `node-test`, то есть `node --test`, 600 с, вывод 64 КиБ);
   - лимиты, по желанию; по умолчанию ходов 40, раундов на этап 8, перепланирований 3, время 240 мин;
   - «Показать план перед выполнением» (выключено по умолчанию).
4. Лид разбивает задачу на этапы. На каждом этапе исполнитель правит код, проходит проверка, лид делает ревью. Принятый этап получает checkpoint. Финальное ревью завершает run как `completed`.

У связи не больше одного активного run. Пока он идёт, «Новая цель» и «×» скрыты, и main тоже отказывает.

### Управление

Панель показывает только допустимые в текущем состоянии команды:
- «Пауза после хода» / «Не останавливаться»;
- «Продолжить», «Один шаг» (ровно одна операция, затем пауза), «Стоп»;
- ответ на вопрос, «Уточнить», увеличение лимита;
- восстановление.

«Стоп» отвечает сразу. Он останавливает активный ход или проверку; если результата нет, run завершается через 20 с. После принятого Stop ни одна операция не начинается. Запуск, который приложение не держит (например, поставленный на паузу до перезапуска), ничего не выполняет, поэтому его остановка — только запись в журнал: для неё не нужны CLI проверенной версии, login shell и подготовленные зависимости проекта. «Продолжить» и новый старт по-прежнему их требуют.

Каждая команда несёт `commandId` и `expectedRevision`. Если ответ потерян, панель хранит запрос (и после перезагрузки окна) и предлагает «Повторить». Main отвечает на повтор записанным результатом, поэтому ничего не выполняется дважды.

### Восстановление

- **Штатный выход.** Активная операция останавливается, run становится `paused(user_request)`.
- **Сбой или принудительное завершение.** Run показывается таким, каким его запишет открытие:
  - `paused(outcome_unknown)`, если был ход в полёте. Доступно: принять результат хода, повторить ход (новая сессия), вернуть к последнему checkpoint (с подтверждением; изменения после него сохраняются в `refs/canvastty/<runId>/recovery-<k>`), или «Стоп»;
  - `paused(recovered)` — во всех остальных случаях. Прерванная проверка получает `not_verified(interrupted)` и запускается снова только по «Продолжить» или «Один шаг».
- В обоих случаях после перезапуска ничего не продолжается само. Supervisor завершает группу CLI или песочницу проверки, когда умирает main (EOF lifeline).

Поиска осиротевших процессов при старте нет. Если убить всю группу процессов main, погибнет и supervisor, и группа CLI может его пережить.

### Где результаты

- **Данные запусков** лежат в `<userData>/orchestration/` (на macOS `~/Library/Application Support/<имя приложения>/orchestration/`):
  - `canvas.json`;
  - `runs/<runId>/journal.jsonl`, `texts/`, `checks/<checkRunId>/`, `workspace/` (рабочая копия `repo/` и `control.git`);
  - `attempts/` (схема и отчёт каждого хода лида).
- **История** (отчёты, замечания лида, вывод проверок) показывается на панели запуска из журнала.
- **Исходный репозиторий** получает только объекты и ссылки, которые создаются и больше не меняются:
  - `refs/canvastty/<runId>/baseline` — дерево исходного проекта на старте, включая незакоммиченные и неотслеживаемые, но не игнорируемые файлы;
  - `refs/canvastty/<runId>/stage-<n>` — checkpoint после принятого этапа n;
  - `recovery-<k>` — сохраняется при возврате к checkpoint.
  
  HEAD, ветки, индекс и рабочее дерево не меняются никогда.

### Как забрать изменения

Приложение никогда не сливает изменения в вашу ветку. В исходном репозитории:

```sh
git log --oneline refs/canvastty/<runId>/stage-<n>
git diff refs/canvastty/<runId>/baseline refs/canvastty/<runId>/stage-<n>   # только работа агентов
git switch -c agents/<имя> refs/canvastty/<runId>/stage-<n>                  # посмотреть на новой ветке
git cherry-pick refs/canvastty/<runId>/baseline..refs/canvastty/<runId>/stage-<n>   # или перенести на текущую ветку
```

Сравнивайте с `baseline`, а не с `HEAD`: если на старте были незакоммиченные правки, baseline их содержит.

### Требования и ограничения

- **Платформы.**
  - Run может завершиться только на macOS: песочница проверок — Seatbelt (`sandbox-exec`).
  - На Linux и Windows оркестрация недоступна: новые карточки агентов, связи, цели (в том числе автопилот) и «Продолжить» получают отказ `unsupported_platform` до запуска CLI, login shell и модельных вызовов, а проверка готовности сообщает блокер `platform`, ничего не измеряя. Renderer показывает эти пункты неактивными с подсказкой «Оркестрация пока доступна только на macOS». Решает одна функция (`orchestrationAvailable` в `src/shared/orchestration.ts`); менеджер запусков получает платформу как зависимость.
  - Запуски, уже лежащие на диске (созданные на macOS или поставленные прежней версией на паузу `sandbox_unavailable`), там видны и читаются, их можно остановить и удалить связь.
- **CLI** зафиксированы:
  - Codex CLI 0.155.1: модель `gpt-6-astra`, reasoning high, песочница `read-only`, без пользовательского конфига и правил.
  - Claude Code 2.1.281: модель `claude-sonnet-5`, `structured-edit` (кандидатный режим: Read/Edit/Write/Glob/Grep, без shell, `--max-budget-usd 1` на ход).
  
  Другие версии отклоняются до создания run. Ограничения правок исполнителя — политика CLI, а не граница ОС.
- **Проект.**
  - Нужен корень git-репозитория. Отказ получают: submodules, LFS, вложенные репозитории, связанные worktree, sparse checkout, незавершённый merge/rebase.
  - В корне нужны `package-lock.json` и настоящая папка `node_modules`. Оркестратор не устанавливает зависимости: копия подключает `node_modules` проекта только для чтения.
- **Зависимости в копии и worktree** (native-запуски, с этапа 12). Копия — git-клон, worktree — checkout, поэтому игнорируемых `node_modules/` и `vendor/` проекта в них нет. Сразу после создания копии или worktree, до подготовки, `cloneDependencies` (`workspace.ts`) клонирует каждую такую папку из проекта через APFS clonefile (`cp -cR`, только после проверки, что обе стороны на APFS и на одном томе, чтобы не было отката к побайтовому копированию). Условия: папка игнорируется в копии, а её lock-файл (`package-lock.json`, `yarn.lock` или `pnpm-lock.yaml`; `composer.lock`) в копии побайтно совпадает с проектным. Папка со ссылкой, ведущей за её пределы, не клонируется. Во всех остальных случаях подготовка ставит её в копии (`npm ci`, `composer install`), как для нового проекта; lock-файлы склонированных папок считаются установленными, и их шаги пропускаются. В проект ничего не пишется, ссылок в него нет. Итог по каждой папке (cloned, installed, skipped и причина) — в `runs/<runId>/workspace/deps.json` и одной записи ленты активности; журнал (v1) не меняется. Панель запуска пишет «Зависимости: склонированы из проекта» или «установлены в копии». Режим «папка проекта» не меняется.
- **Интерфейс (минимальный).**
  - Панель показывает последний run связи; выбрать более старый нельзя.
  - Панель не показывает имена checkpoint-ссылок и не предлагает их слить: забирайте изменения git-командами выше. Id запуска — код в заголовке панели (первые 8 символов); полные имена выводит `git for-each-ref refs/canvastty/`.
  - Карточки агентов не следуют за регионами и не показываются на миникарте, в палитре команд и радиальном меню.
  - Связь удаляется только кнопкой «×» после остановки run. Карточка со связью спрашивает подтверждение; запуски и их история остаются.
- **Процессы и данные CLI.** Поиска оставшихся процессов при старте нет (см. «Восстановление»). Реальные CLI сохраняют свои сессии в домашнем каталоге пользователя (`~/.claude/projects/`, `~/.codex/sessions/`), вне `userData` приложения; приложение это не ограничивает.
- **Границы проверки.**
  - Реальные модели выполняли только одноэтапные планы. Многоэтапный цикл с checkpoint каждого этапа проверен только на тестовых CLI.
  - Выход во время реального хода (R3) — SIGTERM процессу main, Electron обрабатывает его как `app.quit()`. Cmd+Q отдельно не проверялся.
  - Аварии и потеря ответов IPC проверены только на тестовых CLI.
  - Стоимость Claude в R1–R3 ($0.0871) — только за два завершённых хода, это не полная стоимость серии.
- **Тестовые механизмы** — только для сборок разработки: тестовые провайдеры `CANVASTTY_ORCHESTRATION_TEST_PROVIDERS`, IPC smoke и потеря ответов `CANVASTTY_ORCHESTRATION_TEST_DROP_REPLIES`. Все читаются через `developmentEnv()`, который упакованная сборка игнорирует (проверено на упакованном приложении на этапе 10).

## Точки расширения

- Новый provider добавляется в `ProviderId`, `providers.ts`, `TerminalManager.resolveLaunch`, карту официальных provider assets и опциональный безопасный limit adapter.
- Сохраняемая setting добавляется в `AppSettings`, defaults/normalization в `SettingsStore` и только во владеющую фичу. Settings владеет пользовательскими canvas controls и shortcuts; camera math и snapping geometry остаются чистыми renderer concerns.
- Canvas entity добавляется отдельным feature component с явной position и callbacks; camera ownership остаётся в `WorkspaceCanvas`.
- Runtime extension публикуется со статическими HTML/CSS/JS entries и `canvastty.plugin.json` API v1. Виды contributions: `home-widget`, `canvas-app`, `window`; capability access ограничен declared permissions. См. [Runtime-плагины](plugins.ru.md).

Каждое расширение должно пройти `npm run typecheck`, `npm run build` и проверку взаимодействия в настоящем Electron.
