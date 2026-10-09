# B4: реальная проба автопилота доски (2026-10-09)

Приёмка B4 по [stage-b-board.md](../../implementation/stage-b-board.md), §5.3 п. 1. Скрипт:
`scripts/real-b4-board.mjs --real --calls 30 --minutes 60`, коммит `eb36ce9` ветки `feat/b4-board-autopilot`.

**Условия (разрешение владельца).**
- Настоящие codex-cli 0.160.0 и Claude Code 2.1.295.
- Копия фикстуры `series-project` во временном каталоге с git.
- Временный профиль приложения, журнал v2.
- Настройки проекта:
  - режим «Отдельная копия»;
  - права «Рабочая папка» у обоих CLI;
  - проверка `node --test`.
- Модели «Как в CLI»: модель из `~/.codex/config.toml` (`gpt-6.1-sol`) есть в `model/list`, поэтому `gpt-6-sol` не понадобилась.
- Лимит: 30 вызовов моделей, 60 минут; бюджет автопилота — 3 запуска.

**Ход.** Три задачи в цепочке на доске:
- T-1 `clamp`;
- T-2 `inRange` после T-1;
- T-3 `describe` после T-2.

«Вести доску» включён на карточке доски. Дальше ничего не нажималось до остановки.

## Итог

| Задача | Статус | База копии | Ветка результата | Вызовов |
|---|---|---|---|---|
| T-1 | completed, confirmed | рабочая папка | `raoden/add-a-function-clamp-x-lo-hi-in-bc640718` | 4 |
| T-2 | completed, confirmed | ветка T-1 | `raoden/add-a-function-inrange-x-lo-hi-i-ad85f916` | 4 |
| T-3 | completed, confirmed | ветка T-2 | `raoden/add-a-function-describe-x-lo-hi-203d332a` | 4 |

- **Остановка автопилота:** «все задачи готовы» (`all_done`), 3,9 минуты.
- **Вызовы:** 12 из 30. Каждый запуск: лид Codex, исполнитель Claude, два ревью Codex.
- **Базы:** база каждой следующей задачи — ветка и коммит предыдущей. Коммиты образуют цепочку (`git merge-base --is-ancestor`).
- **Ветка T-3:** содержит `src/clamp.mjs`, `src/range.mjs`, `src/describe.mjs` и их тесты.
- **Вопросы о правах:**
  - человеку — 0;
  - автоответов хоста (`sandbox_static`) — 0;
  - записей `permission.*` в журналах — 0.
- **Ошибок протокола:** 0.
- **Папка проекта:** HEAD и `git status` как до пробы; ветки результатов созданы только ссылками.
- **Модели по словам CLI:**
  - лид и ревьюер — `gpt-6.1-sol`;
  - исполнитель — `claude-opus-5-5`.
- **Хэши** `~/.codex/config.toml` (`97c5d61bea51e501`) и настроек Claude (`606c47d6ee8a0635`, `settings.json` + `settings.local.json`) до и после совпали.

## Файлы

- `report.json` — полный отчёт;
- `probe.log` — ход пробы;
- `T-n-journal.jsonl` и `T-n-activity.json` — журнал и лента каждого запуска (пути обезличены);
- `shots/*.png` — вне git, суммы в [BINARY-MANIFEST.sha256](../BINARY-MANIFEST.sha256).
