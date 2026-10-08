// UX audit 2026-10-05, PR 5: what the panel says about a taken result, the goal dialog's warning for uncommitted changes
// in «In the project folder», the choice for commands failing before any change, the cost labels, and «a separate
// copy» for a new project (a saved profile keeps its own mode).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createProfileStore, suggestProfile, validateProfile } from "../src/main/services/orchestration/profile.ts";
import { dirtyInPlace, failingOnSource, takeOutcomeText, takeSourceText, takenLines } from "../src/renderer/src/features/orchestration/runModel.ts";
import { t } from "../src/renderer/src/lib/i18n.ts";

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "canvastty-take-ui-")));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const TAKE = { mode: "copy", from: "checkpoint", stage: 2, files: 3, allowed: true, suggested: "raoden/x-12345678", runBranch: null, branch: null, applied: null };

test("the summary says what was taken of this result; nothing taken — nothing said", () => {
  assert.deepEqual(takenLines("ru", TAKE), []);
  assert.deepEqual(takenLines("ru", { ...TAKE, branch: { name: "raoden/x-12345678", at: "2026-10-08T10:00:00Z" } }), ["Результат забран: ветка raoden/x-12345678"]);
  const at = new Date(2026, 9, 8, 14, 5).toISOString();
  assert.deepEqual(takenLines("en", { ...TAKE, applied: { at } }), ["Result applied to the working folder at 14:05"]);
  assert.equal(takeSourceText("ru", TAKE), "Источник: контрольная точка этапа 2. Изменённых файлов: 3.");
  assert.match(takeSourceText("ru", { ...TAKE, from: "current", stage: null }), /текущее состояние рабочей копии — контрольной точки нет/);
  const conflict = takeOutcomeText("ru", { result: "conflict", files: ["a.txt", "b.txt"], take: TAKE }, "x");
  assert.match(conflict, /пересекаются с вашими правками в файлах \(a\.txt, b\.txt\).*ничего не изменилось.*Создать ветку в проекте/);
  assert.match(takeOutcomeText("ru", { result: "branch_exists", take: { ...TAKE, suggested: "raoden/x-12345678-2" } }, "raoden/x-12345678"),
    /Ветка raoden\/x-12345678 уже есть в проекте — её не трогали\. .*предложено raoden\/x-12345678-2/);
  assert.match(takeOutcomeText("en", { result: "created", take: { ...TAKE, branch: { name: "feat", at: "" } } }, "feat"), /Branch feat is created.*git switch feat/);
});

test("«In the project folder» with uncommitted changes: the dialog warns with their number; other modes or a clean folder do not", () => {
  const items = [{ id: "git", level: "info", detail: "", facts: { changed: 4 } }];
  assert.equal(dirtyInPlace("project", items), 4);
  assert.equal(dirtyInPlace("copy", items), null);
  assert.equal(dirtyInPlace("worktree", items), null);
  assert.equal(dirtyInPlace("project", [{ id: "git", level: "ok", detail: "", facts: { changed: 0 } }]), null);
  assert.equal(t("ru", "orchDirtyInPlace").replace("{n}", "4"), "В папке есть незакоммиченные изменения (4). Агенты будут править прямо их. Безопаснее — отдельная копия: ваши файлы не меняются, результат потом забирается кнопкой «Забрать результат». Переключение — только для этой цели, настройки проекта не меняются.");
  assert.equal(t("ru", "orchDirtySwitch"), "Переключить на отдельную копию");
});

test("commands failing before any change: only those a full check found failed, with their lines", () => {
  const items = [
    { id: "source_1", level: "ok", detail: "", facts: { command: "npm test", result: "passed" } },
    { id: "source_2", level: "warning", detail: "", facts: { command: "npm run lint", result: "failed" } },
    { id: "source_3", level: "warning", detail: "", facts: { command: "slow", result: "timeout" } },
    { id: "source_failing", level: "warning", detail: "", facts: { failing: 1 } }
  ];
  assert.deepEqual(failingOnSource(items), ["npm run lint"]);
  assert.deepEqual(failingOnSource([{ id: "commands", level: "ok", detail: "" }]), [], "the light check runs no command");
  assert.equal(t("ru", "orchFailingDrop"), "Убрать падающие команды из этого запуска");
  assert.equal(t("ru", "orchFailingKeep"), "Запустить как есть — агенты будут чинить и их");
  assert.equal(t("ru", "orchReady_source_cmd_passed"), "Прошла до изменений агентов (во временной копии проекта):");
  assert.equal(t("ru", "orchReady_source_cmd_failed"), "Упала до изменений агентов (во временной копии проекта):");
});

test("the cost labels: the card counts this agent's calls, the board the whole run", () => {
  assert.equal(t("ru", "orchCardCost").replace("{calls}", "4"), "Вызовы этого агента: 4");
  assert.match(t("ru", "orchCardCostTokens"), /^Вызовы этого агента: \{calls\} · токенов: \{tokens\}$/);
  assert.equal(t("ru", "orchCostTotal"), "Всего по запуску");
  assert.equal(t("en", "orchCardCost").replace("{calls}", "4"), "This agent's calls: 4");
  assert.equal(t("en", "orchCostTotal"), "The whole run");
});

test("a new project is suggested «a separate copy»; a saved profile keeps its mode", async () => {
  const dir = path.join(TMP, "p");
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const suggested = await suggestProfile(dir);
  assert.equal(suggested.workMode, "copy");
  assert.equal(validateProfile(suggested).workMode, "copy", "a copy is a mode a profile may hold");
  const store = createProfileStore(path.join(TMP, "root"));
  await store.save(dir, { ...suggested, workMode: "project" });
  assert.equal((await store.get(dir)).workMode, "project", "an existing profile is not changed");
});
