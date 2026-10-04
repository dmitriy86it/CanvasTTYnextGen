# Architecture

[English](ARCHITECTURE.md) · [Русский](ARCHITECTURE.ru.md)

## Process boundaries

Raoden Loom follows Electron's three-layer model:

```text
React renderer
    │ typed window.canvasTTY API
    ▼
preload bridge (contextBridge)
    │ allow-listed IPC channels
    ▼
Electron main process
    ├── SettingsStore  → validated, atomic JSON persistence
    ├── TerminalSessionStore → opt-in, atomic terminal-window descriptors
    ├── TerminalManager → node-pty lifecycle, bounded scrollback, and output batching
    ├── LimitsService  → sanitized provider-limit adapters and cache
    ├── PluginManager  → GitHub install, manifest validation, assets, permissions, storage, hook trust registry
    ├── PluginSecretsService → OS-backed encrypted plugin credentials with fail-closed availability
    ├── PluginMediaService → user-granted music folders, ranged audio streams, playlist files
    ├── HermesHudService → permission-gated Hermes Desktop HUD lifecycle through a fixed control contract
    ├── BrowserService → tabs, shared persistent profile, downloads, presence, WebContentsView lifecycle
    │   ├── BrowserStore / BrowserPolicyService / BrowserAuditStore
    │   ├── BrowserCore / BrowserCommandDispatcher / BrowserAutomationService
    │   └── AgentGateway → authenticated UDS/named pipe for the bundled stdio MCP helper
    ├── RunManager     → agent orchestration runs, cards and links (see Agent orchestration)
    ├── canvastty-plugin:// → CSP-constrained static plugin resources
    ├── canvastty-media:// → permission-checked local audio streams
    └── native dialogs/window controls
```

