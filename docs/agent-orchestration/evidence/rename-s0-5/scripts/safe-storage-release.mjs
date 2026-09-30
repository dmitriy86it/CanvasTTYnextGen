// S0-5 on the release candidate: a secret saved through safeStorage by the old build (CanvasTTY 1.5.3) must stay
// readable by the renamed build (Raoden Loom) after the rename and after a restart, a failed decryption must neither
// delete nor rewrite it, and the old build must read it again after a rollback. Successor of
// ../../rename-s0/scripts/safe-storage-scenario.mjs (kept as it was): this version keeps every test profile, restarts the
// new build, records the operator's answer to each Keychain prompt and exercises a real refusal ("Deny").
//
// Runs ONLY in an isolated macOS account (it reads and creates the Keychain item "<app name> Safe Storage" of that
// account). It never deletes or edits a Keychain item. The secret is synthetic and goes through the plugin secrets API
// (the same safeStorage key the GitHub sign-in uses).
//
//   S0_ISOLATED_ACCOUNT=yes OLD_APP=<…/MacOS/CanvasTTY> NEW_APP=<…/MacOS/Raoden Loom> OUT=<dir> node safe-storage-release.mjs --run
//   node safe-storage-release.mjs --self-test     # the verdict on a fake stand: no app, no Keychain
//
// Exit code 0 only when every required check passed; 1 when one failed or the run stopped; 2 on wrong usage.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

const PLUGIN = "s0.secret-probe";
export const ANSWERS = { n: "no prompt", d: "prompt, Deny", a: "prompt, Allow", w: "prompt, Always Allow", x: "another system window, Cancel" };

// The steps in order. `expectDeny`: the operator is asked to press Deny if macOS asks here.
export const STEPS = [
  { id: "1", build: "old", act: "write+read", note: "old build writes s1 and reads it" },
  { id: "2", build: "new", act: "read", expectDeny: true, note: "new build reads s1 — if macOS asks, press DENY (Запретить)" },
  { id: "2b", build: "new", act: "read", note: "new build restarted reads s1 — if macOS asks, press ALWAYS ALLOW (Разрешить всегда)" },
  { id: "3", build: "old", act: "read", note: "old build reads s1 again" },
  { id: "4", build: "new", act: "write", note: "new build writes s2" },
  { id: "5", build: "old", act: "read", note: "old build reads s2 (rollback after a write by the new build)" },
  { id: "6", build: "new", act: "read", note: "new build restarted reads s2" }
];

// r[id] = { set?, get?, sha, prompt }; keychain = { before, after } by item name.
export function verdict(r, s1, s2, keychain) {
  const read = (x, expected) => x?.ok === true && x.v === expected;
  const denied = r["2"]?.prompt === "d";
  const checks = {
    oldWrites: r["1"]?.set?.ok === true && r["1"].sha !== null,
    oldReadsOwn: read(r["1"]?.get, s1),
    // Refused access: the read fails, the stored bytes stay. Otherwise the new build reads s1 at once.
    newFirstReadSafe: denied ? r["2"]?.get?.ok === false && r["2"].sha === r["1"]?.sha : read(r["2"]?.get, s1) && r["2"].sha === r["1"]?.sha,
    newReadsOldAfterRestart: read(r["2b"]?.get, s1),
    newReadKeepsBytes: r["2b"]?.sha === r["1"]?.sha,
    oldReadsAgain: read(r["3"]?.get, s1),
    oldReadKeepsBytes: r["3"]?.sha === r["1"]?.sha,
    newWrites: r["4"]?.set?.ok === true && r["4"].sha !== null && r["4"].sha !== r["1"]?.sha,
    oldReadsNew: read(r["5"]?.get, s2),
    rollbackReadKeepsBytes: r["5"]?.sha === r["4"]?.sha,
    newReadsOwnAfterRestart: read(r["6"]?.get, s2),
    lastReadKeepsBytes: r["6"]?.sha === r["4"]?.sha,
    // Both builds use one Keychain item: the renamed build did not start a key of its own.
    oneKeychainItem: keychain?.after?.canvastty === "present" && keychain?.after?.["Raoden Loom"] === "absent" && keychain?.after?.CanvasTTY === "absent",
    // Any window other than the access prompt (such as "Keychain Not Found") leaves the run inconclusive.
    noOtherSystemWindow: STEPS.every((s) => r[s.id]?.prompt !== "x")
  };
  return { checks, ok: Object.values(checks).every(Boolean), denyExercised: denied, prompts: Object.fromEntries(STEPS.map((s) => [s.id, ANSWERS[r[s.id]?.prompt] ?? "not recorded"])) };
}

