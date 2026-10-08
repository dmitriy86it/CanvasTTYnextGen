# Changelog

[English](CHANGELOG.md) · [Русский](CHANGELOG.ru.md)

## Unreleased

## 1.5.13 — 2026-10-08

No redundant permission prompts in «Work folder», resizable agent cards, a live feed in a larger card.

- «Work folder»: read-only commands no longer stop the run with permission prompts. In run 7303d772 Claude asked about every read-only command written as `cd … && bash -c '…'`, with a variable (`$f`, `$O`) or a brace with a quote: these were not requests to leave the sandbox, but Claude's own check that could not read the command line before running it. In the sandbox the application now answers such a prompt itself: the command still runs in Claude's sandbox, which writes only in the work folder and reaches no outside host. A request to leave the sandbox, the sandbox's network prompt, a write outside the folder, a user's ask rule and a safety check still reach the person. Checked on the real Claude 2.1.294: the commands of 7303d772 ran without a prompt, a write to the home folder failed with «operation not permitted», and a curl to an outside host was held for the person.
- A permission prompt of a read-only command, after more than 3 of them in a run, offers «Allow read-only commands until the run ends» (viewing and searching files — cat, head, sed -n, grep, find without -exec, ls, wc…; no network, no writes, no git). It applies to this run only and is kept in memory: after the application restarts it asks again.
- Agent cards are resized like terminal cards: the same handles, selection, group drag and zoom. The smallest is the card as it was, the largest a terminal's. The size is kept on the canvas (not in the run's journal) and comes back after a restart. «Expand / Collapse» in the card's header (or a double click on the header) switches between the compact size and the size it had last time it was larger.
- A larger card shows its agent's latest events — tools, commands, messages, as in the activity feed — newest at the bottom. It follows new events; scrolled up, it stays where you are until you come back down. A home folder is said as `~`.
- No line of a card is cut by height any more: every line is one line, a long one ends with «…» and shows all of it in its tooltip. The project is one line, the last event's time sits beside the state.
- A waiting agent no longer repeats the working one's line word for word: «Waiting: Claude runs stage 1: …», one line.

## 1.5.12 — 2026-10-08

Check before the start, run cost, the limit pause, «Take the result», a separate copy by default.


- «Take the result» for a run in a separate copy or worktree (UX audit 2026-10-05, top-10 №10) — the main button of such a completed run, also offered for a stopped run and a paused one with changes. The source is the run's last checkpoint; without one, the working copy as it is now, said so. «Create a branch in the project» (the safe one): a branch `raoden/<goal>-<id>` (the name shown and editable) holding the run's changes on top of what the run started from; your working folder, index and current branch are not touched, a taken name is never overwritten (another one is proposed). In a worktree the result is committed on the run's branch and the branch renamed. «Apply to the working folder» only when the changes fit your files as they are now, checked first; on an overlap with your uncommitted edits nothing is written and the files are named. «Show the changes» opens the Changes tab. The summary then says «Result taken: branch …» or «applied to the working folder at …»; doing it again does nothing twice. Done by the application's own git, never by an agent; kept in a file of the run's workspace, not in the journal.
- «A separate copy» is the default work place of a new project; saved project settings keep theirs. The project settings offer all three places. In «In the project folder» with uncommitted changes the goal dialog says how many and offers «Switch to a separate copy» for this goal only.
- After «Check now» found commands failing before any change, Start asks: «Leave the failing commands out of this run» (main), «Start as it is — the agents fix them too», or back to the goal. The project settings do not change.
- Wording: a check command «passes / fails before the agents' changes (in a temporary copy of the project)»; the card's cost is «This agent's calls», the board's «The whole run».

