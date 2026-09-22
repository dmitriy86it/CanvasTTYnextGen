import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  localOrigin,
  randomLocalHex,
  sealLocal,
  unsealLocal,
  validateLocalRequest,
} from "../src/shared/localLink.ts";
import { LocalLink } from "../src/main/services/companion/LocalLink.ts";
import { localFetcher } from "../integrations/even-g2/src/local-fetch.mjs";
import { SpeechSetup } from "../src/main/services/companion/SpeechSetup.ts";
import { createHash } from "node:crypto";
const connection = () => ({
  version: 1,
  computer: randomLocalHex(),
  key: randomLocalHex(),
  origins: [
    "http://192.168.2.3:3481",
    "http://[fdea::123]:3481",
    "http://example.local:3481",
  ],
});
test("local endpoints reject public, loopback and credential URLs", () => {
  for (const url of [
    "https://example.com:3481",
    "http://example.com:3481",
    "http://8.8.8.8:3481",
    "http://127.0.0.1:3481",
    "http://192.168.1.1:3481/secret",
    "http://u:p@192.168.1.1:3481",
    "http://192.168.1.1:3481?x=1",
    "http://[2001:db8::1]:3481",
  ])
    assert.throws(() => localOrigin(url));
});
test("local encryption binds computer, packet and direction, and hides bearer and PCM", async () => {
  const c = connection();
  const p = await sealLocal(
    c,
    { token: "secret bearer", audio: "PCM" },
    "request",
  );
  assert.ok(!JSON.stringify(p).includes("secret"));
  assert.equal((await unsealLocal(c, p, "request")).audio, "PCM");
  await assert.rejects(
    unsealLocal({ ...c, computer: randomLocalHex() }, p, "request"),
  );
  await assert.rejects(unsealLocal(c, p, "response"));
  await assert.rejects(
    unsealLocal(c, { ...p, id: randomLocalHex(16) }, "request"),
  );
  assert.throws(() =>
    validateLocalRequest({
      path: "//example.com",
      method: "GET",
      token: "",
      sentAt: Date.now(),
    }),
  );
});
test("local address fallback probes without credentials and never retries an uncertain mutation", async () => {
  const c = connection();
  let actual = 0,
    probes = 0;
  const fetcher = async (url, options) => {
    const p = JSON.parse(options.body),
      r = await unsealLocal(c, p, "request");
    if (r.token === "") probes++;
    if (url.startsWith(c.origins[0])) throw new Error("VPN blocks IPv4");
    if (r.token) {
      actual++;
      throw new Error("Reply lost after write");
    }
    return new Response(
      JSON.stringify(
        await sealLocal(c, { status: 401, body: {} }, "response", p.id),
      ),
    );
  };
  const send = localFetcher(c, { fetcher });
  await assert.rejects(
    send(c.origins[0] + "/g2/api/control", {
      method: "POST",
      headers: { Authorization: "Bearer " + "b".repeat(64) },
      body: JSON.stringify({ action: "text" }),
    }),
    /локальной связи/,
  );
  assert.equal(actual, 1);
  assert.equal(probes, 3);
});
const homeProbe = () => ({ path: "/g2/api/home", method: "GET", token: "", sentAt: Date.now() });
const unauthorized = async () => ({ status: 401, body: {} });

test("local encrypted duplicate is idempotent", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "local-link-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const link = new LocalLink(path);
  await link.load();
  const c = link.issue(["http://192.168.1.2:3481"], Date.now() + 60_000);
  const packet = await sealLocal(c, homeProbe(), "request");
  let calls = 0;
  const forward = async () => {
    calls++;
    return { status: 401, body: {} };
  };
  await Promise.all([
    link.receive(packet, forward),
    link.receive(packet, forward),
  ]);
  assert.equal(calls, 1);
});

test("every handshake gets its own key; only an approved key survives restart and revocation removes it", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "local-link-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const origins = ["http://192.168.1.2:3481"];
  const link = new LocalLink(path);
  await link.load();
  const approved = link.issue(origins, Date.now() + 60_000);
  const rejected = link.issue(origins, Date.now() + 60_000);
  assert.notEqual(approved.key, rejected.key);
  assert.notEqual(approved.computer, rejected.computer);

  // A rejected handshake's key cannot open packets sealed for another device.
  const packet = await sealLocal(approved, homeProbe(), "request");
  const reply = await link.receive(packet, async (_request, device) => {
    assert.equal(device.computer, approved.computer);
    assert.equal(device.peerId, undefined);
    return { status: 401, body: {} };
  });
  await assert.rejects(unsealLocal(rejected, reply, "response"));
  assert.equal((await unsealLocal(approved, reply, "response")).status, 401);

  const peerId = randomLocalHex(16);
  link.claim(approved.computer, peerId);
  await link.approve(peerId);
  link.discardUnbound();
  await assert.rejects(link.receive(await sealLocal(rejected, homeProbe(), "request"), unauthorized), /invalid-local-packet/);

  const next = new LocalLink(path);
  await next.load();
  const restarted = await next.receive(await sealLocal(approved, homeProbe(), "request"), async (_request, device) => {
    assert.equal(device.peerId, peerId);
    return { status: 401, body: {} };
  });
  assert.equal((await unsealLocal(approved, restarted, "response")).status, 401);

  await next.revoke(undefined);
  await next.revoke("");
  assert.equal((await unsealLocal(approved, await next.receive(await sealLocal(approved, homeProbe(), "request"), unauthorized), "response")).status, 401);
  await next.revoke(peerId);
  await assert.rejects(next.receive(await sealLocal(approved, homeProbe(), "request"), unauthorized), /invalid-local-packet/);
  const afterRevoke = new LocalLink(path);
  await afterRevoke.load();
  await assert.rejects(afterRevoke.receive(await sealLocal(approved, homeProbe(), "request"), unauthorized), /invalid-local-packet/);
});

test("an unclaimed handshake key expires with its pairing window", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "local-link-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const link = new LocalLink(path);
  await link.load();
  const expired = link.issue(["http://192.168.1.2:3481"], Date.now() - 1);
  await assert.rejects(link.receive(await sealLocal(expired, homeProbe(), "request"), unauthorized), /invalid-local-packet/);
});

test("the shared install-wide key of the previous format is never accepted again", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "local-link-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const legacy = { computer: randomLocalHex(), key: randomLocalHex() };
  await writeFile(join(path, "even-g2-local.json"), JSON.stringify(legacy));
  const link = new LocalLink(path);
  await link.load();
  const packet = await sealLocal({ version: 1, ...legacy, origins: [] }, homeProbe(), "request");
  await assert.rejects(link.receive(packet, unauthorized), /invalid-local-packet/);
});

test("speech preparation checks model bytes before accepting a download; bad download stays unavailable", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "speech-setup-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const binary = join(path, "helper");
  await writeFile(binary, "fixture");
  const data = Buffer.from("model-fixture");
  const model = {
    name: "Test",
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    url: "https://model.example/pinned",
  };
  const setup = new SpeechSetup({
    userDataPath: path,
    binary,
    model,
    fetcher: async () => new Response(data),
  });
  await setup.prepare();
  assert.equal(setup.state().phase, "ready");
  const bad = new SpeechSetup({
    userDataPath: join(path, "bad"),
    binary,
    model,
    fetcher: async () => new Response(Buffer.alloc(data.length)),
  });
  await assert.rejects(bad.prepare());
  assert.equal(bad.state().phase, "error");
});