export async function scenario({ withApp, sha, keychain, ask, step, secrets = [`synthetic-${randomUUID()}`, `synthetic-${randomUUID()}`] }) {
  const [s1, s2] = secrets;
  const get = (ev) => ev(`window.canvasTTY.plugins.secretsGet(${JSON.stringify(PLUGIN)}, "probe")`);
  const set = (ev, v) => ev(`window.canvasTTY.plugins.secretsSet(${JSON.stringify(PLUGIN)}, "probe", ${JSON.stringify(v)})`);
  const listed = (ev) => ev(`(await window.canvasTTY.plugins.list()).filter((p) => (p.manifest ?? p).id === ${JSON.stringify(PLUGIN)}).map((p) => (p.manifest ?? p).permissions)`);
  const kc = { before: keychain() };
  step("keychain before", kc.before);
  const r = {};
  for (const s of STEPS) {
    step(`step ${s.id}: ${s.note}`, {});
    const out = await withApp(s.build, async (ev) => {
      const o = { probe: await listed(ev) };
      if (s.act.startsWith("write")) o.set = await set(ev, s.id === "1" ? s1 : s2);
      if (s.act.endsWith("read")) o.get = await get(ev);
      return o;
    });
    out.sha = sha();
    out.prompt = await ask(s);
    r[s.id] = out;
    step(`step ${s.id} result`, { build: s.build, probe: out.probe, set: out.set, get: out.get === undefined ? undefined : { ok: out.get.ok, matches: out.get.ok ? out.get.v === (["1", "2", "2b", "3"].includes(s.id) ? s1 : s2) : undefined, error: out.get.e }, sha256: out.sha, prompt: ANSWERS[out.prompt] });
  }
  kc.after = keychain();
  step("keychain after", kc.after);
  return verdict(r, s1, s2, kc);
}

// A fake stand: one secret file and a key per build, walked step by step. A step answered "d" (Deny) fails its read;
// `fault` injects one failure by name.
export function fakeStand(fault = null, prompts = {}) {
  let file = null;
  let i = -1;
  const keyOf = (build) => (fault === "new-key-differs" && build === "new" ? "k2" : "k");
  return {
    sha: () => (file === null ? null : createHash("sha256").update(file).digest("hex")),
    keychain: () => ({ canvastty: file ? "present" : "absent", CanvasTTY: "absent", "Raoden Loom": fault === "second-item" ? "present" : "absent" }),
    ask: async (s) => prompts[s.id] ?? "n",
    step: () => {},
    withApp: async (build, fn) => {
      const id = STEPS[++i].id;
      return fn(async (expr) => {
        if (expr.includes("plugins.list()")) return { ok: true, v: [["secrets"]] };
        const m = /secretsSet\([^,]+, "probe", (".*")\)$/.exec(expr);
        if (m) {
          if (fault === "write-fails" && build === "new") return { ok: false, e: "synthetic" };
          file = `${keyOf(build)}:${JSON.parse(m[1])}`;
          return { ok: true };
        }
        if (prompts[id] === "d") {
          if (fault === "deny-deletes") file = null;
          if (fault === "deny-rewrites") file = `${file}x`;
          return { ok: false, e: "Error while decrypting the ciphertext" };
        }
        if (fault === "read-rewrites" && build === "new") file = `${file} `;
        const [key, ...rest] = (file ?? "").split(":");
        if (key !== keyOf(build)) return { ok: false, e: "Error while decrypting the ciphertext" };
        return { ok: true, v: rest.join(":").trimEnd() };
      });
    }
  };
}

async function selfTest() {
  const deny = { 2: "d", "2b": "w" };
  const cases = [
    ["no prompts", null, {}, true],
    ["Deny at step 2, then Always Allow", null, deny, true],
    ["Deny deletes the file", "deny-deletes", deny, false],
    ["Deny rewrites the file", "deny-rewrites", deny, false],
    ["the new build has another key", "new-key-differs", {}, false],
    ["a read rewrites the file", "read-rewrites", {}, false],
    ["the new build cannot write", "write-fails", {}, false],
    ["a second Keychain item", "second-item", {}, false],
    ["another system window", null, { 1: "x" }, false]
  ];
  let failed = 0;
  for (const [name, fault, prompts, expected] of cases) {
    const { ok } = await scenario({ ...fakeStand(fault, prompts), secrets: ["s1", "s2"] });
    const pass = ok === expected;
    if (!pass) failed += 1;
    console.log(`${pass ? "ok" : "FAIL"} ${name}: verdict ${ok}, expected ${expected}`);
  }
  return failed === 0 ? 0 : 1;
}

