# Widget authoring

[English](widget-authoring.md) · [Русский](widget-authoring.ru.md) · [Docs home](README.md)

This guide covers trusted source-level widgets compiled with Raoden Loom. For third-party packages installed at runtime, use the permissioned [runtime plugin API](plugins.md). Source-level work remains appropriate when a feature needs a new trusted main-process adapter or changes core product ownership.

## Choose the smallest extension shape

| Shape | Use it for | Typical ownership |
|:--|:--|:--|
| Passive Home widget | A clock, launcher, derived label, or renderer-local presentation that does not consume wheel input | `features/home/` plus a pure selector |
| Main-backed Home widget | Provider usage, machine state, or another value that requires filesystem, network, credentials, or a subprocess | shared contract → main service → IPC/preload → pure selector → Home component |
| Canvas entity | A movable spatial object with world position, optional size, and focus behavior | standalone feature component composed by `WorkspaceCanvas` |

Do not add a main-process service for data already available in typed renderer state. Do not fetch privileged data directly from React merely because it is convenient.

## Process-boundary recipe

For a main-backed widget, implement the path in this order:

1. Add a sanitized request/snapshot type and IPC name to [`src/shared/contracts.ts`](../src/shared/contracts.ts).
2. Add a focused adapter or service under [`src/main/services/`](../src/main/services/) that owns credentials, subprocesses, timeouts, validation, caching, and cleanup.
3. Register one allow-listed handler in [`src/main/ipc/registerIpc.ts`](../src/main/ipc/registerIpc.ts).
4. Expose only the typed capability from [`src/preload/index.ts`](../src/preload/index.ts). Never expose Node primitives, raw IPC, tokens, cookies, or provider responses.
5. Convert the snapshot into view data with a pure selector near the owning feature.
6. Render the state in a focused component and compose it from Home or `WorkspaceCanvas`.
7. Test normalization, error/stale behavior, and the selector before inspecting the real Electron flow.

`App.tsx` is the orchestration boundary. A feature may own its exclusive capability, but it must not reach into unrelated feature APIs.

## Visual grammar

New widgets should look native to Raoden Loom:

- Start from a calm spatial desktop, not a dashboard packed with controls.
- Use large flat tiles, soft radii, restrained shadows, and generous spacing.
- Use graphite for operational surfaces such as terminals; use sage, pink, blue, and pale yellow as quiet canvas accents.
- Keep labels short and hierarchy readable at a glance and during zoom.
- Prefer one obvious primary action. Avoid decorative status dots, hover-only essentials, nested frames, and explanatory microcopy around self-evident controls.
- Let wheel input stay with a surface only when that surface truly scrolls or consumes it. Passive Home widgets should preserve canvas zoom.
- Use official Lucide SVGs already vendored in [`assets/icons/lucide`](../src/renderer/src/assets/icons/lucide/) and documented provider marks from [`assets/providers`](../src/renderer/src/assets/providers/README.md). Do not redraw icons in TSX.
- Model `loading`, `available`, `stale`, `unavailable`, and `error` explicitly. Do not turn missing data into an empty bar, zero, or false success.
- Verify normal scale and zoomed-out semantic readability. Identical entities must keep identical typography and weight.

Home has fixed ownership rules: media controls remain inside `HomeMediaWidget`. Settings owns user-facing configuration through General, Appearance, Controls, and Plugins; feature runtime behavior stays with its owning component or service. Read the [UI contract](UI_CONTRACT.md) before changing either.

## A brief for another AI coding agent

Copy this into the agent task and replace the bracketed fields:

```text
Add a Raoden Loom widget called [NAME] that shows [USER VALUE].

Before editing, read docs/ARCHITECTURE.md and docs/UI_CONTRACT.md and find the
closest existing feature pattern. Raoden Loom is an Electron MVP with context
isolation: privileged work stays in main, cross-process data is declared in
src/shared/contracts.ts, IPC is allow-listed, and preload exposes only a typed,
sanitized capability.

Data source: [STRUCTURED SOURCE]. Never parse terminal/TUI text and never invent
values. Render explicit loading, available, stale, unavailable, and error states.
Do not expose credentials, raw provider responses, prompts, or unbounded history.

Visual direction: calm spatial desktop; large flat tile; soft radius; restrained
shadow; graphite operational surfaces with sage/pink/blue/yellow accents; short
labels; readable at canvas zoom. Reuse vendored Lucide/provider assets. Do not add
decorative status dots, hover-only core controls, nested frames, or custom SVG in
TSX. Preserve wheel ownership rules.

Scope: [HOME PASSIVE / HOME MAIN-BACKED / CANVAS ENTITY]. Add focused tests for
normalization and state selection. Run npm test, npm run typecheck, npm run build,
then inspect the affected flow in the real Electron window. Do not add packages.
```

## Source-level example layout

This is a naming example, not a runtime plugin ABI:

```text
src/shared/contracts.ts
src/main/services/SessionUsageService.ts
src/main/ipc/registerIpc.ts
src/preload/index.ts
src/renderer/src/features/session-usage/
├── SessionUsageWidget.tsx
├── sessionUsageModel.ts
└── sessionUsage.css
tests/session-usage.test.mjs
```

Prefer existing shared style tokens before adding feature CSS. If the widget belongs on Home, fit it into the approved logical composition instead of silently changing Home dimensions or moving another feature's controls.

## Definition of done

- The displayed value traces to a named structured source.
- Privileged access stays in main; renderer data is sanitized and typed.
- Missing, stale, and failed reads are distinguishable.
- The widget has a clear owner and does not duplicate Settings or media controls.
- Mouse wheel, focus, drag, and canvas zoom behaviors do not conflict.
- The widget is readable at its intended zoom levels and uses existing assets.
- Normalization and selector behavior have focused tests.
- `npm test`, `npm run typecheck`, and `npm run build` pass.
- The real Electron flow has been inspected.

For a worked data model, continue to [Metrics and telemetry](metrics-and-telemetry.md).