- `src/shared/contracts.ts` is the single public contract between processes. Add or change cross-process data here first.
- `src/preload/index.ts` exposes only the typed capabilities the renderer needs. Node integration stays disabled; context isolation and sandbox stay enabled.
- Terminal file drops resolve native `File` objects through preload's `webUtils.getPathForFile`, format paths for the host's default shell, and paste through xterm without submitting. File contents are not read and no new main-process IPC is exposed.
- `src/main/ipc/registerIpc.ts` owns native side effects and validates access to persisted media.
- `src/main/services/TerminalManager.ts` is the source of truth for live session state and PTY buffers. It keeps scrollback in a bounded chunk buffer and coalesces PTY data into 16ms IPC batches so clear/redraw sequences reach xterm together. A plain terminal starts `idle`; an agent stays `unavailable` until its provider emits a machine-readable lifecycle signal. Codex, Claude Code, Qwen Code, Kimi Code, OpenCode, Hermes, and Grok Build then transition through `idle`, `working`, and `needs_approval` from provider hooks; exact Claude/Qwen OSC 0/2 markers remain a compatibility fallback. Human-readable terminal text and PTY existence are never treated as activity. Process exit provides only `done` or `failed`. An exited PTY may be restarted under the same session ID while preserving its card, bounds, title, and scrollback. Optional restart persistence writes only provider/profile/title/cwd/bounds descriptors through `TerminalSessionStore`; it never writes PTY scrollback, child environment, or capabilities. Restored agents use each provider's native project-scoped continue mode, while plain terminals reopen as fresh shells in their saved folder.
- `src/main/services/LimitsService.ts` reads Codex through the installed CLI's app-server protocol and Claude, Kimi, OpenCode Go, and Grok Build through their provider usage or billing endpoints. Qwen Code is multi-provider and exposes no provider-neutral read-only quota protocol, so its adapter reports `cli-not-found` or `unsupported-protocol` and never invents percentages. Provider credentials are read only inside the trusted main process, sent only to the matching provider over HTTPS, and never logged or exposed over IPC. The service owns timeout, structural normalization, caching, stale fallback, and subprocess cleanup; raw provider responses never cross IPC.
- `src/main/services/SettingsStore.ts` normalizes every update and persists through a serialized atomic write. Canvas regions and sticky notes have independent persistence gates: disabling one keeps its live objects for the current process but omits that collection from the disk snapshot and therefore from the next launch. The configurable canvas launcher and UI scale use the same boundary; transient window stacking does not.
- `src/main/services/PluginManager.ts` installs ready-to-run repositories without executing package scripts during install/update, rejects symlinks and oversized packages, persists the enabled registry, serves only contained package files, and enforces per-plugin permissions/storage quotas. Optional native agent-hook entries remain off by default; explicit per-hook trust is persisted in the plugin registry and compiled into a separate private atomic runtime registry. Update, module replacement, plugin disable, and uninstall revoke that trust before executable files change.
- `src/main/services/PluginSecretsService.ts` serializes per-plugin secret writes, encrypts the complete bounded payload through Electron `safeStorage`, rejects plaintext-only backends, and removes each encrypted file on uninstall.
- `src/main/services/PluginMediaService.ts` persists per-plugin grants only after a native folder choice, hides absolute paths, skips symlinks, and serves contained audio with HTTP Range semantics. Playlist reads stay inside granted libraries; writes are bounded and atomic under the library's `Playlists/` directory.
- `src/main/services/HermesHudService.ts` is the only plugin-facing native application controller. It resolves the installed Hermes CLI through the immutable provider registry, sends only the fixed `--hud`/`--quit` control commands, and derives visible state from Hermes Desktop's validated live runtime record. It never accepts executable paths, arguments, PIDs, or arbitrary commands from plugin code.
- `src/main/services/BrowserService.ts` is the only owner of the built-in browser's `WebContentsView` tabs and shared persistent partition. Remote pages have no preload or Node access, keep context isolation and sandbox enabled, and cannot request hardware, location, notification, clipboard-read, certificate-bypass, or external-protocol capabilities. HTTP(S) popups are adopted as internal tabs; other schemes are rejected.
- `src/main/services/browser/` contains the browser kernel. `BrowserStore` atomically persists only tab order, active tab, and safe restore URLs. `BrowserPolicyService` centralizes URL, permission, download, and upload rules; validated uploads are copied through an already-open no-follow file descriptor into private staging before Chromium sees them. `BrowserAutomationService` attaches Electron's internal debugger to the existing live tab without a remote-debugging port. `BrowserCommandDispatcher` adds revisions, revision-bound refs, mutation request deduplication, per-tab FIFO mutation lanes, bounded concurrency, typed errors, and redacted fail-closed audit for agent mutations.
- `src/main/services/agent-browser/` exposes the kernel only through an authenticated user-local Unix socket (`0600`) or Windows named pipe. The Windows pipe is created by the bundled native host with a protected DACL containing only the exact current-user SID and rejects remote clients. Each agent PTY receives a one-use bootstrap capability through its child environment. A successful authentication rotates it to a session-scoped reconnect capability held only in helper memory; duplicate bootstrap authentication is accepted only while the same `connectionId` is already live, and every capability is revoked when the PTY ends. The bundled stdio MCP helper is the only protocol adapter; no TCP listener, cookie/storage endpoint, arbitrary evaluation tool, or raw CDP surface exists.
- `src/main/services/agent-runtime/` is a separate lifecycle boundary and is not controlled by the Browser access switch. When Raoden Loom status hooks are enabled, every agent PTY receives a distinct capability for a protected user-local socket/pipe. Provider command hooks and the OpenCode event plugin may report only the fixed status enum, bounded event name, and optional opaque turn/prompt ID; prompt text, responses, tool input, and arbitrary telemetry are rejected by the exact gateway schema. Electron helper commands carry `ELECTRON_RUN_AS_NODE=1` inside the exact hook command only; the provider PTY never inherits that process-mode flag, so a provider cannot accidentally launch a second Raoden Loom GUI instance. The user can revoke this capability from Agents settings, immediately returning live agent status to `unavailable`; re-enabling requires a new/restarted PTY. Explicitly trusted plugin hooks use a separate process runner which re-checks the private PluginManager registry on every invocation and strips Raoden Loom internal capabilities before passing the provider payload to third-party code. Provider-native review remains an independent gate; Raoden Loom does not bypass Codex hook trust globally.
- Lifecycle adapters use launch-only settings for Claude, Codex, Qwen, and OpenCode. Kimi, Hermes, and Grok, whose hook discovery is home-config based, receive ownership-checked temporary entries shared across live Raoden Loom sessions. Kimi and Hermes keep recovery journals and exact backups; Grok uses a dedicated owned hook file. Cleanup restores exact original bytes when no concurrent edit occurred and otherwise removes only Raoden Loom-owned entries.
- `TerminalManager` injects the MCP helper per launch without leaving permanent provider configuration. Claude Code, Codex, and Qwen Code receive CLI arguments; Qwen gets one inline `--mcp-config` entry that overrides only the Raoden Loom server name and leaves unrelated user servers available. OpenCode receives a merged launch-only `OPENCODE_CONFIG_CONTENT` entry plus one scoped browser-tool permission; Kimi uses its per-run MCP configuration when supported. Older Kimi versions receive a compare-and-swap temporary Raoden Loom entry and one exact permission rule with an atomic recovery journal. Hermes receives a temporary `mcp_servers.canvastty_browser` entry in `HERMES_HOME/config.yaml` (defaulting to `~/.hermes/config.yaml` on POSIX or `%LOCALAPPDATA%\hermes\config.yaml` on Windows); sensitive capability values stay as child-environment placeholders. Temporary Kimi and Hermes configuration remains until the final owning PTY session ends, then exact original bytes are restored when safe. A journal repairs an interrupted Hermes launch at the next Raoden Loom startup, while compare-and-swap checks preserve concurrent user edits. Unrelated MCP entries, credentials, and file/shell permissions are preserved. Qwen, OpenCode, and Hermes YOLO remain launch-only and do not change persistent permission settings.
- `src/main/services/providerCliRegistry.ts` is the single owner of provider CLI discovery. During main-process startup it creates one immutable snapshot for Codex, Claude, Qwen Code, Kimi, OpenCode, Hermes, and Grok Build by checking smoke-only overrides, the inherited `PATH`, platform defaults, and known per-user/provider directories in that order. Available entries retain an absolute executable, launcher kind, and supplemented child `PATH`; POSIX entries must be executable files and Windows entries must be supported native or batch launchers. `TerminalManager`, `LimitsService`, agent-browser probes, and provider smoke tests consume that same snapshot and never repeat command lookup. Missing entries produce a failed session with copyable checked-path diagnostics before PTY or temporary browser configuration creation, and the matching HOME limit stays `cli-not-found`. Raoden Loom never reads shell startup scripts, and installing or moving a CLI requires restarting the app.

