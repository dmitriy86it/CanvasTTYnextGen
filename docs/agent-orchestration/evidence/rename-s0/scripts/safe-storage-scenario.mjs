// S0-5: does a secret saved through safeStorage by the old build stay readable by the renamed build, and back?
// Runs ONLY in an isolated macOS account or on a separate machine: the check itself reads and creates Keychain items
// ("<app name> Safe Storage"). It never deletes or edits a Keychain item and never changes keychain settings.
//
// The secret is synthetic and goes through the plugin secrets API (the same safeStorage key the GitHub sign-in uses;
// no OAuth). A test plugin "s0.secret-probe" with the "secrets" permission is placed in the temporary profile first.
//
//   OLD_APP=<…/CanvasTTY.app/Contents/MacOS/CanvasTTY> NEW_APP=<…/Raoden Loom.app/Contents/MacOS/Raoden Loom> \
//     node safe-storage-scenario.mjs --validate-seeding   # both builds list the probe plugin with "secrets"; no secret call
//   S0_ISOLATED_ACCOUNT=yes OLD_APP=… NEW_APP=… node safe-storage-scenario.mjs --run
//   node safe-storage-scenario.mjs --self-test            # the verdicts on a fake stand: no app, no Keychain
//
// Exit code 0 only when every required check passed; 1 when one failed; 2 on wrong usage.
// Needs `scripts/orchestration-app-kit.mjs` of the repository (run from this directory inside the checkout).
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PLUGIN = "s0.secret-probe";

// --validate-seeding: each build must list the probe plugin with the "secrets" permission, and no secret file may appear.
export function seedingVerdict({ oldListed, newListed, secretSha256 }) {
  const lists = (r) => r?.ok === true && Array.isArray(r.v) && r.v.length === 1 && Array.isArray(r.v[0]) && r.v[0].includes("secrets");
  const checks = { oldBuildListsProbe: lists(oldListed), newBuildListsProbe: lists(newListed), noSecretFile: secretSha256 === null };
  return { checks, ok: Object.values(checks).every(Boolean) };
}

// --run: every call succeeded, each read returned the expected secret, the file exists after each write, and no read
// changed its bytes.
export function runVerdict(r, s1, s2) {
  const read = (x, expected) => x?.ok === true && x.v === expected;
  const checks = {
    oldWrites: r.oldSet?.ok === true && r.afterOldWrite !== null,
    oldReadsOwn: read(r.oldGet, s1),
    newReadsOld: read(r.newRead1, s1),
    newReadKeepsBytes: r.afterNewRead1 === r.afterOldWrite,
    oldReadsAgain: read(r.oldRead2, s1),
    oldReadKeepsBytes: r.afterOldRead2 === r.afterOldWrite,
    newWrites: r.newSet?.ok === true && r.afterNewWrite !== null && r.afterNewWrite !== r.afterOldWrite,
    oldReadsNew: read(r.oldRead3, s2),
    rollbackReadKeepsBytes: r.afterOldRead3 === r.afterNewWrite
  };
  return { checks, ok: Object.values(checks).every(Boolean) };
}

// The scenario itself; `withApp(build, fn)` runs fn(ev) in that build, `sha()` hashes the secret file (null if absent).
export async function scenario(mode, { withApp, sha, keychain, step, secrets = [`synthetic-${randomUUID()}`, `synthetic-${randomUUID()}`] }) {
  const listed = (ev) => ev(`(await window.canvasTTY.plugins.list()).filter((p) => p.manifest?.id === ${JSON.stringify(PLUGIN)} || p.id === ${JSON.stringify(PLUGIN)}).map((p) => (p.manifest ?? p).permissions)`);
  const get = (ev) => ev(`window.canvasTTY.plugins.secretsGet(${JSON.stringify(PLUGIN)}, "probe")`);
  const set = (ev, v) => ev(`window.canvasTTY.plugins.secretsSet(${JSON.stringify(PLUGIN)}, "probe", ${JSON.stringify(v)})`);
  if (mode === "--validate-seeding") {
    const oldListed = await withApp("old", listed);
    step("old build lists the probe plugin", oldListed);
    const newListed = await withApp("new", listed);
    step("new build lists the probe plugin", newListed);
    const secretSha256 = sha();
    step("no secret file was written", { sha256: secretSha256 });
    return seedingVerdict({ oldListed, newListed, secretSha256 });
  }
  const [s1, s2] = secrets;
  const r = {};
  step("keychain before", keychain());
  await withApp("old", async (ev) => { r.oldSet = await set(ev, s1); r.oldGet = await get(ev); });
  r.afterOldWrite = sha();
  step("1 old build writes and reads s1", { set: r.oldSet, get: r.oldGet, sha256: r.afterOldWrite });
  r.newRead1 = await withApp("new", get);
  r.afterNewRead1 = sha();
  step("2 new build reads s1", { ...r.newRead1, sha256: r.afterNewRead1 });
  r.oldRead2 = await withApp("old", get);
  r.afterOldRead2 = sha();
  step("3 old build reads s1 again", { ...r.oldRead2, sha256: r.afterOldRead2 });
  r.newSet = await withApp("new", (ev) => set(ev, s2));
  r.afterNewWrite = sha();
  step("4 new build writes s2", { ...r.newSet, sha256: r.afterNewWrite });
  r.oldRead3 = await withApp("old", get);
  r.afterOldRead3 = sha();
  step("5 old build reads s2 (rollback after a write by the new build)", { ...r.oldRead3, sha256: r.afterOldRead3 });
  step("keychain after", keychain());
  return runVerdict(r, s1, s2);
}

