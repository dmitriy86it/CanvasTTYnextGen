// Shared setup for the reviewer-ui Electron reproductions: a temporary Git project, fake Codex/Claude CLIs, a temporary
// userData, HOME and SHELL, and the application launched without any Chromium switch (no switch that keeps a hidden
// window painted or its timers unthrottled). Nothing is written into the repository: artifacts go to --out (default: a
// temporary directory).
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, NODE, launch, q, sleep, workspace } from "../../../../../../scripts/orchestration-app-kit.mjs";

export { q, sleep };

export function outDir(prefix) {
  const i = process.argv.indexOf("--out");
  const dir = i > 0 ? path.resolve(process.argv[i + 1]) : fs.mkdtempSync(`/tmp/${prefix}-out-`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function setup(prefix) {
  const { D, project, script } = workspace(`${prefix}-`);
  const projectA = project("alpha");
  const projectB = project("beta");
  const codexScript = script("codex", [{ report: { stages: [{ title: "Заметка", task: "Add src/note.mjs" }], question: null } }]);
  const claudeScript = script("claude", [{ report: { summary: "done", done: true } }]);
  fs.mkdirSync(D("mock-state", ".codex"), { recursive: true });
  fs.mkdirSync(D("home"), { recursive: true });
  const ledger = D("ledger.jsonl");
  const wrap = (p) => {
    const f = D(`${p}-mock`);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${NODE}" "${path.join(FIXTURES, `mock-${p}.mjs`)}" "$@"\n`, { mode: 0o755 });
    return f;
  };
  const SHELL = D("login-shell");
  fs.writeFileSync(SHELL, `#!/bin/sh\n[ "$1" = "-ilc" ] && shift\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  const PATHS = `${path.dirname(NODE)}:/usr/bin:/bin`;
  const env = (extra) => ({ HOME: D("mock-state"), MOCK_STATE: D("mock-state"), MOCK_LEDGER: ledger, ...extra });
  const providers = D("providers.json");
  fs.writeFileSync(providers, JSON.stringify({
    codex: { executable: wrap("codex"), version: "codex-cli 0.155.1", path: PATHS, env: env({ MOCK_SCRIPT: codexScript, CODEX_HOME: D("mock-state", ".codex") }) },
    claude: { executable: wrap("claude"), version: "2.1.281 (Claude Code)", path: PATHS, env: env({ MOCK_SCRIPT: claudeScript }) },
    shell: SHELL, checkEnv: { PATH: PATHS, HOME: D("mock-state") }
  }));
  const userData = D("user-data");
  return { D, projectA, projectB, providers, userData };
}

// The application with helpers used by every reproduction.
export async function start({ userData, providers, port, shots, D }) {
  const app = await launch({ userData, providers, port, shots, env: { HOME: D("home"), SHELL: "/bin/sh" } });
  const h = {
    app,
    api: (expr) => app.ev(`(async () => { const o = window.canvasTTY.orchestration; const w = window.canvasTTY.workspaces; const r = await (${expr}); if (r && r.ok === false) throw new Error(r.code + " " + r.message); return r && "ok" in r ? r.value : r; })()`),
    size: (width, height) => app.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }),
    async ready() {
      await app.waitFor("document.querySelector('.workspace') && document.querySelector('[data-workspace-bar]') && window.canvasTTY?.orchestration && true", "canvas");
      await sleep(800);
    },
    async reload() { await app.call("Page.reload", {}); await sleep(500); await h.ready(); },
    tab: (id) => q(`[data-workspace-tab="${id}"]`),
    state: () => h.api("w.get()"),
    stored: async (id) => (await h.state()).workspaces.find((w) => w.id === id).camera,
    cameraNow: () => app.ev(`(() => { const m = ${q(".workspace__scene")}.style.transform.match(/translate\\(([-\\d.]+)px, ([-\\d.]+)px\\) scale\\(([\\d.]+)\\)/); return { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) }; })()`),
    async switchTo(id) {
      await app.clickEl(h.tab(id));
      await app.waitFor(`${h.tab(id)}?.getAttribute("aria-selected") === "true"`, `workspace ${id} active`);
      await sleep(300);
    },
    // ⌘digit as the user presses it (Input events)
    async chord(digit) {
      await app.call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: String(digit), code: `Digit${digit}`, windowsVirtualKeyCode: 48 + digit, modifiers: 4 });
      await app.call("Input.dispatchKeyEvent", { type: "keyUp", key: String(digit), code: `Digit${digit}`, windowsVirtualKeyCode: 48 + digit, modifiers: 4 });
    },
    // the element really hit at (x, y) is inside `selector`
    hits: (selector, x, y) => app.ev(`(() => { const el = ${selector}; const h = document.elementFromPoint(${x}, ${y}); return !!el && !!h && el.contains(h); })()`)
  };
  return h;
}

export const near = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.zoom - b.zoom) < 1e-6;