The primary `BrowserWindow` is created and shown with a lightweight local startup page before settings, plugins, media, and IPC services initialize. Successful initialization replaces that page with the trusted renderer; bootstrap failures replace it with a visible error page and retain a native-dialog fallback. The main process holds Electron's single-instance lock; a rejected second launch raises the running window through the `second-instance` handler so the app never appears to ignore a launch, while background plugin and browser requests never restore, show, or focus an existing window. Native browser contents are focused programmatically only while their owner `BrowserWindow` is already focused; explicit user pointer input remains the only cross-surface focus route.

Runtime plugin code is never imported into main or the trusted renderer bundle. HOME widgets and canvas apps run in sandboxed iframes with an opaque origin. Separate plugin windows use a dedicated narrow preload which forwards the same message SDK through an IPC handler that verifies the actual `canvastty-plugin://<id>/<entry>` sender URL. Explicitly trusted agent hooks run only in isolated child processes, not in either trusted JavaScript context; they are privileged OS code rather than sandboxed web contributions. Arbitrary native OS windows are not embedded.

Plugin music access is capability-based rather than generic filesystem access. Media scans return library IDs, relative paths, metadata, and `canvastty-media://` stream URLs; raw playlist text remains the only format-neutral file content exposed. A media URL is resolved only for the owning enabled plugin and only beneath a previously selected library root. Removing a plugin revokes its persisted folder grants.

The built-in browser is split across surfaces: `BrowserCard` renders trusted window chrome, tabs, navigation, agent badges, downloads, dialogs, and canvas geometry, while `BrowserService` positions the active native view over the measured viewport. The native view remains live while the card or camera moves and receives frame-coalesced geometry updates; it is hidden during semantic summary, HOME editing, trusted modal surfaces, or while a higher canvas layer overlaps its card, so native content cannot break the renderer-owned window stack. Fractional renderer bounds expand to enclosing device-independent pixels, and the active tab view is reparented only when the active tab actually changes. A typed pointer bridge reports native-page click and hover activity back to canvas selection and explicitly restores native page focus without preventing page input. A transparent trusted mouse-passthrough window draws optional live agent cursors above the native view; Wayland uses an isolated-world fallback. A connection or heartbeat alone never creates presence: badges appear only after an actual browser command, and cursors appear only after a real pointer position exists.

Renderer IPC and the agent gateway call the same `BrowserCore.execute(actor, command, signal)` boundary. Reads may run concurrently. Mutations are ordered FIFO per tab while different tabs remain independent; a repeated mutation request ID returns the recorded result. Navigation and document changes advance the revision, so stale accessibility refs fail before side effects. Agent activity is recorded as a redacted append-only hash chain: typed/page text, screenshots, URL query/fragment, credentials, headers, cookies, and tokens are not stored.

## Renderer boundaries

`App.tsx` is the orchestration boundary. It loads settings/sessions, subscribes to main-process events, and coordinates dialogs and persistence. Feature components do not call unrelated feature APIs.

```text
App
├── WorkspaceCanvas        camera, pan, zoom, spatial composition, context dispatch, and stacking
│   ├── HomeZone           persisted resizable grid, visible boundary, and edit gestures
│   │   ├── homeModel      pure derivation of limit/active-session rows
│   │   └── HomeMediaWidget independent pick/replace/remove control
│   ├── TerminalCard       one live xterm view, selection, rename, drag, resize, and snap behavior
│   ├── CanvasRegion       persisted named color field, drag/resize, and spatial window grouping
│   ├── StickyNoteCard     persisted text/bounds with drag, eight-way resize, and deferred text writes
│   ├── CanvasContextMenu  target-specific empty-canvas, region, and note commands
│   ├── CanvasCommandPalette searchable sessions and the same global creation/launch actions
│   ├── PluginCanvasCard   sandboxed plugin app with canvas bounds and semantic summary
│   ├── BrowserCard        trusted browser chrome and canvas geometry for the native WebContentsView
│   └── CanvasMinimap      viewport/entity overview, camera recentering, and canvas-direction drag panning
├── AgentLaunchDialog      fixed provider + folder + profile + launch
└── SettingsPanel          two-pane icon-sidebar modal for General, Appearance, Agents, Controls, Browser, Plugins, and About
    ├── AgentHooksSettings built-in status revocation and explicit plugin-hook trust
    ├── AboutSettings      app identity and expandable hook/data/security FAQ
    └── PluginSettingsSection install preview, permissions, registry, and contributions
```

Keep domain decisions in pure selectors such as `homeModel.ts`, orchestration in `App.tsx`, and rendering/local interaction in feature components. IPC calls belong in `App.tsx` or a feature that exclusively owns that capability.

`WorkspaceCanvas` is the sole trusted owner of canvas context-menu hit testing. It leaves terminal, Browser, plugin, and editable-text context menus native. It also owns one deterministic layer order for terminal, plugin, Browser, and note cards: every ordinary primary-pointer activation raises the hit card independently of camera-focus settings. Browser native-pointer callbacks enter the same path.

## Session flow

