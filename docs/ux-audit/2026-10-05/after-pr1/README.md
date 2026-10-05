# После PR 1 «Паузы понятны» — повторная оценка

Код приложения = ветка `ux/pauses-clear`. Снимки — с подставными CLI в герметичном режиме, как в аудите. Что изменилось — в CHANGELOG (Unreleased) и в разделе 6 README аудита (PR 1: пункты 1, 2, 4, 6).

- `shots/` — 155 снимков итоговой сборки. PNG в git нет; суммы и размеры — в `BINARY-MANIFEST.sha256`:
  - `pauses/` — галерея всех 27 пауз (`scripts/ux-pause-gallery.mjs`): холст, панель, лента;
  - `orchestration-ui/`, `v2-checks-ui/`, `native-ui/`, `activity-ui/`, `autopilot-ui/` — снимки smoke с настоящими данными решений.
- `novice-round1.md`, `novice-round2.md`, `novice-round3.md` — ответы «новичка», дословно. Участник не читал ни код, ни документацию, ни свои прежние ответы.
  - Круг 1: первая сборка PR, 37 экранов.
  - Круг 2: после первой доработки, 33 экрана.
  - Круг 3: после второй доработки — только три изменённых экрана.
  - Снимки круга 1 заменены итоговыми, пути в его ответах теперь ведут на итоговые снимки.

## Как оценивали

Вопросы те же, что в аудите: что произошло? что мне сделать? какая кнопка главная? какие слова непонятны? Плюс ясность 1–5 (5 — сразу понятно, что делать). В аудите ясность ставилась только паузам; у экранов решений из smoke оценки «до» нет.

**Ограничение галереи.** Галерея меняет только причину паузы. Поэтому у пяти пауз с формой — вопрос агента, предложенные команды, отказ песочницы, push и QA, спорное замечание, снятие критериев — формы на снимке нет. В круге 1 «новичок» из-за этого оценил их на 2–3: «текст обещает то, чего нет». С круга 2 четыре из них оцениваются по настоящим экранам smoke: `v2-03`, `v2-08`, `v2-12`, `v2-14`. У `awaiting_answer` и `awaiting_checks_decision` настоящего снимка паузы нет, их оценки занижены по той же причине.

## Доработки по кругам

1. **После круга 1.**
   - Убрана отдельная кнопка-переход к форме. Форма решения теперь стоит сразу под строкой «Дальше», и её кнопка — главная.
   - Строка табло «нужно действие — см. ниже» → «см. выше».
   - `limit_reached`: «после этого появится «Продолжить»» вместо обещания кнопки, которой нет.
   - `finish_unconfirmed`: текст называет кнопку «Проверить результат», как на экране.
   - `loop_suspected`: где искать поле «Уточнить».
   - `sandbox_unavailable`: в какое поле вписать команды проверки и пример.
   - `check_needs_permissions`: называет кнопку «Изменить команду».
   - `awaiting_person_decision`: называет кнопки «Новый дефект» и «Повтор».
2. **После круга 2.**
   - `outcome_unknown`: галочка подтверждения возврата к контрольной точке видна только там, где есть сама кнопка возврата (не в папке проекта).
   - `stage_done`: кнопка «Продолжить» вместо «Следующий этап».
   - `protocol_error`: конкретный совет — обновить Claude Code или Codex.

## До → после

Пауза — панель `pause-<причина>-2-panel`. «—» — не оценивалось. Итог — последний круг, в котором экран оценивался.