// A fake stand: an in-memory secret store per build and a key per build; faults are injected by name.
export function fakeStand(fault = null) {
  const keys = { old: "k", new: fault === "new-key-differs" ? "k2" : "k" };
  let file = null;
  const stand = {
    sha: () => (file === null ? null : createHash("sha256").update(file).digest("hex")),
    keychain: () => ({ fake: "no Keychain" }),
    withApp: async (build, fn) => fn(async (expr) => {
      if (expr.includes("plugins.list()")) {
        if (fault === "plugin-missing" && build === "new") return { ok: true, v: [] };
        return { ok: true, v: [fault === "permission-missing" && build === "old" ? [] : ["secrets"]] };
      }
      const setMatch = /secretsSet\([^,]+, "probe", (".*")\)$/.exec(expr);
      if (setMatch) {
        if (fault === "write-fails" && build === "new") return { ok: false, e: "synthetic write failure" };
        if (fault === "write-no-file" && build === "old") return { ok: true, v: undefined };
        file = `${keys[build]}:${JSON.parse(setMatch[1])}`;
        return { ok: true, v: undefined };
      }
      if (expr.includes("secretsGet")) {
        if (file === null) return { ok: true, v: null };
        if (fault === "read-rewrites" && build === "new") file = `${file} `;
        const [key, ...rest] = file.split(":");
        if (key !== keys[build]) return { ok: false, e: "Error while decrypting the ciphertext" };
        return { ok: true, v: rest.join(":").trimEnd() };
      }
      return { ok: false, e: `unexpected expression ${expr}` };
    }),
    writeSecretFile: () => { file = "k:stray"; }
  };
  return stand;
}

export async function main(mode, deps) {
  const result = await scenario(mode, deps);
  deps.step("verdict", { ...result, note: "Record separately whether macOS asked for Keychain access at any step (a prompt is not a failure to decrypt)." });
  return result.ok ? 0 : 1;
}

async function selfTest() {
  const quiet = () => {};
  const cases = [
    ["--validate-seeding", null, 0], ["--validate-seeding", "plugin-missing", 1], ["--validate-seeding", "permission-missing", 1],
    ["--validate-seeding", "stray-secret-file", 1],
    ["--run", null, 0], ["--run", "new-key-differs", 1], ["--run", "write-fails", 1], ["--run", "write-no-file", 1],
    ["--run", "read-rewrites", 1]
  ];
  let failed = 0;
  for (const [mode, fault, expected] of cases) {
    const stand = fakeStand(fault);
    if (fault === "stray-secret-file") stand.writeSecretFile();
    const code = await main(mode, { ...stand, step: quiet });
    const pass = code === expected;
    if (!pass) failed += 1;
    console.log(`${pass ? "ok" : "FAIL"} ${mode} ${fault ?? "no fault"}: exit ${code}, expected ${expected}`);
  }
  return failed === 0 ? 0 : 1;
}

async function cli() {
  const mode = process.argv[2];
  if (mode === "--self-test") return selfTest();
  const OLD = process.env.OLD_APP, NEW = process.env.NEW_APP;
  if (!OLD || !NEW || !["--validate-seeding", "--run"].includes(mode)) {
    console.error("usage: OLD_APP=… NEW_APP=… node safe-storage-scenario.mjs --validate-seeding | --run   (or --self-test)");
    return 2;
  }
  if (mode === "--run" && process.env.S0_ISOLATED_ACCOUNT !== "yes") {
    console.error("--run touches the Keychain: set S0_ISOLATED_ACCOUNT=yes only in an isolated macOS account or machine.");
    return 2;
  }
  const { launch, sleep } = await import("../../../../../scripts/orchestration-app-kit.mjs");
  const B = fs.mkdtempSync("/tmp/cto-ss-"); // short: the agent browser socket lives under userData
  const HOME = path.join(B, "home");
  fs.mkdirSync(HOME);
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
  let port = 9870;
  const steps = [];
  const deps = {
    sha: () => (fs.existsSync(secretFile) ? createHash("sha256").update(fs.readFileSync(secretFile)).digest("hex") : null),
    keychain: () => Object.fromEntries(["canvastty", "CanvasTTY", "Raoden Loom"].map((n) => {
      try { execFileSync("security", ["find-generic-password", "-s", `${n} Safe Storage`], { stdio: "pipe" }); return [n, "present"]; } catch { return [n, "absent"]; }
    })),
    step: (name, value) => { steps.push({ name, ...value }); console.log(name, JSON.stringify(value)); },
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
  try {
    return await main(mode, deps);
  } catch (error) {
    deps.step("aborted", { error: String(error?.message ?? error) });
    return 1;
  } finally {
    fs.writeFileSync(path.join(process.cwd(), `safe-storage-${mode.slice(2)}-${Date.now()}.json`), JSON.stringify(steps, null, 2));
    fs.rmSync(B, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await cli();