When terminal restore is enabled, startup loads validated window descriptors before the renderer and relaunches each saved agent through its provider's native continue mode. Stable Raoden Loom session IDs preserve card identity, while region membership remains spatial and requires the complete card bounds to be inside the region at region-drag start. Grok restoration still waits for the renderer-measured xterm grid before spawning. Turning restore off clears the descriptor store immediately; it remains off by default.

1. Home requests a terminal or opens a provider-specific launch card.
2. `App` sends a typed `terminal:create` request.
3. `TerminalManager` validates the request, spawns the PTY, stores metadata and bounded chunked scrollback, then emits lifecycle events and 16ms-batched data events. Grok is the measured-grid exception: its card is created first and the PTY starts only after xterm reports the actual rows and columns.
4. `App` reconciles lifecycle snapshots by session ID and a main-owned monotonic metadata revision, so a delayed IPC response cannot overwrite a newer hook state.
5. `TerminalCard` subscribes to its PTY stream, sends PTY input/grid resize events, and commits typed canvas bounds after a drag or edge resize.

`SessionMetadata` owns both world-space position and card size. `App` reconciles those bounds, while `TerminalCard` may hold transient pointer-move geometry until pointer-up. The main process validates and clamps committed sizes before emitting a session snapshot. Camera wheel handling is limited to empty canvas; interactive surfaces keep their native scroll/input ownership.

A live `TerminalCard` owns one xterm instance for the lifetime of its session ID. Palette changes update `terminal.options.theme` in place; title and settings changes must never dispose the terminal or its renderer-side scrollback. Window titles are updated as session metadata through `terminal:rename`. PTY input and resize events that race with process exit are contained at the main-process boundary and never surface as uncaught Electron errors.

Output batching is an IPC/rendering boundary, not a history boundary: every PTY chunk is appended to bounded scrollback immediately, while pending renderer output is flushed on the 16ms timer, before exit, and before disposal. Scrollback trimming advances through chunks instead of rebuilding the entire buffer for every write; snapshots join only the retained suffix.

Terminal cards subscribe before requesting a fresh `terminal:read-buffer` snapshot. The snapshot and live batches carry the cumulative UTF-16 output offset, which survives history trimming and in-place restarts. The renderer removes their overlap before writing to xterm, so delayed batches cannot duplicate replayed history and output before subscription is recovered by the snapshot.

Terminal pointer coordinates are converted from the canvas's visually transformed rectangle back to xterm layout coordinates before selection or wheel handling. Terminal and canvas wheel direction are normalized independently from persisted settings. Selected text is copied through the typed clipboard bridge with `Ctrl+C`, `Ctrl+Shift+C`, or `Cmd+C`; paste uses `Ctrl+Shift+V`, `Cmd+V`, or `Shift+Insert` and enters xterm through `Terminal.paste` rather than synthetic keystrokes. `Shift+Enter` sends the CSI-u modified Enter sequence directly to the PTY.

Application shortcuts are normalized in `SettingsStore`, matched in `App`, and rendered from the same persisted bindings in the canvas hint. `App` owns the exclusive selected canvas application and the selected terminal session used by window actions such as rename. `TerminalCard` owns xterm focus and only the inline editor; `BrowserService` owns native page focus. Pressing empty canvas clears either selection. Optional hover focus uses the same configured entry/exit delay for terminals and the built-in browser; focus-in/focus-out sequences produced by a terminal's programmatic transition are suppressed before PTY input so agent TUIs do not reset their history position.

Session counters, progress bars, and statuses must always derive from actual `SessionSnapshot` values. The UI must not synthesize telemetry.

## Provider-limit flow

1. `App` requests a sanitized `LimitsSnapshot` at bootstrap and every 60 seconds.
2. `LimitsService` deduplicates refreshes and keeps a 60-second cache.
3. Codex is queried through `codex app-server` using `account/rateLimits/read`. Claude, Kimi, OpenCode Go, and Grok Build use their read-only usage or billing endpoints with credentials already managed by each installed CLI. Qwen Code reports an explicit unavailable reason because one Qwen CLI session may use unrelated cloud or local providers and the CLI has no universal quota-read protocol. OpenCode Go contributes its real rolling, weekly, and monthly windows; Grok Build contributes its real shared billing period. Real responses are structurally validated and reduced to percentage, window, and reset time.
4. If a refresh fails after a successful read, the last valid snapshot is returned as stale. Missing or unsupported adapters return an explicit unavailable reason, never `0%`.
5. Claude usage is requested with the OAuth token from the current user's Claude CLI credentials. Missing or unreadable credentials are `not-authenticated`; Raoden Loom never infers a missing subscription from local credential state and never parses provider TUI screens.

## Agent orchestration (Codex lead → Claude executor)

Status: **the MVP is accepted for macOS with known limits** (2026-09-24). Stages 1–10 and the final real series are accepted. The real CLIs ran the cycle outside the UI (stage 6) and through the UI of the checked packaged build (real series R1–R3: goal to completion, Stop during a Claude turn, quit during a turn and Resume; `agent-orchestration/evidence/real-ui/`). The checked build is `/private/tmp/canvastty-r10-pkg-wrc5/release/mac-arm64/CanvasTTY.app` (local, ad-hoc signed, not notarized). First use: [agent-orchestration/FIRST-USE.md](agent-orchestration/FIRST-USE.md) (Russian). Acceptance, evidence and verification bounds: ROADMAP, "Приёмка MVP". Design history, decisions and every check result: [agent-orchestration/](agent-orchestration/) (ROADMAP, VALIDATION-MATRIX, TROUBLESHOOTING, stage contracts). The original design, `ARCHITECTURE-PROPOSAL.md`, lists where the implementation differs (§0).

