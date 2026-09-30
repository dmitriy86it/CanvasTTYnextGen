# Raoden Loom documentation

[English](README.md) · [Русский](README.ru.md)

Raoden Loom is a spatial Electron desktop for real local terminals and AI-agent CLI sessions. This documentation explains how to run the MVP, preserve its process and visual contracts, and extend it with honest source-backed widgets.

## Guides

| Guide | What it covers |
|:--|:--|
| [Getting started](getting-started.md) | Requirements, local launch, first session, and verification commands |
| [Built-in browser and audit log](browser.md) | Canvas controls, settings, agent access, website/file boundaries, activity, and persistent redacted audit files |
| [Installing, releases, and local data](installing-and-security.md) | Installer formats, unsigned-preview caveats, credential boundaries, and release checks |
| [Widget authoring](widget-authoring.md) | Source-level extension paths, visual grammar, process boundaries, and an AI-agent brief |
| [Runtime plugins](plugins.md) | Manifest v1, permissions, HOME widgets, canvas apps, separate windows, player media/playlist APIs, SDK, and install flow |
| [Metrics and telemetry](metrics-and-telemetry.md) | Subscription limits, session token usage, source priority, privacy, stale states, and tests |
| [Security policy](../SECURITY.md) | Supported release, vulnerability reporting, local data boundaries, plugins, media grants, browser storage, and audit logs |
| [Changelog](../CHANGELOG.md) | User-visible fixes and features by release |

## Maintainer references

| Contract | Read it before… |
|:--|:--|
| [Architecture](ARCHITECTURE.md) | changing IPC, PTY/browser lifecycle, persistence, process ownership, agent transports, or provider adapters |
| [UI contract](UI_CONTRACT.md) | changing Home, launch flow, Settings, canvas behavior, terminal/browser cards, or visual semantics |

## Current extension model

Raoden Loom supports static runtime plugins through manifest API v1. Untrusted UI stays inside sandboxed frames/windows and receives only explicitly approved capabilities. Trusted core integrations that need new main-process services remain source-level contributions compiled with the app.

## Non-negotiable data rule

Never invent session status, counters, quota, token usage, cost, countdowns, or progress. Use a real structured source and surface `loading`, `stale`, `unavailable`, or `error` when the source cannot answer.

Back to the [repository overview](../README.md).

Raoden Loom is released under the [MIT License](../LICENSE).