- «Check now» in the goal dialog and in the project settings (UX audit 2026-10-05, top-10 №8): a check before the start with no model call. It lists each item as ok, warning or blocker, with one sentence on what to do and, where it can, a «Fix» button that opens the right setting or the check commands. Items: the CLIs and their rights modes (the capability probes of 1.5.11); the sign-in, only where the CLI's own help offers a status command (`codex login status`, `claude auth status`); the roles' models (Codex from its model list; Claude's is not checked before the start); the check sandbox's self-test and git in it; the preparation and the check commands on the source, in a temporary copy or worktree made as a run makes it, dependencies cloned the same way, within 10 minutes. Each command reads passed, failed (its first lines) or out of time; commands that already fail say «The checks already fail before any change — the agents will hold them as required». In «In the project folder» the commands are not run before the start. The temporary copy is removed, also on an error. A summary line says how many blockers and warnings there are; only blockers stop the start. The light check (no preparation, no commands) still runs by itself when the goal dialog opens.
- The run board and the agent cards show what the run spends (Н9): model calls per role, the tokens each CLI reported (Codex and Claude both report them; never money), the time worked against the run's time limit, the turns used of the limit and the time left to the deadline.
- The limit pause (Н7) shows each limit's current value and what is used of it, marks the one the run stopped at, proposes a new value with its unit, and has one main button «Raise the limit and continue» — the run goes on without a separate «Resume».
- When Claude does not answer the capability probe within 30 s (slow hooks at its start), one slower probe (90 s) runs in the background. If that one does not answer either, «Work folder» is a warning, not a blocker: «The «Work folder» mode for Claude is not confirmed by the probe… Starting is safe: with the sandbox unavailable Claude refuses to work by itself». Start stays available; a timeout is not kept between starts of the application.
- Settings → Notifications: if the number does not appear on the Dock icon, the settings say to turn on «Badge application icon» in System Settings → Notifications → Raoden Loom.
- The smokes `workspaces-ui` and `workspaces-background` pass again: their fake lead answered in journal v1 forms after v2 became the default.

## 1.5.11 — 2026-10-08

Updated CLIs no longer block the start: capability probes instead of version lists.


- Updated CLIs no longer block the start. What the installed Codex and Claude offer is now probed, without a model call, instead of looked up in a list of versions: Claude's `--help` and a session started with the «Work folder» switches; Codex's app-server protocol schema (no thread is started, so `~/.codex/config.toml` is not touched). The answer is kept per program, version and modification time, and a new version is probed again by itself. Codex 0.160.0 and Claude 2.1.293 run in every rights mode, and readiness no longer warns «protocol not compared». It warns only when something a run relies on has changed, and names what.
- Readiness and the start decide by one rule: a rights mode or a model a CLI does not offer is a readiness blocker that names the CLI, its version and what is missing, e.g. «Claude 2.1.293: does not take the sandbox settings (--settings) — the «Work folder» mode is unavailable». Start is off with that reason beside it; the start never refuses for a reason readiness did not show.
- On such a blocker, «Run <CLI> «As in my terminal» for this run only» runs that CLI with your own settings after a confirmation that explains the wider rights. The project settings stay as they are; rights are never lowered or widened on the quiet.

## 1.5.10 — 2026-10-07

UX improvements from the UX audit of 2026-10-05: pauses that say what happened and what to do, a summary without contradictions, clear decisions and dialogs, notifications and the Dock badge.


- Pauses say what happened, why and what to do (UX audit 2026-10-05). Each of the 27 pause reasons has its own headline, one sentence of why, a concrete next step and one main button — an action the run actually accepts on that pause. The headline is no longer repeated in the line under it, and six pauses are no longer all called «Needs your decision». An unavailable check sandbox on macOS no longer advises to «run on macOS»: it says the sandbox's self-test failed and to set the check commands in the goal; only a platform without the sandbox says it has none.
- The main button of the run panel is the pause's own action («Resume», «Retry the turn», «Answer the question», «Raise the limit»…); Stop is secondary, outlined and last — the main action only where stopping is all a pause allows. While the run works, Pause is the main button.
- The link chip, the agent cards, the activity feed and the widget say «Waiting for you: …» for a pause that needs you and «Paused: …» for one you may simply resume, in the same words as the panel.
- A plan proposal that drops readiness criteria offers «Return to the lead» first and as the main button; «Accept dropping» is secondary and says the dropped criteria will no longer be checked. A blocking finding's «Make it a wish» and «Close» say that leaving it be is the safe choice.
- The result block never says the opposite of the headline or of itself (UX audit 2026-10-05, Н5). A completed run reads «Goal accepted by the final review: yes»; a run still going reads «not yet», never «no». Without check commands a criterion the review marked reads «marked by the review, not checked by a command», not «met», and the checks line «did not run». On the pause «the lead changed files» the changes read «unknown», not «none». A pause never reads «From you: nothing needed». The next step after a run in the project folder says «if there are changes, commit them».
- Journal ids read as words: «Finding 1», «Criterion 2», «Requirement 2» instead of F1, C2, R2; the id itself is in the tooltip. «Conditions» are called «criteria» everywhere in the panel.
- The agents are asked to write what the person reads — plan titles and tasks, questions, findings, notes — in the interface's language at the goal's creation; ids, paths and commands stay as they are. Older goals are unchanged.
- The goal dialog and the project settings keep «Start» / «Save» pinned at the bottom, in view without scrolling; radios and checkboxes are drawn in the dialog's light scheme (they looked inverted). The CLI flags behind each access mode are under «More».
- A plan proposal that drops criteria keeps its headline and the list of what is dropped in view while you scroll to the buttons; «Return to the lead» and «Accept dropping» are in one row.
- Push and deploy to QA are two separate groups, «Sending the changes (push)» and «Deploying to the test server (QA)», each confirmed or declined, with a note that the two decisions are independent.
- The link chip on the canvas no longer covers the Codex card: it sits between the linked cards when there is room, otherwise under (or above) them.
- Check commands that never ran read «not run yet», not «0 of N passed». «Where the commands come from» says «the lead proposed none» when there are none. A disputed finding says what each choice leads to. Start and Save are dark on the light dialog and say beside them why they are off. The goal dialog asks for «Requirements for the result».
- Without check commands the result says so plainly — you set none and the lead proposed none, only the review checked it — and the criteria section says a requirement is met when its criteria are. The goal dialog no longer shows a sample command in an empty field nor «proposed from the project's files» when nothing was. The settings fold the preparation commands under «More».
- Hints: «One step» and «Resume» say how they differ on hover. A glossary explains lead, executor, reviewer, turn, round, sandbox, push, QA, criterion and finding in one sentence on hover (dotted underline), in English and Russian.

- macOS notifications for agent runs (UX audit 2026-10-05, item 3): a run waiting for you (the pauses the chip calls «Waiting for you», and a permission request), a run completed (with checks, or «Completed without checks» — another text) and a run stopped on an error. Only while the window is not focused or is minimized; the text is the project's name and the short reason, never a path, a command or a file. One notification per change of state; the last state told of each run is kept outside the journal, so a restart tells nothing again. A click brings the window forward, switches to the run's workspace, moves the camera to its link and opens its panel.
- The Dock badge shows how many runs wait for you across all workspaces (hidden at 0); optionally the icon bounces once when a run starts waiting.
- Settings → «Notifications»: Waiting for you, Completed, Error, Dock badge (on) and Bounce the icon (off). Where macOS shows no notification (not allowed, an unsigned build), the settings say how to allow them in System Settings and the window shows a banner instead.
- The goal dialog: a requirement that reads like a check command (`npm …`, `node …`, `pytest`, `./…`, `--test` …) gets «Looks like a check command. Move it to «Check commands»?» with a «Move» button; nothing is moved by itself.
- A completed run whose next step is the «Changes» tab has «View the changes» as its main button; «New goal» is secondary.
- «These cards are already linked» on a card is an information, not an error: no longer red.
- The glossary explains a checkpoint, a worktree, «confirmed by the journal», «the agent's claim» and the `canvastty/…` service branch.
- Smokes: the hermetic process check judges a pid by the program it ran when the process tree was taken — a short-lived process of the app whose pid was reused by an unrelated one (a parallel `npm test`) is no longer reported as foreign.
## 1.5.9 — 2026-10-05

- Copying from terminals keeps Cyrillic and box drawing: "Этап 0" copied from Claude Code or Codex in a terminal card no longer becomes "–≠—В–∞–њ 0". An app started from Finder or the Dock had no locale, and the CLIs a card starts directly (not through a login shell) copied through `pbcopy` as Mac Roman. At startup the app now sets `LANG` to the system locale in UTF-8 (`ru_RU.UTF-8`, else `en_US.UTF-8`; `C.UTF-8` on Linux) when none of `LC_ALL`, `LC_CTYPE`, `LANG` is set; terminals, agent CLIs, preparation and checks inherit it. Values you set are kept; a non-UTF-8 one is logged. ⌥ + drag selects as the terminal does over a CLI that tracks the mouse.

## 1.5.8 — 2026-10-04

- **Journal v2 is on by default** (stage A done). New runs are written in v2 without the development flag: the lead plans with requirements and conditions, a separate reviewer reviews, the check commands may be left empty for the lead to propose, a run without checks ends as «Completed without checks» and pushes or deploys only after your confirmation. The items below marked "development flag only" are all in this release. Runs started in v1 go on in v1; a journal of an A1–A3 development build is shown read only. The gate was a real series on real CLIs: R1–R5 passed (`docs/agent-orchestration/evidence/real-a-gate/attempt-5`).
- A model for each role: in the project settings, and over them in the goal, the lead, the executor and the reviewer each get a model, or «As in the CLI» (the default: no model is passed, the CLI's configuration decides). Codex offers what `model/list` says for your account (asked without a model turn, kept for the session, «Refresh» asks again); Claude offers opus, sonnet, haiku and any other name. The model goes to that one Codex thread or Claude run: `config.toml` and Claude's settings are never changed. A Codex model your account is not offered stops the start before any model call, with where to change it. The run board and the participant cards show the model each CLI reported.
- Check commands the lead proposes, run in the check sandbox, can use git: git no longer tries to read `~/.gitconfig`, which the sandbox denies, and failed every command with exit 128.
- While the reviewer reviews a stage, the executor that finished says it waits for the review.
- Journal v2 plans: the lead is told that a "change" condition is proven only by files the run changes, so "a file stays unchanged" is a check command or no condition at all. The reviewer answers such a condition "not met" and asks for a new plan instead of "met" without files, and the new plan is told which conditions were not met and why. Before, a run could stop on such a condition: "met" without files was refused, "not met" kept the stage until its rounds ran out.
- Journal v2 reviews: a review is offered only the conditions and requirements it decides (a stage review — the stage's "change" conditions; none — no marks at all), and the task names the check conditions apart: they are met only by their command. A mark the review gives besides that — a check or person condition, a requirement the person dropped, an unchanged file next to changed ones — no longer refuses the whole report: it is left out, never counted, and the feed says so ("the reviewer marked C3 — not counted: the condition is met by its command").
- Codex no longer adds a `[projects."…"]` trust entry to your `~/.codex/config.toml` for every run's separate copy or worktree: the run's own folder is trusted for its thread only. In the project folder nothing changes. A Codex turn refused because the model in your Codex config is not supported by your account now pauses with that reason and where to change the model, instead of "environment error".
- Agents' rights: a new project starts in **Work folder** mode. The agents write only in the run's work folder; anything else goes through a permission request, which pauses the run until you answer, in autopilot too. Claude runs with `acceptEdits` and its own sandbox (commands without asking, no outside network, localhost allowed), Codex with `workspace-write` and `on-request`. **As in my terminal** is now a project setting switched on with a confirmed warning; saved settings and started runs keep their mode. The run's board and each participant's card show the mode, "As in my terminal" in a warning colour. While a plan proposal waits for your decision on another pause, "Clarify" and "Raise limit" are shown off with a hint.
- Journal v2 (stage A, A4, development flag only; v2 is still not on by default): the person's decisions and the finish. Some decisions are the person's alone, made in the run panel, and the run waits for them — the autopilot never makes one:
  - a disputed finding is shown next to the closed one it may repeat: "A new defect" or "A repeat of F<n>";
  - a condition the person confirms: "Met" or "Not met";
  - a plan that drops conditions or requirements is a proposal: "Accept", with a choice for each open blocking finding of a dropped condition, or "Return to the lead";
  - on a pause, an open finding can be closed or a blocking one made a wish.

  Each decision is recorded with the tree and the state the person saw; a stale one is refused, and the panel shows the current state. A "change" condition whose files changed after its stage was accepted counts only when the final review confirms it, and a refused final review returns such conditions to the next plan. The result never reads cleaner than it is: dropped requirements and conditions, downgraded and person-closed findings are named as "The person's decisions instead of evidence", never as met or fixed. A v2 journal's torn tail is cut off on opening (the bytes kept aside), and a decision recorded before a crash stands after it. Enabling v2 for everyone is one switch, off until a real series.
- Journal v2 (stage A, A3, development flag only): review findings and the reviewer. Stages and the final result are reviewed by a separate reviewer — Codex in a new session for every review, without the executor's report — and the lead only plans. The reviewer reports findings, blocking or wishes, numbered F1, F2, … by the application and never renumbered; a blocking finding holds its stage and the run until a later review closes it on a changed tree, naming the files changed for it. Each review's result and what the application did with it are journaled with every finding's history; a journal that says "Completed" with a blocking finding open is shown as damaged. The result has a "Findings" section with each finding's number, severity, status and history; the cards and the activity feed say "Open blocking: N"; the run panel lists the reviewer as a participant.
- Journal v2 (stage A, A2, development flag only): requirements and readiness conditions. Each acceptance criterion of the goal is a requirement R1, R2, …; every stage of the lead's plan lists the conditions that prove them, numbered C1, C2, … by the application and never renumbered; a new plan keeps the open ones. A condition is met by a check command passing on the tree the run completes on (a pass on an older tree does not count) or by the lead's review naming the files the run changed. A stage is accepted only with its conditions met, the run completes only with every condition and requirement met, and a journal that says "Completed" without that evidence is shown as damaged. The result has a "Conditions" section with each requirement, its conditions, their status and evidence; the cards and the activity feed say "N of M conditions met".
- Journal v2 (stage A, A1.1, development flag only): check commands the lead proposes run in a Seatbelt profile of their own — network to this machine only, writes to the run's work folder and a temporary folder — after a self-test of the profile, so the autopilot accepts them itself. A check the sandbox refuses pauses with "A check needs more permissions": the lead's command never runs without the sandbox as it is — the person opens it in full and saves it as their own command, which then runs in their shell. When the lead finds no command the autopilot goes on without checks (step by step: "Add commands" or "Go on without checks"). A v2 journal of the final form is shown read only, records as they are. Commands the person enters run as before.
- Run journal v2 (stage A, A1), only behind the development flag `CANVASTTY_JOURNAL_V2=1` (a packaged build ignores it; user runs are still written in v1): the check commands of a goal may be left empty, the lead then proposes them with a reason for each (or says why there are none), and the person accepts or edits them before any work starts — the autopilot too, since native checks run without a sandbox. A run without checks ends as "Completed without checks" on the panel, cards, link chip, activity widget and workspace history, never as completed; its commit is made, push and QA wait for the person's decision on the tree and commit shown. A v2 journal is shown read only by 1.5.7; v1 journals and how they are written are unchanged.

## 1.5.7 — 2026-10-01

- Electron smoke runs are hermetic: the development app gets a PATH of refusing fake CLIs and system folders, looks for provider CLIs in PATH only and polls no provider for limits (CANVASTTY_SMOKE_HERMETIC, ignored by a packaged build); a smoke fails when the app starts a program outside the fakes and the allowed list. Every smoke window stays painted while covered (logged, the covered-window case stays open), and a screenshot that gets no answer in 15 s is retried once and then fails by name instead of hanging.
- Preparation: an install step with nothing to install (package.json without dependencies, devDependencies, optionalDependencies or workspaces; composer.json without require or require-dev) succeeds without its folder and is no longer suggested; such runs no longer pause with "environment preparation failed" on every Continue. A failed preparation now shows its step and one line of why on the run panel (with the last 40 lines of its output), a summary in the feed, its start and end in the history, and the next step names the step; the login shell's own noise is left out of the reason.
- The run panel says what really happened to a copy's dependencies: cloned, installed (after the step succeeded), not installed because automatic preparation is off, the install step failed (with a way to the step) or there is none, or not needed. The project's `node_modules` is cloned only when npm would call it current (its `.package-lock.json` is not older than `package-lock.json`); otherwise it is installed in the copy. Smoke and E2E scripts that start Electron stop after 10 minutes (`SMOKE_TIMEOUT_MS`) with the last step, the live child processes and the app's last output.
- Runs in a separate copy or a worktree get the project's dependencies: `node_modules/` and `vendor/` are cloned from the project (APFS clonefile, no bytes copied, nothing written into the project) when their lock files match, otherwise installed in the copy by the preparation. The run panel says which.
- One classification of a pause for every place that says why a run paused: the activity rows, the agent cards, the run panel's feed and history now name a provider's usage limit as the panel does, not "environment error".
- A JS project without a lock file is prepared with `npm install --no-package-lock`, so no package-lock.json is written into it.
- A provider's usage limit (the recorded Codex message) is no longer shown as an environment error: the run panel names the provider and the reset time the CLI gave and offers waiting or another account, not fixing dependencies or raising the run's budget. A PHP project with a front-end package.json and no JS lock file is no longer prepared with `npm install`, which wrote a new package-lock.json into it. The Even G2 companion waits for its pairing log write when it closes.
- Orchestration is offered only where a run can finish (macOS): on Linux and Windows its items are shown inactive with a hint, and new links, goals and Resume are refused before any CLI or model call, so no tokens are spent on a run that would pause at its first check. Existing runs there can still be read, stopped and unlinked. The deb package's Maintainer is now the fork's packager, and a failed browser tab-restore setting is logged instead of left unhandled.
- Added the Biome linter in lint-only mode (`npm run lint`, CI step Lint); the formatter stays off.
- Documentation and CI: the README, package metadata and install guide point to this fork (releases, homepage, repository), the README gains a platform matrix and credits to the upstream CanvasTTY, the Simplified Chinese note is removed, and LICENSE adds the fork's copyright line. CI checks out the full history so the workspaces rollback test runs, and Linux jobs are pinned to `ubuntu-24.04`. Technical identifiers (`canvastty`, `appId`, data folder) are unchanged.
- A run journal written by a newer version is shown read only (agent cards, link chip, activity widget, workspace history: "created by a newer version", never "paused", no actions). Such a run can be released from its link ("Release link", with confirmation; all newer runs of the link together; its files are kept), and deleting it is refused. A newer journal that declares `minReaderVersion: 1` is replayed by v1 rules: unknown fields are ignored, unknown records marked `skippable: true` are skipped and counted, `v` and `minReaderVersion` come from the first record, and anything else falls back to the read-only view. v1 journals and how they are written are unchanged (contract §2.2.1).
- CI: the `verify` job passes on Linux; the fixes are in tests only (temporary folders, the check shell, a stop grace).

## 1.5.6

- Fixed a false "protocol error" after a correct answer: when the CLI finished and exited but left a process behind (for example an MCP server or a hook) that did not hold its output, the turn failed about 2 s later. The per-turn supervisor now relays the CLI output itself and decides whether a stream closed before or only after its cleanup; a process that really holds the output (stdout, and now also stderr) still fails the turn. The run panel and the Log name the step where a turn ended, and application-side failures are no longer blamed on the CLI. No retry is promised as safe.

## 1.5.5

- A run paused before a restart can be stopped again when the installed Codex or Claude CLI is missing or of another version: Stop no longer asks for the CLIs, the login shell or the project's dependencies, so its cards and link can then be deleted. Resume and new runs still require the verified versions.

## 1.5.4

- Renamed the application to **Raoden Loom** (formerly CanvasTTY). Only what you read changes: the window and About titles, the macOS menu, interface texts and the installer file names (`Raoden-Loom-<version>-…`). The technical identity stays `canvastty`: the same `appId`, the same data folder (`~/Library/Application Support/canvastty` on macOS), browser profile, plugin API, `CANVASTTY_*` variables, MCP name and Git refs, so your settings, workspaces, history, plugins and browser data are opened as before.
- Added project workspaces on macOS: separate canvases per project with their own camera, a switcher with work counters, moving cards between workspaces, per-workspace run history, and hiding a workspace with an explicit "Stop and hide" that reports each terminal and run as stopped only after its exit is confirmed. Known open items: see `docs/agent-orchestration/ROADMAP.md`.
- A terminal whose card is closed after a stop that saw no exit stays visible, marked "closed, its end not confirmed", until the process really ends.
- The saved GitHub sign-in is no longer lost when the system key store cannot decrypt it: the file is kept, a new sign-in keeps a copy, and Settings shows that the saved sign-in is unavailable.

## 1.5.3

- Added agent orchestration on macOS (MVP): a Codex lead card and a Claude executor card on the canvas, a lead → executor link, and a goal that runs plan → edit → project checks in a sandbox → review → checkpoint automatically. The run panel offers Pause after turn, Step, Resume, Stop and recovery after a crash. Results stay in `refs/canvastty/<runId>/stage-<n>` of the project and are taken with git; the user's branch is never changed. Requires Codex CLI 0.155.1 and Claude Code 2.1.281. Limits: macOS only; the Claude executor mode is a candidate; see `docs/agent-orchestration/FIRST-USE.md`.
- Security: packaged builds enable Electron fuses — `NODE_OPTIONS` and `--inspect` are ignored, and `app.asar` is integrity-checked and the only app source. `runAsNode` stays on for the agent helpers.
- Security: every main-renderer IPC channel now verifies its sender.
- Security: packaged builds ignore `ELECTRON_RENDERER_URL` and the provider smoke overrides.
- Security (Even G2): each paired device gets its own link key, issued per handshake and usable only after Mac approval; rejection and revocation destroy it. Devices start read-only, and the LAN API answers only through the encrypted link. Glasses paired with an earlier version must pair again.

## 1.5.2

- Fixed terminal history jumping to the beginning when Codex clears and redraws its history after a card resize. Readers retain their relative scroll position, while terminals at the bottom continue following new output.
- Fixed deferred terminal sizing after an offscreen alternate-screen resize, preserving follow-output mode when the card returns to view.
- Includes the already merged OMP/Pi providers and agent transport, startup, plugin installation, canvas gesture, and browser fixes from PRs #33 and #47.
- Includes the Even G2 companion with local pairing and voice control from PR #50.
- Includes architecture decision documentation, the `js-yaml 4.3.2` pin, and build dependency updates from PRs #48 and #49.

## 1.5.1

- Fixed the HOME Terminal button passing a mouse event as canvas coordinates and failing with “Session position is invalid”.
- Added local file drag-and-drop into terminal cards. File paths are quoted for the host's default shell and pasted without submitting the command; filenames with spaces and Unicode are preserved.
- Fixed terminal history replay overlapping live output, scrollbar coordinates at canvas zoom, and scrollback/follow-output position during resize.
- Added the configurable radial quick launcher from PR #29. It is off by default and can be enabled under Settings → Agents → Quick launcher without losing the selected actions when disabled.
- Added a close button that deletes sticky notes (PR #30).
- Added project-path paste in agent launch dialogs and corrected GNOME clipboard metadata handling (PRs #27 and #31). Terminal links now offer a choice between the built-in and system browser (PR #28).
- Restored Claude Code usage tracking with credential-store selection fixes (PR #25).

## 1.5.0

- Replaced competing canvas right-click handlers with one context-sensitive dispatcher. Empty canvas, color regions, and sticky notes now expose their own actions; the configurable safe agent/terminal launcher is shared with the searchable `Cmd/Ctrl+K` command palette.
- Added sticky notes as first-class persistent canvas windows with editing, drag, eight-direction resize, snapping, deletion, deterministic region containment, and minimap markers. This work adapts and credits the original sticky-note and quick-launcher ideas from @TroopJostle's PR #23.
- Finished color-region movement: completely contained terminals, Browser/plugin windows, and notes follow continuously during region drag and persist once at release. Region targeting, magnetic snapping, and bounds rules no longer attach partially overlapping windows or teleport them after the gesture.
- Added ordinary click-to-front stacking for every canvas window. The native Browser surface now respects renderer-owned overlap, and launch dialogs are clamped before their first frame instead of flashing outside the application near the right edge.
- Redesigned Settings and all canvas menus around shared application tokens, official Lucide/provider assets, and one `0.85–1.25` UI-chrome scale. Palette changes recolor menus automatically without changing canvas zoom or terminal font size.
- Added independent General settings for saving color regions and sticky notes after exit. Disabling either keeps its live objects for the current run while omitting only that collection from the next-launch snapshot.
- Split minimap interaction into explicit Click and Drag modes. Drag now follows empty-canvas grab direction without an initial camera jump, while a stationary press in Drag mode performs no click navigation.

## 1.3.0

- Added opt-in terminal-window restoration. CanvasTTY persists only window identity, provider/profile, title, project folder, position, and size; agents resume through their native project-scoped continue mode, while PTY scrollback and capabilities remain ephemeral.
- Added named pastel Canvas regions from the empty-canvas context menu, plus an RTS-style camera-centred minimap. HOME and fixed-size window markers now move through a uniform projection without auto-fit distortion, and a HOME edge marker appears only after HOME has fully left the radar.
- Expanded Canvas navigation bindings to Mouse3/Mouse4/Mouse5, kept middle-button drag as the direct pan fallback, and corrected wheel ownership so terminal session lists and focused input surfaces scroll locally while explicit Canvas capture remains predictable.
- Fixed Grok Build's cropped initial TUI by waiting for the renderer-measured xterm grid on launch, restart, and restore. Terminal resize and palette changes preserve the active scrollback viewport.
- Added configurable whole-row agent status colors in Appearance: gray for idle/unavailable/finished states, sage green for working, and yellow for input-needed, with a monochrome alternative.
- Fixed Claude usage limits to read the current runtime user's OAuth credentials and perform the provider request when a token exists. Missing local credentials now mean sign-in is required instead of being misreported as a missing subscription.
- Prevented CanvasTTY from restoring, showing, or focusing its window because of a rejected second launch or background plugin/browser activity, avoiding unsolicited virtual-desktop switches.
- Added a concise Agents hook switch, expandable About FAQ, and explicit per-hook trust for optional plugin agent hooks. Plugin hooks remain disabled after install/update and run in an isolated process with CanvasTTY internal capabilities stripped.

## 1.2.8

- Added Qwen Code as a first-class launcher across HOME, Settings, CLI discovery, Normal/YOLO profiles, the plugin SDK, and the scoped built-in-browser MCP bridge, using the official Qwen mark and launch-only configuration.
- Added a Qwen row to HOME limit display and its settings. Because Qwen Code can use unrelated cloud or local model providers and exposes no universal quota-read protocol, CanvasTTY reports an explicit unavailable reason instead of inventing usage data.
- Replaced the generic open state for agent sessions with an authenticated local lifecycle gateway. Codex, Claude Code, Qwen Code, Kimi Code, OpenCode, Hermes, and Grok Build now report idle, working, and input-needed through provider hooks without forwarding prompt or response content; Claude/Qwen terminal-title markers remain a compatibility fallback.
- Fixed delayed bootstrap snapshots reverting an already observed agent lifecycle back to unavailable. Session metadata now carries a main-owned monotonic revision, and the renderer rejects stale status updates while preserving initial terminal output.
- Preserved the active terminal scrollback position when a card or application window is resized instead of jumping to the beginning of the session.
- Kept segmented-setting keyboard focus inside its selected button and restored spacing between the wheel/pinch capture selector and its conditional key editor.

## 1.2.7

- Added a permission-gated Hermes Desktop HUD bridge for plugins. The host exposes only status, open-in-HUD, and close operations through `hermes:hud`; plugins cannot choose an executable, arguments, or PID.

## 1.2.6

- Provider CLI executables are now resolved once at startup and reused by terminals, usage limits, and agent-browser flows through the same absolute launcher, with structured diagnostics for missing and non-executable commands.
- Failed HOME sessions now expose complete sanitized diagnostics on hover or keyboard focus, offer a Copy action, and explain silent exits with their exit code. The top-layer details popover preserves the three-row scroll viewport and the failed-session danger rail.
- Packaged macOS apps now discover Homebrew CLIs and the official per-user OpenCode install under `~/.opencode/bin` even when launched with Finder's minimal `PATH`.
- CI now packages the macOS app and exercises real minimal-`PATH` CLI resolution on every pull request and `main` update, in addition to the release-time smoke.

## 1.2.5

- Added OpenCode, Hermes, and Grok Build as first-class launchers on Linux, macOS, and Windows, with official provider marks, native per-launch YOLO behavior, Windows discovery, plugin SDK coverage, and scoped built-in browser MCP integration where supported.
- Added an independent **Agents** settings section: launcher visibility and HOME limit visibility are persisted separately, hidden launchers leave existing sessions untouched, and the HOME dock automatically redistributes visible buttons.
- Added source-backed OpenCode Go and Grok Build usage adapters alongside Codex, Claude, and Kimi. The five-row HOME limits tile now switches to compact, height-aware geometry so every countdown and usage rail stays inside its default bounds.
- Expanded Appearance with independent HOME accent presets/custom colors and Canvas background colors, plus diagonal and ring patterns. Canvas colors no longer recolor HOME widgets, and the Settings top strip remains visually separated from scrolling content.
- Fixed native Browser viewport clipping so embedded pages stay inside the usable workspace instead of covering application chrome, and added visible DEV/release build identity with normalized provider marks.

## 1.2.4

- macOS bundles are now explicitly ad-hoc signed with hardened runtime and notarization disabled for the free distribution path; the release workflow runs strict `codesign` verification before uploading artifacts.
- Updated installation guidance to explain that ad-hoc signing verifies bundle integrity but does not provide a Developer ID or notarization. macOS users should replace the pre-fix `1.2.2` and `1.2.3` artifacts with `1.2.4` or later.

## 1.2.3

- Added a GitHub-backed plugin showcase with complete pagination, metadata-first manifests, platform and host-version hints, update discovery, and OAuth Device Flow sign-in.
- Hardened plugin installation and updates with platform enforcement, atomic rollback, strict manifest validation, bounded metadata batches, trusted archive redirects, and protected OAuth persistence and IPC.
- Added the permission-gated plugin `browser.open` SDK method for normalized HTTP(S) URLs, routed through one awaitable broker that creates or reuses a single embedded Browser card and persists it before reporting success.

## 1.2.2

- Reworked canvas navigation: two-axis scrolling now pans the canvas by default, while pinch and `Cmd/Ctrl+scroll` perform focal-point zoom; the legacy scroll-to-zoom profile remains available in Settings, preserving its direction and sensitivity.
- Introduced logical widget input ownership: widgets capture the wheel after an explicit click or a configurable hover delay, keep focus until you click outside, and offer `Off / On / Key` capture modes; a separate hold binding temporarily captures full canvas navigation, including drag.
- Preserved gesture continuity across native Browser surfaces: page-vs-canvas ownership latches for 250 ms of wheel inactivity, pinch and `Cmd/Ctrl+scroll` always zoom the canvas, and a focused Browser page keeps scrolling natively when capture is disabled.

## 1.2.1

- Plugin canvas apps now open and refocus at native `1.0` scale, avoiding fractional-scale blur; their transparent iframe backdrop also removes the bright seam around rounded plugin windows.
- Terminal and Browser semantic summaries now reserve width before counter-scaling and keep their content centered, preventing icons and text from being clipped at distant canvas zoom levels.

## 1.2.0

- Added native macOS window chrome: a hidden title bar with traffic-light buttons, a compact brand bar, and correct native-fullscreen behavior; Linux and Windows keep the existing custom frame.
- Added OS-encrypted plugin secrets via Electron safeStorage (fail-closed when no system keyring is available) with per-call permission checks, quotas, change events, and uninstall cleanup.
- Plugins can now contribute a settings entry opened in a sandboxed frame, declare minimum canvas sizes, and open another canvas of the same plugin beside the current one.
- Plugin HOME widgets are listed beside built-in widgets in Appearance → HOME composition and can be added or removed like built-in ones, closing the 1.1.0 known gap; Settings → Plugins is scoped back to install/uninstall only.
- Added optional plugin modules: install-time selection, per-file SHA-256 and byte-count verification, atomic reconfiguration with rollback, and module-derived permissions applied consistently to SDK authorization and the plugin resource CSP.
- Plugin storage change events are now broadcast from the main process, so canvases, HOME widgets, and separate windows of the same plugin observe each other's writes.
- Hardened plugin downloads: redirects are pinned to `api.github.com` and `raw.githubusercontent.com`, and module downloads reuse the 1.1.0 retry/backoff.
- Documented the optional-module trust model: file integrity is anchored to the plugin manifest fetched from GitHub over TLS without a separate signature.

Known issue: installed plugins cannot be updated in place yet — uninstall and reinstall to pick up a newer version. An update action is planned.

## 1.1.0

- Scaled native browser pages to the canvas zoom via Chromium zoom factor (clamped 0.5–3), so browser content follows the canvas scale at any zoom.
- Reported browser viewport bounds synchronously and kept the native view visible during canvas panning, dragging, and resizing; this fixes the 1.0.2 issue where the native browser view could cover a non-maximized window and block canvas controls.
- Focused the browser tab's web contents on canvas pointer-down, so typing reaches the page without an extra click.
- Added a Settings toggle for browser agent presence indicators (on by default): presence badges/cursors no longer appear at authentication, cursors render as plain dots without names, and only agents that actually used the browser are shown.
- Retried GitHub plugin downloads up to three times with backoff on transient failures (timeouts, connection errors, HTTP 408/429/5xx, interrupted streams).
- Added terminal session restart: a restart button on exited cards and a `Ctrl+D` shortcut; PageUp/PageDown now page the scrollback in the normal buffer, and the terminal cursor is a block.
- Enabled wheel zoom over applications by default.
- Synchronized documentation in English, Russian, and Simplified Chinese.

Known issue: HOME layout customization is not finished for external plugins — plugin tiles cannot yet be placed or rearranged in the HOME layout editor. This gap is tracked for future work; contributions are welcome.

## 1.0.2

- Exposed the built-in browser from HOME as a movable, resizable canvas application with trusted tabs/navigation, downloads, site dialogs, safe tab restore, browser-data clearing, semantic summaries, and stable native-view geometry during camera/card motion.
- Added scoped browser automation for CanvasTTY-launched Claude Code, Codex, and Kimi sessions through a bundled stdio MCP helper and authenticated current-user Unix socket or protected Windows named pipe; no TCP listener, remote-debugging port, arbitrary JavaScript, cookie/storage API, or raw CDP surface is exposed.
- Added connected-agent badges/cursors, per-agent activity isolation, revision-bound element refs, per-tab FIFO mutations, request deduplication, bounded concurrency/rate limits/timeouts, dialog/download handling, and redacted screenshots that fail closed when sensitive regions cannot be resolved.
- Added a persistent redacted browser audit hash chain below Electron `userData/browser/audit`, 100 MB rotation, 30-day rotated-file retention, integrity checks, and fail-closed agent mutations when the required pre-action audit cannot be written.
- Integrated browser cards with terminal-equivalent canvas selection, click/hover focus, empty-canvas clearing, window actions, wheel zoom over applications, and a stable renderer surface while the native view is repositioned.
- Hardened the Windows agent transport with a bundled native named-pipe host restricted to the exact current-user SID and added real Electron/provider smoke coverage across the release pipeline.
- Fixed the repository secret audit for linked Git worktrees by ignoring repository metadata entry names before file-type inspection while preserving personal-path detection in publishable files.
- Synchronized browser, security, local-data, audit-log, and release documentation in English, Russian, and Simplified Chinese.

Known issue: if the main CanvasTTY window did not start maximized, opening Browser can make the native browser view cover the window and leave the canvas controls unusable. For this prerelease, start CanvasTTY maximized before opening Browser; a fix is planned for the next patch.

## 1.0.1

- Added `Shift+Enter` terminal line breaks without submitting the current prompt.
- Fixed terminal selection and keyboard focus: selecting a live card routes typing into xterm, while pressing empty canvas clears the selection and focus outline.
- Added optional focus-on-hover with slow (`500ms`), normal (`250ms`), and fast (`80ms`) enter/leave delays. Programmatic hover focus no longer forwards focus-report sequences into agent TUIs or jumps their history.
- Added independent terminal-scroll and canvas-zoom wheel direction settings. Terminal scrolling defaults to wheel-down moving down; canvas zoom retains its previous direction.
- Batched PTY output into 16ms renderer updates and replaced repeated scrollback string copies with a bounded chunk buffer, eliminating high-volume terminal flicker and reducing history resets under large output bursts.
- Made settings, plugin-registry, and media-grant write queues recover after transient filesystem errors, and aligned provider-client metadata with the packaged app version.
- Added complete Simplified Chinese runtime-plugin documentation, synchronized terminal-control guidance across English, Russian, and Chinese, and documented local plugin/media/browser data.
- Added the MIT License and localized security, changelog, architecture, and UI-contract documents.

## 1.0.0

- Added a lightweight local startup page that appears before settings, plugins, media, and IPC services initialize; bootstrap failures now surface as a visible error page with a native-dialog fallback instead of a blank window.
- Added Electron single-instance lock: a second launch restores and focuses the existing window.
- Remapped terminal pointer coordinates from the canvas's CSS-transformed rectangle back to xterm layout coordinates, so text selection, mouse reporting (vim, tmux), and wheel scrolling work at any canvas zoom.
- Reworked terminal clipboard shortcuts: copy with `Ctrl+C` (with selection), `Ctrl+Shift+C`, or `Cmd+C`; paste with `Ctrl+Shift+V`, `Cmd+V`, or `Shift+Insert` through `Terminal.paste`; shortcuts now match physical keys and work on non-Latin keyboard layouts.
- Added a packaged-app smoke harness (`CANVASTTY_SMOKE_TEST=1` prints `CANVASTTY_SMOKE_READY` after first paint) and wired it into the Linux release pipeline under `xvfb-run` with FUSE2.

## 0.9.99 — public preview

- Added a permissioned runtime plugin registry for ready-to-run static GitHub repositories.
- Added manifest v1 contributions for sandboxed HOME widgets, movable canvas apps, and separate CanvasTTY-owned windows.
- Added plugin preview/permission review, enable/disable/uninstall controls, isolated storage, CSP-constrained assets, and a shared host SDK.
- Added persistent user-granted music libraries, seekable local audio streams, and bounded playlist read/write APIs for full player plugins.
- Added a sandboxed built-in browser core scaffold with tabs, navigation, a persistent isolated profile, and canvas-card geometry; it is intentionally not exposed from HOME yet.
- Replaced the fixed HOME composition with a spacious persisted 16 × 12 layout and visual drag/resize editor while preserving the approved default arrangement.
- Added any-edge window and HOME-widget resizing, visible edit-only HOME boundaries, out-of-bounds draft placement, save validation, and edit-mode isolation from other canvas windows.
- Added runtime-plugin architecture/authoring documentation and a complete Studio Kit example package.

## 0.9.2 — public preview

- Made provider CLI discovery cross-platform: per-user CLI directories are now resolved on both Linux and Windows, so AppImage and Windows launches find existing `codex`, `claude`, and `kimi` installs.

## 0.9.1 — public preview

- Restored provider CLI discovery for graphical AppImage launches by supplementing the desktop-session `PATH` with existing per-user CLI directories, including Kimi's `~/.kimi-code/bin`.
- Prevented late terminal input and resize events from crashing the Electron main process when they race with PTY exit (`EBADFD`).

## 0.9.0 — public preview

- Fixed the main window never appearing when the renderer paints before `loadURL` resolves; the `ready-to-show` listener is now attached before loading.
- Added RTS-style edge panning (off by default; enable in Settings): the camera drifts while the pointer rests near a viewport edge over empty canvas and pauses over interactive surfaces.
- Added Settings controls for edge panning (toggle and speed) and wheel zoom sensitivity.
- Reorganized Settings into General, Appearance, and Controls sections.
- Added explicit Off, Single click, and Double click modes for terminal focus/zoom; automatic click focus is off by default.
- Added remappable application shortcuts with `Home` for the Home zone and `F2` for inline terminal-window rename, plus an optional live shortcut hint.
- Preserved PTY state and scrollback while changing palettes, patterns, settings, and custom window titles.
- Improved terminal clipboard shortcuts, edge resizing, semantic-zoom interaction, and multilingual documentation.

## 0.8.2 — public preview

- Publish only end-user installers from release jobs, excluding unpacked build directories.
- Give Windows NSIS and portable executables distinct artifact names.

## 0.8.1 — public preview

- Made repository and documentation security checks portable across LF/CRLF checkouts and Windows drive paths.
- No application behavior changed from the `0.8.0` preview candidate.

## 0.8.0 — public preview

- Spatial canvas for live local PTY and AI-agent CLI sessions.
- Fixed Home zone with launchers, sessions, clock, media, and source-backed provider limits.
- Movable, resizable, snapping terminal cards with semantic zoom navigation.
- Electron process isolation with typed, allow-listed IPC and local-only settings.
- Multilingual repository entry points and documentation in English, Russian, and Simplified Chinese.
- Reproducible Linux, Windows, and macOS packaging through GitHub Actions.
- Repository secret audit and strict package-content allowlist.

Known preview constraints: runtime widget plugins are not implemented; Windows and macOS behavior still needs broader real-device validation; release packages are not code-signed or notarized.