async function cli() {
  const mode = process.argv[2];
  if (mode === "--self-test") return selfTest();
  const { OLD_APP: OLD, NEW_APP: NEW, OUT } = process.env;
  if (mode !== "--run" || !OLD || !NEW || !OUT) {
    console.error("usage: S0_ISOLATED_ACCOUNT=yes OLD_APP=… NEW_APP=… OUT=<dir> node safe-storage-release.mjs --run   (or --self-test)");
    return 2;
  }
  if (process.env.S0_ISOLATED_ACCOUNT !== "yes") {
    console.error("--run touches the Keychain: set S0_ISOLATED_ACCOUNT=yes only in an isolated macOS account or machine.");
    return 2;
  }
  const { launch, sleep } = await import("./orchestration-app-kit.mjs");
  // Read only: macOS finds the login keychain through HOME. Without a default keychain the apps get "Keychain Not Found"
  // instead of the access prompt, so the run stops here. Nothing is created or reset.
  let defaultKeychain;
  try {
    defaultKeychain = execFileSync("security", ["default-keychain"], { encoding: "utf8", stdio: "pipe" }).trim();
  } catch (error) {
    console.error(`Связка ключей по умолчанию не найдена: ${String(error?.stderr ?? error).trim().replace(/\.$/, "")}. Проверка не запущена; связку ключей не сбрасывайте.`);
    return 2;
  }
  const B = fs.mkdtempSync("/tmp/rs0-"); // short: the agent browser socket lives under userData. Kept after the run.
  // The account's own HOME, not a temporary one: the first attempt (2026-09-29) gave the apps /tmp/rs0-*/home, macOS
  // found no default keychain there and showed "Keychain Not Found". The profile stays temporary (--user-data-dir).
  const HOME = process.env.HOME;
  const P = path.join(B, "profile");
  fs.mkdirSync(path.join(P, "plugins", PLUGIN), { recursive: true });
  fs.writeFileSync(path.join(P, "plugins", PLUGIN, "canvastty.plugin.json"), JSON.stringify({
    apiVersion: 1, id: PLUGIN, name: "S0 secret probe", version: "0.0.1", description: "Synthetic secret for S0-5", permissions: ["secrets"],
    contributions: [{ id: "probe", kind: "canvas-app", title: "Probe", entry: "probe.html", defaultSize: { width: 400, height: 300 } }]
  }));
  fs.writeFileSync(path.join(P, "plugins", PLUGIN, "probe.html"), "<!doctype html><title>probe</title>");
  fs.writeFileSync(path.join(P, "plugins.json"), JSON.stringify({ [PLUGIN]: { sourceUrl: "https://github.com/example/s0-secret-probe", enabled: true, installedAt: Date.now() } }));
  const ENV = { HOME, SHELL: "/bin/sh", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  const secretFile = path.join(P, "plugin-secrets", `${PLUGIN}.bin`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let port = 9870;
  const steps = [{ name: "setup", account: execFileSync("id", ["-un"], { encoding: "utf8" }).trim(), home: HOME, defaultKeychain, oldApp: OLD, newApp: NEW, work: B }];
  const save = () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "safe-storage-release.json"), JSON.stringify(steps, null, 2));
  };
  // Ctrl-C or a closed terminal still leaves what was recorded; the test data is not removed.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => {
    steps.push({ name: "interrupted", signal: sig });
    save();
    console.log(`Прервано (${sig}). Записанное: ${path.join(OUT, "safe-storage-release.json")}; рабочие данные: ${B}`);
    process.exit(1);
  });
  const deps = {
    sha: () => (fs.existsSync(secretFile) ? createHash("sha256").update(fs.readFileSync(secretFile)).digest("hex") : null),
    keychain: () => Object.fromEntries(["canvastty", "CanvasTTY", "Raoden Loom", "Raoden", "raoden-loom"].map((n) => {
      try { execFileSync("security", ["find-generic-password", "-s", `${n} Safe Storage`], { stdio: "pipe" }); return [n, "present"]; } catch { return [n, "absent"]; }
    })),
    step: (name, value) => { steps.push({ name, ...value }); console.log(name, JSON.stringify(value)); },
    ask: async (s) => {
      for (;;) {
        const a = (await rl.question(`Шаг ${s.id}: был ли запрос доступа к связке ключей? n — нет, d — нажали «Запретить», a — «Разрешить», w — «Разрешить всегда», x — было другое системное окно, нажали «Отменить»: `)).trim().toLowerCase();
        if (a in ANSWERS) return a;
      }
    },
    withApp: async (build, fn) => {
      const app = await launch({ userData: P, port: port++, shots: B, executable: build === "old" ? OLD : NEW, env: ENV });
      try {
        await app.waitFor("document.querySelector('.workspace') && window.canvasTTY && true", "window", 60_000);
        await sleep(1500);
        return await fn((expr) => app.ev(`(async () => ${expr})().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e && e.message || e) }))`));
      } finally {
        await app.quit();
      }
    }
  };
  let code = 1;
  try {
    console.log("Перед каждым шагом смотрите на экран: если macOS спросит о доступе к связке ключей, на шаге 2 нажмите «Запретить», на шаге 2b и остальных — «Разрешить всегда». Любое другое окно (например «Связка ключей не найдена») — «Отменить», не «Вернуть по умолчанию», ответ x.");
    const result = await scenario(deps);
    deps.step("verdict", result);
    code = result.ok ? 0 : 1;
  } catch (error) {
    deps.step("aborted", { error: String(error?.stack ?? error) });
  } finally {
    rl.close();
    save();
    // The test profile, the secret file and the app output stay for the review: copied, never deleted here.
    fs.cpSync(B, path.join(OUT, "work"), { recursive: true, verbatimSymlinks: true, filter: (src) => !/\.sock$/.test(src) });
    console.log(`Результат: ${path.join(OUT, "safe-storage-release.json")} (код ${code}). Рабочие данные: ${B} и копия в ${path.join(OUT, "work")}`);
  }
  return code;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await cli();