```text
renderer features/orchestration (cards, link, goal dialog, run panel)
    │ window.canvasTTY.orchestration (preload/orchestrationClient.ts)
    ▼ orchestration:* channels via handleMain (main window top frame only, every argument checked)
main RunManager (manager.ts) — the only owner of runs; opens nothing by itself
    ├── canvasStore  → <userData>/orchestration/canvas.json (cards and links)
    └── OrchestrationService per run (state machine, limits, recovery)
        ├── Store     → runs/<runId>/journal.jsonl (hash-chained) and texts/
        ├── Workspace → runs/<runId>/workspace/ (working copy + control.git)
        ├── turns     → supervisor.mjs (ELECTRON_RUN_AS_NODE) → codex / claude CLI in its own process group
        └── checks    → supervisor.mjs inside a Seatbelt profile → node --test
```

The orchestration feature owns its IPC capability exclusively (`useOrchestration.ts`), so it does not go through `App.tsx`. Main is the source of truth for runs, cards and links. The renderer only reconciles `(seq, tick)` snapshots and events and offers the commands `availableActions()` allows.

### Starting a goal

1. Right-click empty canvas → "Codex agent (lead)" and "Claude agent (executor)", each with the same project folder.
2. Drag the lead card's port onto the executor card, or use the keyboard: Enter on the port, then "Link here". A link is Codex → Claude only, within one project; it cannot point at the same card or repeat a pair.
3. "New goal" on the link chip opens a dialog with:
   - the task and the criteria (one per line);
   - checks from the application's catalog (only `node-test`, i.e. `node --test`, 600 s, 64 KiB output);
   - optional limits: turns 40, rounds per stage 8, replans 3, run time 240 min by default;
   - "Show the plan before running" (off by default).
4. The lead splits the task into stages. For each stage the executor edits, the check runs, and the lead reviews. When a stage is accepted, a checkpoint is created. A final review ends the run as `completed`.

A link has at most one active run. "New goal" and "×" are hidden while one is active, and main refuses them as well.

### Controls

The panel shows only commands that are valid in the current state:
- "Pause after turn" / "Keep running";
- "Resume", "One step" (exactly one operation, then pause), "Stop";
- answering a question, "Clarify", raising a limit;
- recovery.

"Stop" returns at once. It stops the active turn or check; if no result arrives, the run is finished after a 20 s grace period, and no operation starts after an accepted Stop. A run the application does not hold (for example, one paused before a restart) runs nothing, so stopping it only records the stop: it needs no CLI of a verified version, no login shell and no prepared project dependencies. "Resume" and a new start still require them.

Every command carries a `commandId` and the `expectedRevision`. If the reply is lost, the panel keeps the request (also across a window reload) and offers "Repeat". Main answers a repeat with the result it recorded, so nothing is done twice.

### Recovery

- **Clean quit.** The active operation is stopped and the run becomes `paused(user_request)`.
- **Crash or forced quit.** The run is shown the way opening it will record it:
  - `paused(outcome_unknown)` if a turn was in flight. Offered: "Accept the turn's result", "Retry the turn" (a new session), reset to the last checkpoint (with a confirmation; later changes are kept in `refs/canvastty/<runId>/recovery-<k>`), or Stop.
  - `paused(recovered)` otherwise. An interrupted check becomes `not_verified(interrupted)` and runs again only after Resume or One step.
- In both cases nothing continues by itself after a restart. The supervisor ends the CLI group or the check sandbox when main dies (lifeline EOF).

There is no startup sweep for orphaned processes. If main's whole process group is killed, the supervisor dies too, and a CLI group can outlive it.

### Where results are

