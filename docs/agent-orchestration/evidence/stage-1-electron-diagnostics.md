# Этап 1: диагностика Electron-проверок (2026-09-22)

Среда: macOS 27.0 (26A428), arm64; Node 26.8.1 (локально) и Node 22.23.2 (как в CI); Electron 43.2.0 (Node 24.18.0); electron-builder 26.15.3. Сборка — с `SDKROOT=…/MacOSX26.5.sdk` (TROUBLESHOOTING T30). Модельных запросов нет; настоящие claude/codex не запускались.

## Замечание ревью: Electron-тест упал на stderr (`codesign_util.cc` / `task_name_for_pid`)

| Режим запуска | Результат |
|---|---|
| `ELECTRON_RUN_AS_NODE=1 Electron -e …` без песочницы | вывод пуст, rc=0 |
| то же под `sandbox-exec` с `(deny mach-task-name)` | stderr: `[…:ERROR:electron/shell/common/mac/codesign_util.cc:79] task_name_for_pid: (os/kern) failure (5)`; Node-режим работает, rc=0 |
| тесты движка под `sandbox-exec (deny mach-task-name)`, до исправления | 88/89: упал только Electron-тест на `assert.equal(stderr, "")`; все функциональные проверки этого теста (задание байт в байт, нет `ELECTRON_RUN_AS_NODE`/`SUP_*` у CLI, `done` один раз, группа очищена) прошли |

Источник строки — `electron/shell/common/mac/codesign_util.cc` (строка присутствует в `Electron Framework`): Electron в Node-режиме проверяет подпись родителя через `task_name_for_pid`; при запрете (песочница вокруг запуска теста) пишет лог и продолжает работу. Воспроизведено то же сообщение, что во внешнем ревью.

Исправление теста: отделяется **только** эта строка формата Electron-лога (с переводом строки), она выводится в диагностику теста; любой другой stderr supervisor или CLI по-прежнему роняет тест. Добавлен тест, что stderr дочернего CLI под Electron не отделяется. После исправления: без песочницы и под `(deny mach-task-name)` — оба Electron-теста проходят, под песочницей в диагностике видна строка рантайма.

## Замечание ревью: packaged smoke — SIGABRT до маркера

| Режим запуска | Результат |
|---|---|
| `npm run smoke:orchestration -- --packaged` без песочницы (свежая сборка) | пройден: ход 1 `completed`/`ok`/`valid`, 116 736 байт и `cksum` совпали, `envLeak=false`; ход 2 `stopped`; группы очищены, pid завершены |
| то же под `sandbox-exec (deny mach-task-name)` | маркера нет, `signal=SIGTRAP`; перед этим Chromium: `sandbox initialization failed: Operation not permitted`, `GPU process exited unexpectedly: exit_code=6`, `FATAL:…gpu_data_manager_impl_private.cc:416] GPU process isn't usable. Goodbye.` |

Воспроизведён один механизм: собственная песочница Chromium не инициализируется внутри другой Seatbelt-песочницы, GPU-процесс не запускается, браузерный процесс завершается до хука оркестрации. **Сигнал отличается** (SIGTRAP здесь, SIGABRT у ревью), поэтому то, что у ревью была та же причина, не доказано. Smoke теперь печатает режим, версии Node/Electron, платформу и распознанные сообщения рантайма (ошибка инициализации sandbox, строки `FATAL`) и по-прежнему завершается ошибкой. Для сравнения нужен вывод ревью с этими строками.

Не менялось ради зелёного smoke: fuses (`RunAsNode` Enabled, NODE_OPTIONS и inspect Disabled, asar integrity и OnlyLoadAppFromAsar Enabled — прочитано `@electron/fuses read` из упакованного приложения), sandbox Chromium (`--no-sandbox` на macOS не добавлялся), проверки завершения процессов.
