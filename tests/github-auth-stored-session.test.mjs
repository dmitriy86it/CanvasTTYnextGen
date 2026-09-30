// A saved GitHub sign-in that cannot be read is "unavailable", not "absent": its encrypted file is kept byte for byte,
// a new sign-in copies it aside before replacing it, and it is read again once the keychain gives the old key back.
// A failed or interrupted write never leaves the saved sign-in undiscoverable.
// Fake safeStorage and network only: no OAuth, no token, no Keychain.
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { GithubAuthService } from "../src/main/services/GithubAuthService.ts";

// A keychain with one key at a time: data encrypted under another key does not decrypt.
function keychain(key = "old") {
  const k = { key, available: true };
  k.safeStorage = {
    isEncryptionAvailable: () => k.available,
    encryptString: (value) => Buffer.from(`${k.key}:${value}`, "utf8"),
    decryptString: (value) => {
      const text = value.toString("utf8");
      if (!text.startsWith(`${k.key}:`)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return text.slice(k.key.length + 1);
    }
  };
  return k;
}
const fetcherFor = (login, token) => async (url) => {
  if (String(url).endsWith("/login/device/code")) {
    return Response.json({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
  }
  if (String(url).endsWith("/login/oauth/access_token")) return Response.json({ access_token: token, token_type: "bearer", scope: "" });
  if (String(url) === "https://api.github.com/user") return Response.json({ login });
  return new Response("missing", { status: 404 });
};
const service = (dir, k, login = "new-login", token = "new-token", fetcher = fetcherFor(login, token)) =>
  new GithubAuthService(dir, "client-id", { fetcher, safeStorage: k.safeStorage, now: () => 1_000_000, delay: async () => undefined });
// The bytes an earlier build left: tokens encrypted under that build's key.
const bytesFor = (key, login = "old-login") =>
  JSON.stringify({ data: Buffer.from(`${key}:${JSON.stringify({ accessToken: login === "old-login" ? "old-token" : `${login}-token`, refreshToken: null, expiresAt: null, login })}`).toString("base64") });
async function savedBy(dir, key, login = "old-login", name = "github-oauth.json") {
  const bytes = bytesFor(key, login);
  await writeFile(`${dir}/${name}`, bytes, { mode: 0o600 });
  return bytes;
}
const files = async (dir) => (await readdir(dir)).filter((n) => n.startsWith("github-oauth")).sort();
const snapshot = async (dir) => Object.fromEntries(await Promise.all((await files(dir)).map(async (n) => [n, await readFile(`${dir}/${n}`, "utf8")])));
const fresh = async (dir, key) => {
  const s = service(dir, keychain(key));
  await s.load();
  return s.status();
};
const kept = async (dir) => (await readdir(dir)).filter((n) => n.startsWith("github-oauth.previous"));
async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for test condition.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
// The new tokens are set and their store write is queued in the same tick, so once the status shows the new login
// the service's store queue holds exactly that write: wait for it, not for a fixed time.
async function signIn(s, login = "new-login") {
  await s.startDeviceFlow();
  await waitFor(async () => (await s.status()).login === login);
  await s.storeWrite;
}
// A flow that ends without tokens: wait until the poll itself has finished.
async function flowEnds(s) {
  await s.startDeviceFlow();
  await waitFor(() => s.deviceFlow === null);
  await s.storeWrite;
}
const withDir = async (fn) => {
  const dir = await mkdtemp(`${tmpdir()}/canvastty-github-stored-`);
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test("a decryption error: the saved sign-in is unavailable, not absent, and its bytes stay", () => withDir(async (dir) => {
  const original = await savedBy(dir, "old");
  const s = service(dir, keychain("new"));
  await s.load();
  const st = await s.status();
  assert.equal(st.authorized, false);
  assert.equal(st.storedSessionUnavailable, true, "told apart from 'not signed in'");
  assert.equal(await readFile(`${dir}/github-oauth.json`, "utf8"), original);
  assert.equal(await s.getToken(), null);
}));

test("the keychain unavailable for a while: nothing is lost, and the same sign-in is read when it is back", () => withDir(async (dir) => {
  const original = await savedBy(dir, "old");
  const k = keychain("old");
  k.available = false;
  const s = service(dir, k);
  await s.load();
  assert.equal((await s.status()).storedSessionUnavailable, true);
  // a sign-in while the keychain is unavailable is kept in memory only: the saved file is not touched
  await signIn(s);
  assert.equal(await readFile(`${dir}/github-oauth.json`, "utf8"), original);
  assert.deepEqual(await kept(dir), []);
  k.available = true;
  const again = service(dir, k);
  await again.load();
  assert.equal((await again.status()).login, "old-login");
  assert.equal(await again.getToken(), "old-token");
}));

test("a new sign-in after a decryption error keeps the old file aside byte for byte; the old key reads it again", () => withDir(async (dir) => {
  const original = await savedBy(dir, "old");
  const k = keychain("new");
  const s = service(dir, k);
  await s.load();
  await signIn(s);
  const aside = await kept(dir);
  assert.equal(aside.length, 1, "the unreadable file copied aside, not lost");
  assert.equal(await readFile(`${dir}/${aside[0]}`, "utf8"), original, "the same bytes");
  assert.equal((await s.status()).login, "new-login");
  const newBytes = await readFile(`${dir}/github-oauth.json`, "utf8");
  // the key comes back (the keychain entry is restored): the new file does not decrypt, the kept one does
  k.key = "old";
  const restored = service(dir, k);
  await restored.load();
  assert.equal((await restored.status()).login, "old-login");
  assert.equal(await restored.getToken(), "old-token");
  assert.equal(await readFile(`${dir}/github-oauth.json`, "utf8"), newBytes, "loading rewrites nothing");
  assert.equal(await readFile(`${dir}/${aside[0]}`, "utf8"), original);
}));

test("an ordinary sign-in over a readable one replaces it as before, with nothing kept aside", () => withDir(async (dir) => {
  await savedBy(dir, "old");
  const k = keychain("old");
  const s = service(dir, k);
  await s.load();
  assert.equal((await s.status()).login, "old-login");
  assert.equal((await s.status()).storedSessionUnavailable, false);
  await signIn(s);
  const next = service(dir, k);
  await next.load();
  assert.equal((await next.status()).login, "new-login");
  assert.deepEqual(await kept(dir), []);
}));

test("an explicit sign-out removes the saved sign-in and the kept one", () => withDir(async (dir) => {
  await savedBy(dir, "old");
  const s = service(dir, keychain("new"));
  await s.load();
  await signIn(s);
  assert.equal((await kept(dir)).length, 1);
  await writeFile(`${dir}/github-oauth.json.leftover.tmp`, "{}"); // a prepared file left by an interrupted write
  await s.signOut();
  assert.deepEqual(await files(dir), []);
  const st = await s.status();
  assert.equal(st.authorized, false);
  assert.equal(st.storedSessionUnavailable, false);
}));

test("settings show the unavailable notice with its own explicit sign-out", async () => {
  const section = await readFile(new URL("../src/renderer/src/features/plugins/PluginSettingsSection.tsx", import.meta.url), "utf8");
  const block = section.slice(section.indexOf("githubStatus?.storedSessionUnavailable && ("));
  const notice = block.slice(0, block.indexOf("</div>"));
  assert.match(notice, /data-github-stored-unavailable/);
  assert.match(notice, /onClick=\{\(\) => void runGithubSignOut\(\)\}/);
});

test("encryptString fails: the saved file keeps its place and bytes, a copy is kept, the old key reads it", () => withDir(async (dir) => {
  const original = await savedBy(dir, "old");
  const k = keychain("new");
  let attempted = 0;
  k.safeStorage.encryptString = () => { attempted += 1; throw new Error("synthetic encryption failure"); };
  const s = service(dir, k);
  await s.load();
  await signIn(s);
  assert.equal(attempted, 1);
  assert.equal(await readFile(`${dir}/github-oauth.json`, "utf8"), original, "the main file is never moved");
  const aside = await kept(dir);
  assert.equal(aside.length, 1);
  assert.equal(await readFile(`${dir}/${aside[0]}`, "utf8"), original);
  assert.deepEqual((await files(dir)).filter((n) => n.endsWith(".tmp")), []);
  assert.equal((await fresh(dir, "new")).storedSessionUnavailable, true, "still unavailable, not absent");
  assert.equal((await fresh(dir, "old")).login, "old-login");
  // a second failure does not pile up identical copies
  const again = service(dir, k);
  await again.load();
  await signIn(again);
  assert.equal((await kept(dir)).length, 1);
}));

test("writing the prepared file fails: the saved file and its copy stay, nothing half-written is read", () => withDir(async (dir) => {
  const original = await savedBy(dir, "old");
  const k = keychain("new");
  const encrypt = k.safeStorage.encryptString;
  // The copy aside is made before encryption; from here the directory is read-only, so the prepared file cannot be written.
  k.safeStorage.encryptString = (value) => { chmodSync(dir, 0o555); return encrypt(value); };
  const s = service(dir, k);
  await s.load();
  try {
    await signIn(s);
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.equal(await readFile(`${dir}/github-oauth.json`, "utf8"), original);
  const aside = await kept(dir);
  assert.equal(aside.length, 1);
  assert.equal(await readFile(`${dir}/${aside[0]}`, "utf8"), original);
  assert.deepEqual((await files(dir)).filter((n) => n.endsWith(".tmp")), []);
  assert.equal((await fresh(dir, "new")).storedSessionUnavailable, true);
  assert.equal((await fresh(dir, "old")).login, "old-login");
}));

test("every state an interrupted write can leave on disk: the old sign-in is found or reported unavailable", () => withDir(async (dir) => {
  const original = bytesFor("old");
  const copy = "github-oauth.previous-1000000-aaaaaaaa.json";
  const prepared = bytesFor("new", "new-login");
  const states = {
    "the copy half made": { "github-oauth.json": original, [`${copy}.x.tmp`]: original.slice(0, 10) },
    "copied, nothing prepared": { "github-oauth.json": original, [copy]: original },
    "copied and prepared, not yet renamed": { "github-oauth.json": original, [copy]: original, "github-oauth.json.y.tmp": prepared },
    "renamed": { "github-oauth.json": prepared, [copy]: original },
    "main missing (left by the earlier move-aside write)": { [copy]: original }
  };
  for (const [name, state] of Object.entries(states)) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
    for (const [file, bytes] of Object.entries(state)) await writeFile(`${dir}/${file}`, bytes);
    const before = await snapshot(dir);
    const withOld = await fresh(dir, "old");
    assert.equal(withOld.login, "old-login", `${name}: the old key reads the old sign-in`);
    const withNew = await fresh(dir, "new");
    if (state["github-oauth.json"] === prepared) assert.equal(withNew.login, "new-login", name);
    else assert.deepEqual([withNew.authorized, withNew.storedSessionUnavailable], [false, true], `${name}: unavailable, not absent`);
    assert.deepEqual(await snapshot(dir), before, `${name}: reading changes no bytes`);
  }
}));

test("main missing: a readable copy is found; an unreadable one is unavailable; no file at all is absent", () => withDir(async (dir) => {
  const copy = await savedBy(dir, "old", "old-login", "github-oauth.previous-1-test.json");
  const found = await fresh(dir, "old");
  assert.deepEqual([found.authorized, found.login, found.storedSessionUnavailable], [true, "old-login", false]);
  const unavailable = await fresh(dir, "new");
  assert.deepEqual([unavailable.authorized, unavailable.storedSessionUnavailable], [false, true]);
  assert.equal(await readFile(`${dir}/github-oauth.previous-1-test.json`, "utf8"), copy);
  await rm(`${dir}/github-oauth.previous-1-test.json`);
  const absent = await fresh(dir, "old");
  assert.deepEqual([absent.authorized, absent.storedSessionUnavailable], [false, false]);
}));

test("several copies: newest readable first by the time in the name, not by name or directory order", () => withDir(async (dir) => {
  // lexical order would pick 5 before 7 and "previous-legacy" before both
  await savedBy(dir, "old", "at-5", "github-oauth.previous-5-b.json");
  await savedBy(dir, "old", "at-7", "github-oauth.previous-7-a.json");
  await savedBy(dir, "old", "legacy", "github-oauth.previous-legacy.json");
  assert.equal((await fresh(dir, "old")).login, "at-7");
  // the newest one unreadable: the next readable is used
  await savedBy(dir, "other", "at-9", "github-oauth.previous-9-c.json");
  assert.equal((await fresh(dir, "old")).login, "at-7");
  // a readable main file wins over every copy
  await savedBy(dir, "old", "main");
  assert.equal((await fresh(dir, "old")).login, "main");
  // same time: by name
  await rm(`${dir}/github-oauth.json`);
  await savedBy(dir, "old", "at-7-b", "github-oauth.previous-7-b.json");
  assert.equal((await fresh(dir, "old")).login, "at-7");
  // names without a time come last
  for (const n of ["github-oauth.previous-5-b.json", "github-oauth.previous-7-a.json", "github-oauth.previous-7-b.json"]) await rm(`${dir}/${n}`);
  assert.equal((await fresh(dir, "old")).login, "legacy");
}));

test("a refused or failed new authorization changes no saved file", () => withDir(async (dir) => {
  await savedBy(dir, "old");
  const before = await snapshot(dir);
  const refused = async (url) => String(url).endsWith("/login/oauth/access_token")
    ? Response.json({ error: "access_denied" })
    : fetcherFor("x", "y")(url);
  const failed = async (url) => {
    if (String(url).endsWith("/login/oauth/access_token")) throw new Error("synthetic network failure");
    return fetcherFor("x", "y")(url);
  };
  for (const fetcher of [refused, failed]) {
    const s = service(dir, keychain("new"), "x", "y", fetcher);
    await s.load();
    await flowEnds(s);
    assert.equal((await s.status()).storedSessionUnavailable, true);
    assert.deepEqual(await snapshot(dir), before);
  }
  assert.equal((await fresh(dir, "old")).login, "old-login");
}));