- **Run data** lives under `<userData>/orchestration/` (on macOS `~/Library/Application Support/<app name>/orchestration/`):
  - `canvas.json`;
  - `runs/<runId>/journal.jsonl`, `texts/`, `checks/<checkRunId>/`, `workspace/` (the working copy `repo/` and `control.git`);
  - `attempts/` (the lead's per-turn schema and report).
- **The history** (reports, the lead's findings, check output) is shown in the run panel from the journal.
- **The source repository** gains only objects and create-only refs:
  - `refs/canvastty/<runId>/baseline`: the source tree at start, including uncommitted and untracked, non-ignored files;
  - `refs/canvastty/<runId>/stage-<n>`: the checkpoint after the accepted stage n;
  - `recovery-<k>`: kept by a reset.
  
  Its HEAD, branches, index and working tree are never changed.

### Taking the changes

The application never merges into your branch. In the source repository:

```sh
git log --oneline refs/canvastty/<runId>/stage-<n>
git diff refs/canvastty/<runId>/baseline refs/canvastty/<runId>/stage-<n>   # the agents' work only
git switch -c agents/<name> refs/canvastty/<runId>/stage-<n>                 # review it on a new branch
git cherry-pick refs/canvastty/<runId>/baseline..refs/canvastty/<runId>/stage-<n>   # or apply it onto the current branch
```

Diff against `baseline`, not `HEAD`. If you had uncommitted work at start, the baseline contains it.

### Check sandbox of the lead's proposed commands (journal v2)

In journal v2 (the default since 1.5.8) a goal may leave its check commands empty: the lead proposes them, and the person accepts or edits them ([journal-v2-format.md](agent-orchestration/implementation/journal-v2-format.md) §2.6, §7а). Where Seatbelt is, a command the lead proposed runs in its own profile (`sandbox.ts` `buildCheckProfile`):

- writes: the run's work folder (the copy, the worktree or the project folder, by the work mode) and a temporary folder of the check (its `TMPDIR`), nothing else — and not the work folder's `.git` (a hook written there would run later by the person's own git);
- reads: as the project-check profile — allowed by default, the user's credential stores and the orchestration data denied;
- network: this machine only (`localhost`, any port; Unix sockets in those two folders); no outside connection, no DNS;
- network: anything listening on this machine is reachable, a local tunnel or VM included. This is an accepted residual (owner's decision): agents in "As in my terminal" mode have the same and wider reach, and the check sandbox is not stricter than the agents' own permissions;
- run as `sandbox-exec -f <profile> -- <supervisor> <shell> -c <line>` with the measured login-shell environment; the supervisor inside the sandbox kills whatever the command leaves behind before the tree is taken.

A self-test of the profile runs before every such check (a write to the work folder works; a write to `$HOME` or `.git`, a read of `~/Library/Keychains` or of the orchestration data and an outside connection fail with EPERM; 127.0.0.1 works). If it fails, the check does not run and the run pauses with `sandbox_unavailable`. Because the profile denies the outside network, the autopilot accepts the lead's commands itself. A check whose output reports a refusal (EPERM, a failed name lookup — the output, not the kernel, so the command can print it itself) is not a code failure: the run pauses with "A check needs more permissions". The lead's command is never run without the sandbox as it is: the person opens it in full ("Change the command") and saves it, changed or not, as their own command, which then runs in their shell without the sandbox; the decision is journaled (`checks.amended`) and holds for that command in that run. Commands the person entered run as before, in their login shell without a sandbox.

### Requirements and readiness conditions (journal v2)

A2 of [journal-v2-format.md](agent-orchestration/implementation/journal-v2-format.md) §2.7. The goal's acceptance criteria are the requirements R1, R2, … (set by the person, fixed). Every stage of a v2 plan lists 1–12 readiness conditions, each covering requirements and naming its evidence: `check` (a check command of the run passes) or `change` (the lead's review marks it met, naming files the run changed). The application numbers new conditions C1, C2, … (`plan.recorded.conditionsAssigned`); a new plan keeps every open one by id, and dropping one is not available before A4. `conditions.ts` holds the pure rules (plan check, numbering, marks, facts); the service validates the lead's answers before recording them (`invalid_report` otherwise) and computes the facts before every decision:

- a `check` condition is met by the latest result of its command on the tree being decided (`checkKey`) — a pass on an older tree is no evidence;
- a `change` condition, by the review the stage was accepted on; a stage is accepted only with its `change` conditions met, otherwise it goes back to the executor;
- the final review marks each requirement; completion needs every condition and requirement met (`condition_unmet`, `requirement_unmet` in `cycle.ts` `completion`), otherwise a new plan.

The completion's basis records R → C → evidence; replay re-derives the conditions from the plans' and reviews' texts (`journal.ts` `conditionsConflict`) and marks a journal that says completed without that evidence as damaged (`phase: "texts"`). The result's "Conditions" section, the agent cards and the activity feed show the same facts (`conditionsView`, `conditionsLine`).

### Findings and the reviewer (journal v2)

A3 of [journal-v2-format.md](agent-orchestration/implementation/journal-v2-format.md) §2.8. In a v2 journal the stages and the final result are reviewed by a separate role, `reviewer`: the lead's CLI (Codex) in a new session for every review, with the lead's turn limit and rights. Its task carries the requirements and conditions, the paths changed (since the stage started and since the run started), the check results on the current tree and every finding of the run — never the executor's report or task, nor the lead's conversation. The lead only plans. A journal the lead already reviewed in (A1–A2, `review.recorded`) goes on with the lead; mixing the two is a replay conflict.

The reviewer has no verdict. It reports findings — `blocking` or `wish`, with the files they are about — and a request (`none`, `replan`, `question`). The application (`findings.ts`, pure):

- numbers new findings F1, F2, … from a counter and never renumbers them; a report naming a number that does not exist, changing a finding's severity or condition, or opening a blocking one without files is `invalid_report` and is not applied;
- closes a blocking finding only on a later state than it was opened on, with the files changed for it since; a repeat of a closed finding on unchanged files is refused or disputed (the person decides — A4; until then the run waits, `awaiting_person_decision`);
- writes what it did (`applied`: opened, closed, reopened, refused, disputed, unchanged, the next number) as a text and one `review.assessed` record per review; `orch.turn.tree` keeps the tree the reviewer saw, and a review whose tree changed during it is dropped (`review.discarded`, one retry, then `tree_changed_during_review`).

A stage is accepted only with its checks passing, its conditions met and no open blocking finding it owns; the completion function adds `blocking_open` and `disputed_pending`. Replay re-applies every result from the texts and marks a journal whose stage was accepted, or run completed, with an open blocking finding as damaged (`phase: "texts"`). The result's "Findings" section (number, severity, status, owning stage, history with the review and the tree), the cards and the activity feed say "Open blocking: N" through one function (`findingsView`, `findingsLine`); the run panel lists the reviewer as its own participant, and the Codex card shows its work.

### Person decisions and the finish (journal v2)

A4 of [journal-v2-format.md](agent-orchestration/implementation/journal-v2-format.md) §2.9. Some decisions are the person's alone, and the run waits for them; neither the autopilot nor an agent makes one. Each is a command from the run panel (`person.decide`, `plan.decide`, exactly their fields: a renderer cannot say who decided). Main records it with the state the person saw: the `runKey` of the view, which must still be current (otherwise `stale_revision`), and the tree it computes itself.

- **A disputed item.** A blocking finding on the unchanged files of a closed one, with no relation said. The panel shows both side by side. "A new defect" opens it; "A repeat of F<n>" applies the reopen rule to the files changed since F<n> was closed. The run goes on by itself after the decision.
- **A finding.** On a pause the run did not choose, the person may close an open finding or make a blocking one a wish. The result says "downgraded by the person, not fixed", never fixed.
- **A condition with the person's evidence**: met or not met after its stage's review.
- **A plan proposal.** A replan that drops conditions or requirements is recorded as `plan.proposed`, and the plan in force stays. On `coverage_lost` the panel shows what goes and why, what is left uncovered, and a choice for each open blocking finding of a dropped condition. "Accept" makes the proposal the plan; "Return to the lead" keeps the old one and sends the note.

**Freshness and the final result.** A "change" condition whose files changed after its stage was accepted no longer counts until the final review confirms it. A refused final review returns such conditions, and those of unmet requirements or open blocking findings, to the next plan, which keeps or drops each. A dropped requirement is never met: the completion basis carries a `person` section, and the result, the board and the history say "The person's decisions instead of evidence". A run never reads cleaner than it is.

**Recovery.** A v2 journal's torn tail is cut off on opening: the bytes go to `quarantine/` and `journal.tail_repaired` is written. A decision already journaled stands after a restart; a command without one is `interrupted`. Continuing leads back to the person's pause.

**Enabling v2** is one constant, `JOURNAL_V2_BY_DEFAULT`: `true` since 1.5.8, after the real series passed (`agent-orchestration/evidence/real-a-gate/attempt-5`). New native runs are written in v2; a run started in v1 goes on in v1. Journals of the A1–A3 development builds (`formatPreview`) are read-only, labelled as a trial build's, and never continued.

**A model per role.** The project settings (`profile.models`) and, over them, the goal give the lead, the executor and the reviewer each a model or none ("As in the CLI", the default). A model goes only to that turn's CLI: Codex gets `model` in `thread/start`/`thread/resume`, Claude gets `--model`; `~/.codex/config.toml` and Claude's settings are never changed. Codex's choices come from `model/list` (`probe.ts` `codexModels`, no model turn; cached for the app session, refreshed on request); a Codex model the account is not offered is a readiness blocker (`model_unavailable`) and refuses the start before any model call. The goal records `models` only in a v2 journal ([journal-v2-format.md](agent-orchestration/implementation/journal-v2-format.md) §1). The run board and the participant cards show the model each CLI reported (its `session` activity entry).

In the check profile git does not read the person's global or system configuration (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`): the profile denies `~/.gitconfig`, and git refuses every command on a global config it may not read.

### Agents' rights

Rights are a project setting (`profile.access`, `access.ts`), apart from how much the run does on its own. A goal keeps the mode it was created with; a saved profile keeps its mode.

- **Work folder** (`workspace`, the default for a new project): the agents write only in the run's work folder; anything else goes through a permission request, which pauses the run until the person answers, in autopilot too.
  - Claude: `--permission-mode acceptEdits --settings {"sandbox":{"enabled":true,"failIfUnavailable":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":true,"network":{"allowedDomains":[],"allowLocalBinding":true}}}`. Edits in the folder are not asked; Bash runs in Claude's sandbox (Seatbelt on macOS) without asking, with no outside network and localhost allowed; a command outside the sandbox and a write outside the folder are asked. Probed on Claude Code 2.1.287 (`evidence/claude-workspace-probe/`): `npm test` and a server on 127.0.0.1 ran without a prompt; a write to `$HOME` and `curl` to an outside host came as `can_use_tool` prompts.
  - Codex: `sandbox: workspace-write`, `approvalPolicy: on-request` (outside network off).
  - Codex writes a trust entry into `~/.codex/config.toml` for any folder it does not know where a thread runs with a workspace-write sandbox (`evidence/codex-trust-probe/`). For the run's own copy or worktree the thread gets `config: {projects: {"<cwd>": {trust_level: "trusted"}}}`, so nothing is written; in the project folder nothing is passed.
- **As in my terminal** (`terminal`): nothing is passed, the user's own settings decide. Only as a project setting, switched on with its warning confirmed ("The agents can do everything you can: network, SSH tunnels, any file"); main refuses to save it without the confirmation (`terminal_not_confirmed`).
- The other modes (`acceptEdits`, `auto`, `full`) stay as they were; `full` only explicitly, with its warning.
- The run's board and each participant's card show the mode; "As in my terminal" in a warning colour, "Full access" in red.

### Requirements and limits

- **Platforms.**
  - A run can complete on macOS only. The check sandbox is Seatbelt (`sandbox-exec`).
  - On Linux and Windows orchestration is unavailable: new agent cards, links, goals (autopilot included) and Resume are refused with `unsupported_platform` before any CLI, login shell or model call, and readiness reports a `platform` blocker without measuring anything. The renderer shows these items inactive with the hint "Orchestration is currently available on macOS only". One function decides (`orchestrationAvailable` in `src/shared/orchestration.ts`); the run manager takes the platform as a dependency.
  - Runs already on disk (made on macOS, or paused with `sandbox_unavailable` by an older version) stay listed and readable there, and can be stopped and unlinked.
- **CLIs**, pinned:
  - Codex CLI 0.155.1: model `gpt-6-astra`, reasoning high, `read-only` sandbox, no user config or rules.
  - Claude Code 2.1.281: model `claude-sonnet-5`, `structured-edit` (a candidate mode: Read/Edit/Write/Glob/Grep, no shell, `--max-budget-usd 1` per turn).
  
  Other versions are refused before a run is created. The executor's edit limits are CLI permission policy, not an OS boundary.
- **Project.**
  - It must be the root of a git repository. Refused: submodules, LFS, nested repositories, linked worktrees, sparse checkouts, unfinished merge/rebase.
  - `package-lock.json` and a real `node_modules` directory are required in the root. The orchestrator never installs dependencies: the copy links the project's `node_modules` read-only.
- **Dependencies in a copy or a worktree** (native runs, stage 12 on). The copy is a git clone and the worktree a checkout, so neither has the project's ignored `node_modules/` or `vendor/`. Right after the copy or worktree is made, before the preparation, `cloneDependencies` (`workspace.ts`) clones each of these folders from the project with APFS clonefile (`cp -cR`, only after checking that both sides are APFS on the same volume, so it never falls back to a byte copy) when the folder is ignored in the copy and its lock file (`package-lock.json`, `yarn.lock` or `pnpm-lock.yaml`; `composer.lock`) in the copy is the project's byte for byte. A folder containing a link that leads out of it is not cloned. In every other case the preparation installs it in the copy (`npm ci`, `composer install`) as in a new project; the lock files of the cloned folders count as installed, so their steps are skipped. Nothing is written into the project and no link leads into it. The outcome per folder (cloned, installed, skipped, with the reason) is in `runs/<runId>/workspace/deps.json` and one activity entry; the journal (v1) is unchanged. The run panel says "Dependencies: cloned from the project" or "installed in the copy". The project-folder mode is unchanged.
- **Interface (minimal).**
  - The panel shows the link's latest run; there is no choice of an older run.
  - The panel does not show checkpoint ref names or offer to merge them: take them with git as above. The run id is the code shown in the panel's header (first 8 characters); `git for-each-ref refs/canvastty/` lists the full names.
  - Agent cards do not follow regions and are not shown on the minimap, in the command palette or in the radial menu.
  - Links are deleted only with "×" after the run has stopped. A linked card asks before it is deleted; runs and their history stay.
- **Processes and CLI data.** There is no startup sweep for leftover processes (see Recovery). The real CLIs keep their own sessions in the user's home directory (`~/.claude/projects/`, `~/.codex/sessions/`), outside the app's `userData`; the app does not limit this.
- **Verification bounds.** Real models have run only one-stage plans; multi-stage runs (a checkpoint per stage) are checked with test CLIs only. Quit during a real turn (R3) was SIGTERM to main, which Electron handles as `app.quit()`; Cmd+Q was not checked separately. Crashes and lost IPC replies are checked with test CLIs only. The Claude cost reported in R1–R3 ($0.0871) covers only its two finished turns and is not the full cost of the series.
- **Test mechanisms**, development builds only: test providers `CANVASTTY_ORCHESTRATION_TEST_PROVIDERS`, the IPC smoke, and lost replies `CANVASTTY_ORCHESTRATION_TEST_DROP_REPLIES`. All are read through `developmentEnv()`, which a packaged build ignores (checked on the packaged app in stage 10).

## Extension points

- Add a provider in `ProviderId`, `providers.ts`, `TerminalManager.resolveLaunch`, the official provider asset map, and an optional safe limit adapter.
- Add a persisted setting to `AppSettings`, defaults/normalization in `SettingsStore`, and the owning feature only. Settings owns user-facing canvas controls and shortcuts; camera math and snapping geometry remain pure renderer concerns.
- Add a canvas entity as a separate feature component with an explicit position and callbacks; keep camera ownership in `WorkspaceCanvas`.
- Publish a runtime extension with `canvastty.plugin.json` API v1 and static HTML/CSS/JS entries. Contribution kinds are `home-widget`, `canvas-app`, and `window`; capability access is restricted to declared permissions. See [Runtime plugins](plugins.md).

Every extension should pass `npm run typecheck`, `npm run build`, and a real Electron interaction check.