| Экран | До (аудит) | Круг 1 | Круг 2 | Итог |
|---|---|---|---|---|
| `pauses/pause-app_closed-2-panel.png` | 4 | 4 | 4 | 4 |
| `pauses/pause-awaiting_answer-2-panel.png` | 1 | 3 | 3 | 3 |
| `pauses/pause-awaiting_checks_decision-2-panel.png` | 2 | 3 | 3 | 3 |
| `pauses/pause-environment_error-2-panel.png` | 3 | 4 | 4 | 4 |
| `pauses/pause-external_failure-2-panel.png` | 3 | 4 | 4 | 4 |
| `pauses/pause-finish_unconfirmed-2-panel.png` | 2 | 3 | 3 | 3 |
| `pauses/pause-invalid_report-2-panel.png` | 2 | 5 | 4 | 4 |
| `pauses/pause-journal_corrupt-2-panel.png` | 4 | 4 | 4 | 4 |
| `pauses/pause-lead_modified_tree-2-panel.png` | 1 | 4 | 3 | 3 |
| `pauses/pause-limit_reached-2-panel.png` | 3 | 4 | 4 | 4 |
| `pauses/pause-loop_suspected-2-panel.png` | 3 | 3 | 3 | 3 |
| `pauses/pause-needs_user_action-2-panel.png` | 2 | 4 | 4 | 4 |
| `pauses/pause-outcome_unknown-2-panel.png` | 2 | 3 | 2 | 4 |
| `pauses/pause-permission_denied-2-panel.png` | 3 | 4 | 4 | 4 |
| `pauses/pause-plan_review-2-panel.png` | 4 | 4 | 4 | 4 |
| `pauses/pause-protocol_error-2-panel.png` | 2 | 4 | 3 | 4 |
| `pauses/pause-recovered-2-panel.png` | 5 | 5 | 5 | 5 |
| `pauses/pause-sandbox_unavailable-2-panel.png` | 1 | 3 | 3 | 3 |
| `pauses/pause-shared_git_tampered-2-panel.png` | 3 | 4 | 4 | 4 |
| `pauses/pause-stage_done-2-panel.png` | 3 | 3 | 3 | 3 |
| `pauses/pause-step_done-2-panel.png` | 4 | 4 | 4 | 4 |
| `pauses/pause-tree_changed_during_review-2-panel.png` | 3 | 4 | 4 | 4 |
| `pauses/pause-user_request-2-panel.png` | 5 | 5 | 5 | 5 |
| `pauses/pause-awaiting_answer-1-canvas.png` | — | 3 | 3 | 3 |
| `pauses/pause-coverage_lost-1-canvas.png` | — | 3 | 3 | 3 |
| `pauses/pause-user_request-1-canvas.png` | — | 3 | 4 | 4 |
| `orchestration-ui/05-executor-working.png` | — | 4 | 4 | 4 |
| `orchestration-ui/07-plan-review.png` | — | 4 | 4 | 4 |
| `v2-checks-ui/v2-03-check-needs-permissions.png` | — | 3 | 3 | 3 |
| `v2-checks-ui/v2-08-disputed-item.png` | — | 4 | 2 | 2 |
| `v2-checks-ui/v2-10-finding-actions.png` | — | 3 | 4 | 4 |
| `v2-checks-ui/v2-12-plan-proposal.png` | — | 3 | 2 | 2 |
| `v2-checks-ui/v2-14-finish-confirm.png` | — | 4 | 2 | 2 |
| `pauses/pause-check_needs_permissions-2-panel.png` | 1 | 3 | см. экран из smoke | — |
| `pauses/pause-awaiting_finish_confirmation-2-panel.png` | 1 | 3 | см. экран из smoke | — |
| `pauses/pause-awaiting_person_decision-2-panel.png` | 1 | 2 | см. экран из smoke | — |
| `pauses/pause-coverage_lost-2-panel.png` | 1 | 3 | см. экран из smoke | — |

**Панели пауз (23 из галереи, оценённые в обоих замерах):**

| | До (аудит) | После |
|---|---|---|
| Ясность 4–5 | 6 | 16 |
| Ясность 1–2 | 9 | 0 |
| Средняя ясность | 2,8 | 3,8 |

По всем 33 экранам итога: 20 с ясностью 4–5, 10 с ясностью 3, 3 с ясностью 2.

## Что осталось непонятным (вне PR 1)

Это задачи следующих PR из разбивки аудита, а не текстов пауз.

- **Экраны решений из smoke, ясность 2.**
  - `v2-08`: спорное замечание пришло на английском, коды F1 и LIKE-F1.
  - `v2-12`: smoke прокручивает панель к кнопкам, и заголовок со списком снимаемого уходит за край.
  - `v2-14`: четыре варианта push и QA выглядят одной группой, а красная плашка «проверок не было» соседствует с предложением отправить.
- **Блок «Итог» спорит с заголовком паузы.** «Изменений: нет» при «лид изменил файлы»; «коммит: не запрошено» при «коммит не подтверждён»; «Этап 1 / 1» при «Продолжить». Это находка Н5 аудита, PR 2.
- **Ярлык связи на холсте перекрывает карточку Codex** (Н14).
- **«Один шаг» рядом с главной кнопкой не объяснён.**
- **Непонятные слова:** лид, исполнитель, проверяющий; ход, раунд, этап; песочница; push, QA; R1, C1, F1 — словарь терминов (Н11).
- **Пауза лимита не показывает текущий лимит.** Его нет в данных запуска для renderer, нужна правка main (Н7, PR 4).
