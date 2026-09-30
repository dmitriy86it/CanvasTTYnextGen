# Р10: проверка локальной упакованной сборки (2026-09-24)

Сборка: `npm run build` (SDKROOT MacOSX26.5), затем `electron-builder --dir --publish never -c.directories.output=<pkg>/release` с `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- `<pkg>` — новый временный каталог `/tmp/canvastty-r10-pkg-*`.
- `release/` не тронут (дата сборки в нём 22 сентября), установленное приложение и профиль пользователя не использовались.
- Публикации, загрузки артефактов и нотарификации не было: подпись ad-hoc (`identity: "-"`), `notarize: false`.
- electron-builder скачал zip Electron 43.2.0 для сборки. Это загрузка, а не выгрузка артефактов.

Окружение:
- macOS 27.0 (Darwin 27.0.0), arm64;
- Node 26.8.1, Electron 43.2.0, приложение 1.5.2.

Пути в логах обезличены:
- `<pkg>` — каталог сборки;
- `<scratch>`, `<tmp>` — временные каталоги;
- `~` — домашний каталог.

## Что подтверждено на этой сборке

| Проверка | Команда | Результат | Лог |
|---|---|---|---|
| Упаковка | `electron-builder --dir …` | выход 0; node-pty пересобран под Electron 43.2.0; fuses применены; подпись ad-hoc | `package.log` |
| Fuses фактического бинаря | `@electron/fuses getCurrentFuseWire` | RunAsNode on, NodeOptions off, NodeCliInspect off, EmbeddedAsarIntegrity on, OnlyLoadAppFromAsar on, CookieEncryption off, V8Snapshot off, GrantFileProtocolExtraPrivileges on — как в `electron-builder.yml` | `fuses.json` |
| Orchestration smoke | `node scripts/smoke-orchestration.mjs --packaged --app <pkg>/…/CanvasTTY.app` | **пройден** (см. ниже) | `orchestration-smoke.log` |
| Sandbox smoke | `node scripts/smoke-check-sandbox.mjs --packaged --app <pkg>/…/CanvasTTY.app` | **пройден** (см. ниже) | `check-sandbox-smoke.log` |
| Состав и закрытие тестовых механизмов | `node scripts/smoke-packaged-gates.mjs --app <pkg>/…/CanvasTTY.app` | **пройден** (см. ниже) | `packaged-gates.json` |
| Контроль: dev-сборка выполняет те же переменные | `node scripts/smoke-orchestration-ipc.mjs` | пройден: IPC smoke выполнен, 16 процессов fake CLI | `control-dev-ipc-smoke.log` |

**Orchestration smoke** — встроенный mock, отдельный путь, разрешённый и в упаковке:
- ход `completed`, `ok`, `valid`;
- задание доставлено полностью (116 736 байт, cksum совпал), окружение CLI не утекло;
- второй ход остановлен Stop (`stopped`);
- у обоих ходов `groupCleared` и `pidsGone`, pid supervisor и группы после хода мертвы;
- supervisor — `Contents/Resources/orchestration/supervisor.mjs` этой сборки.

**Sandbox smoke:**
- `unit` — `passed`, `unit-broken` — `failed`;
- самотест песочницы пройден перед каждой из трёх проверок;
- `escapee` (отсоединённый `/bin/sleep`) убит сканированием песочницы (`killed 1`), после результата не жив;
- журнал совпадает с результатом.

**Состав и закрытие тестовых механизмов:**
- **Состав:**
  - в Resources и `app.asar` нет `docs`, `tests`, `fixtures`, `mock-*`, `test-agents`, crash-фикстур, `scripts`, E2E и smoke-драйверов, проектов `check-project`/`series-project`;
  - в `orchestration/` только `supervisor.mjs` и `sandbox-probe.mjs`;
  - 329 файлов ресурсов, 734 записи `app.asar`.
- **Собранный main** (`app.asar/out/main/index.js`):
  - `developmentEnv()` возвращает `undefined` при `app.isPackaged`;
  - `CANVASTTY_ORCHESTRATION_TEST_PROVIDERS`, `CANVASTTY_ORCHESTRATION_IPC_SMOKE` и `CANVASTTY_ORCHESTRATION_TEST_DROP_REPLIES` читаются только через него.
- **Поведение.** Упакованное приложение запущено со всеми тремя переменными, временными `--user-data-dir` и `HOME`:
  - IPC smoke не выполнился: маркера нет, приложение работало 15 с и не вышло само;
  - ни один fake CLI из переменной провайдеров не запускался;
  - выход по SIGTERM — код 0.

Промежуточный сбой: первый прогон orchestration smoke упал на сравнении пути supervisor (`orchestration-smoke-1-path-mismatch.log`). Все проверки хода в нём прошли. Причина — в скрипте, а не в приложении: явный `--app` был передан через `/tmp`, а приложение сообщает реальный путь `/private/tmp`. Скрипт теперь приводит `--app` к `realpath` (T102). SIGABRT из T37 на этой сборке вне внешней песочницы не воспроизвёлся.

## Что осталось непроверенным

- **Реальный цикл агентов через UI.** Packaged smoke — это один ход встроенного mock и проверки в песочнице, а не цикл лид → исполнитель → проверка → ревью с реальными моделями. План: `implementation/real-ui-check-plan.md`, реальные запросы ждут разрешения.
- **Интерфейс упакованной сборки.** UI оркестрации и E2E Р9 выполнялись на dev-сборке.
- **Потеря ответа и тестовые провайдеры в упаковке — только отрицательно.** Проверено, что переменные не читаются, и IPC smoke не выполнился. Поведенческая проверка переменной провайдеров потребовала бы создать run в упакованной сборке, и тогда пошли бы реальные CLI. Этот запуск не делался.
- **Дистрибутивы.** dmg/zip, подпись Developer ID, нотарификация, Gatekeeper на другой машине. Linux (AppImage/deb) и Windows не собирались.
- **Прочее.** SIGABRT из T37 в среде ревью: причина для того случая не установлена, локально не воспроизводится.

## Что ещё требуется для приёмки MVP

- Ревью Р10.
- Реальные проверки через UI по плану (R1–R3) с разрешения пользователя.
- Решение по известным ограничениям:
  - нет поиска осиротевших процессов при старте;
  - завершить run можно только на macOS;
  - Claude `structured-edit` — кандидатный режим;
  - UI не показывает checkpoint-ссылки.
