import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  randomLocalHex,
  sealLocal,
  unsealLocal,
  validateLocalRequest,
  validLocalPacket,
  type LocalConnection,
  type LocalPacket,
  type LocalRequest,
  type LocalResponse,
} from "../../../shared/localLink.ts";

const HEX64 = /^[a-f0-9]{64}$/;
const HEX32 = /^[a-f0-9]{32}$/;

/** One device's link key. It is issued per handshake and persisted only once the desktop approves. */
export interface LocalDevice {
  computer: string;
  key: string;
  /** Approved peer that owns this key. */
  peerId?: string;
  /** Pending peer that claimed this key through /g2/api/pair, awaiting approval. */
  claimedBy?: string;
  /** Unapproved keys die with their pairing window. */
  expiresAt?: number;
}

export class LocalLink {
  private devices: LocalDevice[] = [];
  private readonly file: string;
  private active = 0;
  private receipts = new Map<
    string,
    { hash: string; until: number; result: Promise<LocalPacket> }
  >();
  constructor(userDataPath: string) {
    this.file = join(userDataPath, "even-g2-local.json");
  }
  async load(): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    // The previous format held one install-wide key that every paired device shared. It is dropped,
    // not migrated: LAN devices pair again and receive their own key.
    const devices = (value as { version?: unknown; devices?: unknown })?.version === 2
      ? (value as { devices: unknown }).devices
      : [];
    if (!Array.isArray(devices)) throw new Error("invalid-local-identity");
    this.devices = devices.slice(0, 8).map((device) => {
      if (!HEX64.test(device?.computer) || !HEX64.test(device?.key) || !HEX32.test(device?.peerId))
        throw new Error("invalid-local-identity");
      return { computer: device.computer, key: device.key, peerId: device.peerId };
    });
  }
  /** A fresh key for one pairing handshake. It opens nothing but pairing until the desktop approves. */
  issue(origins: string[], expiresAt: number): LocalConnection {
    const device = { computer: randomLocalHex(), key: randomLocalHex(), expiresAt };
    this.devices.push(device);
    return { version: 1, computer: device.computer, key: device.key, origins };
  }
  claim(computer: string, peerId: string): void {
    const device = this.devices.find((d) => d.computer === computer && !d.peerId);
    if (device) device.claimedBy = peerId;
  }
  async approve(peerId: string): Promise<void> {
    const device = this.devices.find((d) => d.claimedBy === peerId && !d.peerId);
    if (!device) return;
    device.peerId = peerId;
    delete device.claimedBy;
    delete device.expiresAt;
    await this.save();
  }
  /** Ends a pairing window: every key that the desktop did not approve stops working. */
  discardUnbound(): void {
    this.devices = this.devices.filter((d) => d.peerId);
  }
  async revoke(peerId: string): Promise<void> {
    if (!HEX32.test(peerId)) return;
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.peerId !== peerId && d.claimedBy !== peerId);
    if (this.devices.length !== before) await this.save();
  }
  async receive(
    packet: LocalPacket,
    forward: (request: LocalRequest, device: Readonly<LocalDevice>) => Promise<LocalResponse>,
  ): Promise<LocalPacket> {
    if (!validLocalPacket(packet)) throw new Error("invalid-local-packet");
    const now = Date.now();
    const hash = createHash("sha256")
      .update(JSON.stringify(packet))
      .digest("hex");
    for (const [id, receipt] of this.receipts)
      if (receipt.until < now) this.receipts.delete(id);
    const old = this.receipts.get(packet.id);
    if (old) {
      if (old.hash !== hash) throw new Error("packet-id-conflict");
      return old.result;
    }
    if (this.active >= 8 || this.receipts.size >= 2048)
      throw new Error("local-link-busy");
    this.active++;
    const result = (async () => {
      const { device, request } = await this.open(packet, now);
      const connection: LocalConnection = { version: 1, computer: device.computer, key: device.key, origins: [] };
      let response: LocalResponse;
      try {
        validateLocalRequest(request);
        response = await forward(request, device);
      } catch {
        response = { status: 409, body: { error: "request-failed" } };
      }
      return sealLocal(connection, response, "response", packet.id);
    })()
      .catch((error) => {
        this.receipts.delete(packet.id);
        throw error;
      })
      .finally(() => {
        this.active--;
      });
    this.receipts.set(packet.id, { hash, until: now + 120_000, result });
    return result;
  }
  /** AES-GCM authentication picks the key: at most eight approved devices plus one pairing window. */
  private async open(packet: LocalPacket, now: number): Promise<{ device: LocalDevice; request: LocalRequest }> {
    this.devices = this.devices.filter((d) => d.peerId || (d.expiresAt ?? 0) > now);
    for (const device of this.devices) {
      try {
        const request = await unsealLocal<LocalRequest>(
          { version: 1, computer: device.computer, key: device.key, origins: [] },
          packet,
          "request",
        );
        return { device, request };
      } catch {
        // Not this device's key.
      }
    }
    throw new Error("invalid-local-packet");
  }
  private async save(): Promise<void> {
    const devices = this.devices
      .filter((d) => d.peerId)
      .map(({ computer, key, peerId }) => ({ computer, key, peerId }));
    await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomLocalHex(8) + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify({ version: 2, devices }), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
