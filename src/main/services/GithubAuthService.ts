import { randomUUID } from "node:crypto";
import * as electron from "electron";
import { copyFile, constants as fsConstants, readFile, readdir, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

/** GitHub OAuth Device Flow for the plugin showcase. */

export interface GithubAuthStatus {
  configured: boolean;
  authorized: boolean;
  login: string | null;
  tokenExpiresAt: number | null;
  /** A saved session exists but cannot be read now (keychain unavailable or another key); its file is kept. */
  storedSessionUnavailable: boolean;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  login: string;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

type GithubFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubAuthServiceOptions {
  fetcher?: GithubFetcher;
  safeStorage?: SafeStorageLike;
  now?: () => number;
  delay?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  pollTimeoutMs?: number;
}

declare const __CANVASTTY_GITHUB_OAUTH_CLIENT_ID__: string | undefined;

const AUTH_STORE_FILE = "github-oauth.json";
// A saved session this build could not read, copied aside byte for byte before a new sign-in replaces it. Read again
// when the main file cannot be read or is missing (the keychain came back); removed only by an explicit sign-out.
// Name: `${KEPT_PREFIX}-<ms since epoch>-<random>.json`.
const KEPT_PREFIX = "github-oauth.previous";
const DEVICE_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Public OAuth app identifier baked into official builds by electron-vite. */
const DEFAULT_OAUTH_CLIENT_ID = typeof __CANVASTTY_GITHUB_OAUTH_CLIENT_ID__ === "string"
  ? __CANVASTTY_GITHUB_OAUTH_CLIENT_ID__
  : "";

export class GithubAuthService {
  private readonly storePath: string;
  private tokens: StoredTokens | null = null;
  private readonly clientId: string;
  private refreshPromise: Promise<string | null> | null = null;
  private readonly fetcher: GithubFetcher;
  private readonly secureStorage: SafeStorageLike | null;
  private readonly now: () => number;
  private readonly wait: (durationMs: number, signal: AbortSignal) => Promise<void>;
  private readonly requestTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private generation = 0;
  private deviceFlow: { generation: number; controller: AbortController } | null = null;
  private storeWrite = Promise.resolve();
  private storedSessionUnavailable = false;

  constructor(userDataPath: string, clientId?: string, options: GithubAuthServiceOptions = {}) {
    this.storePath = join(userDataPath, AUTH_STORE_FILE);
    this.clientId = clientId !== undefined
      ? clientId.trim()
      : process.env.GITHUB_OAUTH_CLIENT_ID?.trim()
        || process.env.CANVASTTY_GITHUB_CLIENT_ID?.trim()
        || DEFAULT_OAUTH_CLIENT_ID.trim();
    this.fetcher = options.fetcher ?? globalThis.fetch;
    this.secureStorage = options.safeStorage ?? electron.safeStorage ?? null;
    this.now = options.now ?? Date.now;
    this.wait = options.delay ?? abortableDelay;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.pollTimeoutMs = options.pollTimeoutMs ?? DEVICE_POLL_TIMEOUT_MS;
  }

  get clientConfigured(): boolean {
    return this.clientId.length > 0;
  }

  // The main file first, then the kept copies, newest first. A file that exists but cannot be read makes the saved
  // session "unavailable", never "absent"; "absent" means no saved file at all. Nothing is removed or rewritten here.
  async load(): Promise<void> {
    const main = await this.readStored(this.storePath);
    if (main !== "missing" && main !== "unreadable") {
      this.tokens = main;
      this.storedSessionUnavailable = false;
      return;
    }
    let unreadable = main === "unreadable";
    for (const path of await this.keptPaths()) {
      const kept = await this.readStored(path);
      if (kept !== "missing" && kept !== "unreadable") {
        this.tokens = kept;
        this.storedSessionUnavailable = false;
        return;
      }
      if (kept === "unreadable") unreadable = true;
    }
    this.storedSessionUnavailable = unreadable;
  }

  private async readStored(path: string): Promise<StoredTokens | "missing" | "unreadable"> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return "missing";
      console.warn("CanvasTTY GitHub OAuth session could not be read.", error);
      return "unreadable";
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || typeof parsed.data !== "string") return "unreadable";
      if (!this.secureStorage?.isEncryptionAvailable()) {
        console.warn("CanvasTTY GitHub OAuth: OS keychain unavailable; the saved session is kept unread.");
        return "unreadable";
      }
      const tokens: unknown = JSON.parse(this.secureStorage.decryptString(Buffer.from(parsed.data, "base64")));
      if (!isRecord(tokens)) return "unreadable";
      const accessToken = typeof tokens.accessToken === "string" ? tokens.accessToken : null;
      const refreshToken = typeof tokens.refreshToken === "string" ? tokens.refreshToken : null;
      const expiresAt = typeof tokens.expiresAt === "number" && Number.isFinite(tokens.expiresAt)
        ? tokens.expiresAt
        : null;
      const login = typeof tokens.login === "string" ? tokens.login : null;
      if (!accessToken || !login) return "unreadable";
      return { accessToken, refreshToken, expiresAt, login };
    } catch (error) {
      console.warn("CanvasTTY GitHub OAuth session could not be decrypted; the file is kept.", error);
      return "unreadable";
    }
  }

  // Newest first by the time in the name, then by name; a name without a time sorts last. readdir order is not used.
  private async keptPaths(): Promise<string[]> {
    const dir = dirname(this.storePath);
    const names = await readdir(dir).catch(() => [] as string[]);
    const time = (name: string): number => {
      const match = /^-(\d+)-/.exec(name.slice(KEPT_PREFIX.length));
      return match ? Number(match[1]) : -1;
    };
    return names
      .filter((name) => name.startsWith(KEPT_PREFIX) && name.endsWith(".json"))
      .sort((a, b) => time(b) - time(a) || (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => join(dir, name));
  }

  async getToken(): Promise<string | null> {
    const current = this.tokens;
    if (!current) return null;
    if (current.expiresAt === null || this.now() < current.expiresAt - 60_000) return current.accessToken;
    if (!current.refreshToken) return null;
    if (!this.refreshPromise) {
      const generation = this.generation;
      const refresh = this.refreshAccessToken(current, generation);
      this.refreshPromise = refresh;
      void refresh.finally(() => {
        if (this.refreshPromise === refresh) this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async status(): Promise<GithubAuthStatus> {
    if (!this.tokens) {
      return {
        configured: this.clientConfigured, authorized: false, login: null, tokenExpiresAt: null,
        storedSessionUnavailable: this.storedSessionUnavailable
      };
    }
    return {
      configured: this.clientConfigured,
      authorized: true,
      login: this.tokens.login,
      tokenExpiresAt: this.tokens.expiresAt,
      storedSessionUnavailable: false
    };
  }

  async startDeviceFlow(): Promise<{
    userCode: string;
    verificationUri: string;
    interval: number;
    expiresAt: number;
  }> {
    if (!this.clientConfigured) {
      throw new Error("GitHub OAuth is not configured (missing client id).");
    }

    this.cancelDeviceFlow();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.deviceFlow = { generation, controller };

    try {
      const body = new URLSearchParams({ client_id: this.clientId });
      const response = await this.request("https://github.com/login/device/code", {
        method: "POST",
        headers: oauthHeaders(),
        body: body.toString()
      }, controller.signal);
      if (!response.ok) throw new Error(`GitHub device flow failed with HTTP ${response.status}.`);
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.device_code !== "string" || typeof payload.user_code !== "string") {
        throw new Error("GitHub device flow returned an invalid response.");
      }
      if (!this.isCurrentFlow(generation, controller.signal)) throw abortedError();

      const deviceCode = payload.device_code;
      const userCode = payload.user_code;
      const verificationUri = githubVerificationUri(payload.verification_uri);
      const interval = typeof payload.interval === "number" && payload.interval > 0 ? payload.interval : 5;
      const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0
        ? payload.expires_in
        : this.pollTimeoutMs / 1000;
      const flowLifetimeMs = Math.min(expiresIn * 1000, this.pollTimeoutMs);

      void this.pollDeviceCode(deviceCode, interval, flowLifetimeMs, generation, controller.signal)
        .catch((error) => {
          if (!isAbortError(error)) console.warn("CanvasTTY GitHub OAuth device poll failed.", error);
        })
        .finally(() => {
          if (this.deviceFlow?.generation === generation) this.deviceFlow = null;
        });

      return { userCode, verificationUri, interval, expiresAt: this.now() + flowLifetimeMs };
    } catch (error) {
      if (this.deviceFlow?.generation === generation) this.deviceFlow = null;
      throw error;
    }
  }

  async signOut(): Promise<void> {
    this.generation += 1;
    this.cancelDeviceFlow();
    this.tokens = null;
    this.refreshPromise = null;
    this.storedSessionUnavailable = false;
    // The person's explicit sign-out removes every saved session of this device, the kept ones too.
    await this.enqueueStoreWrite(async () => {
      await rm(this.storePath, { force: true });
      for (const path of await this.keptPaths()) await rm(path, { force: true });
      // Prepared files left by an interrupted write.
      const dir = dirname(this.storePath);
      for (const name of await readdir(dir).catch(() => [] as string[])) {
        if (name.startsWith("github-oauth") && name.endsWith(".tmp")) await rm(join(dir, name), { force: true });
      }
    });
  }

  private cancelDeviceFlow(): void {
    this.deviceFlow?.controller.abort();
    this.deviceFlow = null;
  }

  private isCurrentFlow(generation: number, signal: AbortSignal): boolean {
    return !signal.aborted && this.generation === generation && this.deviceFlow?.generation === generation;
  }

  private async pollDeviceCode(
    deviceCode: string,
    initialInterval: number,
    lifetimeMs: number,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    const started = this.now();
    let interval = initialInterval;
    while (this.now() - started < lifetimeMs) {
      await this.wait(interval * 1000, signal);
      if (!this.isCurrentFlow(generation, signal)) return;

      const body = new URLSearchParams({
        client_id: this.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      });
      const response = await this.request("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: oauthHeaders(),
        body: body.toString()
      }, signal);
      if (!response.ok) continue;
      const payload: unknown = await response.json();
      if (!isRecord(payload)) continue;
      if (payload.error === "authorization_pending" || payload.error === "slow_down") {
        if (payload.error === "slow_down") interval += 5;
        continue;
      }
      if (payload.error === "access_denied" || payload.error === "expired_token") return;
      if (typeof payload.access_token === "string") {
        const login = await this.fetchLogin(payload.access_token, signal);
        if (!login || !this.isCurrentFlow(generation, signal)) return;
        const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0
          ? payload.expires_in
          : null;
        const next: StoredTokens = {
          accessToken: payload.access_token,
          refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
          expiresAt: expiresIn === null ? null : this.now() + expiresIn * 1000,
          login
        };
        this.tokens = next;
        await this.persist(next, generation);
        return;
      }
      return;
    }
  }

  private async refreshAccessToken(expected: StoredTokens, generation: number): Promise<string | null> {
    if (!expected.refreshToken) return null;
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: expected.refreshToken
    });
    try {
      const response = await this.request("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: oauthHeaders(),
        body: body.toString()
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (!isRecord(payload) || typeof payload.access_token !== "string") return null;
      if (this.generation !== generation || this.tokens !== expected) return null;
      const accessToken = payload.access_token;
      const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : expected.refreshToken;
      const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : null;
      const next: StoredTokens = {
        ...expected,
        accessToken,
        refreshToken,
        expiresAt: expiresIn === null ? null : this.now() + expiresIn * 1000
      };
      this.tokens = next;
      await this.persist(next, generation);
      return this.generation === generation && this.tokens === next ? accessToken : null;
    } catch {
      return null;
    }
  }

  private async fetchLogin(accessToken: string, signal: AbortSignal): Promise<string | null> {
    try {
      const response = await this.request("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/vnd.github+json",
          "user-agent": "CanvasTTY plugin showcase"
        }
      }, signal);
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      return isRecord(payload) && typeof payload.login === "string" ? payload.login : null;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  private async request(input: string, init: RequestInit, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref();
    try {
      return await this.fetcher(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    }
  }

  private async keepCopy(): Promise<void> {
    const bytes = await readFile(this.storePath);
    for (const path of await this.keptPaths()) {
      if (bytes.equals(await readFile(path).catch(() => Buffer.alloc(0)))) return;
    }
    const kept = join(dirname(this.storePath), `${KEPT_PREFIX}-${this.now()}-${randomUUID().slice(0, 8)}.json`);
    const partial = `${kept}.${randomUUID()}.tmp`;
    try {
      await copyFile(this.storePath, partial, fsConstants.COPYFILE_EXCL);
      await rename(partial, kept);
    } finally {
      await rm(partial, { force: true });
    }
  }

  private async persist(tokens: StoredTokens, generation: number): Promise<void> {
    await this.enqueueStoreWrite(async () => {
      if (this.generation !== generation || this.tokens !== tokens) return;
      try {
        await mkdir(dirname(this.storePath), { recursive: true });
        if (!this.secureStorage?.isEncryptionAvailable()) {
          console.warn("CanvasTTY GitHub OAuth: OS keychain unavailable; session not persisted.");
          return;
        }
        // A saved session this build cannot read is copied aside unchanged first. The main file itself is never moved:
        // it is replaced only by the rename of a fully written new file below, so a failed encryption or write, or an
        // interruption between the steps, leaves either the old bytes or the new file in place, and the copy.
        if (await this.readStored(this.storePath) === "unreadable") await this.keepCopy();
        const encrypted = this.secureStorage.encryptString(JSON.stringify(tokens));
        const temporaryPath = `${this.storePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, JSON.stringify({ data: encrypted.toString("base64") }), { mode: 0o600 });
          if (this.generation === generation && this.tokens === tokens) {
            await rename(temporaryPath, this.storePath);
          }
        } finally {
          await rm(temporaryPath, { force: true });
        }
      } catch (error) {
        console.warn("CanvasTTY GitHub OAuth session could not be persisted.", error);
      }
    });
  }

  private enqueueStoreWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.storeWrite.catch(() => undefined).then(operation);
    this.storeWrite = next;
    return next;
  }
}

function oauthHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    "user-agent": "CanvasTTY plugin showcase"
  };
}

function githubVerificationUri(value: unknown): string {
  if (typeof value !== "string") return "https://github.com/login/device";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname === "/login/device"
      ? url.toString()
      : "https://github.com/login/device";
  } catch {
    return "https://github.com/login/device";
  }
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(abortedError());
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortedError(): DOMException {
  return new DOMException("GitHub OAuth operation was cancelled.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}
