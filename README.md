# OpenClaw Config VS Code Extension

[![CI](https://github.com/muxammadreza/openclaw-config-vscode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/muxammadreza/openclaw-config-vscode/actions/workflows/ci.yml)
[![Virus Scan (ClamAV)](https://github.com/muxammadreza/openclaw-config-vscode/actions/workflows/virus-scan.yml/badge.svg?branch=main)](https://github.com/muxammadreza/openclaw-config-vscode/actions/workflows/virus-scan.yml)
[![Test Coverage](https://github.com/muxammadreza/openclaw-config-vscode/actions/workflows/coverage.yml/badge.svg?branch=main)](https://github.com/muxammadreza/openclaw-config-vscode/actions/workflows/coverage.yml)

DX-first VS Code support for `openclaw.json` with schema validation, smart diagnostics, quick fixes, and guided configuration workflows.

## Who This Is For

- Teams maintaining `openclaw.json` files in real projects.
- Integrators who need safe config edits with fast feedback.
- Developers who want guardrails for schema sync, secrets, bindings, and dynamic fields.

## 5-Minute Quick Start

### Option A: Use in development (this repository)

```bash
pnpm install
pnpm compile
pnpm test:unit
pnpm test:integration
```

Then launch the extension in VS Code from this repo:

1. Open the folder in VS Code.
2. Press `F5` to start an Extension Development Host.
3. In the new window, run `OpenClaw: New Config`.

### Option B: Use as an installed extension

1. Open a workspace.
2. Create or open `openclaw.json`.
3. Run `OpenClaw: Show Schema Status` once to confirm sync/status behavior.

## Feature Highlights

- Schema autocomplete and validation for `**/openclaw.json`.
- Zod shadow diagnostics layered on top of schema diagnostics.
- Integrator diagnostics for missing agent/account references and secret hygiene.
- One-click quick fixes for common config issues.
- Hybrid autocomplete: static schema suggestions + dynamic key/value suggestions for wildcard/plugin contexts.
- Dynamic subfield completion from schema, UI hints, and optional plugin metadata (including value hints).
- Explain workflows (hover + command) for contextual field guidance.
- Normalize command for stable ordering and `$schema` insertion.
- Live schema sync with cache TTL, host/repo allowlists, and SHA-256 verification.

## Command Cheat Sheet

| Command | ID | Typical Use |
|---|---|---|
| OpenClaw: New Config | `openclawConfig.newConfig` | Create a starter `openclaw.json` |
| OpenClaw: Refresh Schema Now | `openclawConfig.refreshSchemaNow` | Force sync and revalidation |
| OpenClaw: Insert Section Snippet | `openclawConfig.insertSectionSnippet` | Insert guided section snippets |
| OpenClaw: Explain Selection | `openclawConfig.explainSelection` | Open markdown explain view for current path |
| OpenClaw: Normalize Config | `openclawConfig.normalizeConfig` | Normalize and save config with stable structure |
| OpenClaw: Show Schema Status | `openclawConfig.showSchemaStatus` | Inspect source, commit, sync state, policy result |

## Settings Overview

| Setting | Purpose | Default |
|---|---|---|
| `openclawConfig.zodShadow.enabled` | Toggle zod shadow diagnostics | `true` |
| `openclawConfig.sync.ttlHours` | Sync cache TTL in hours | `6` |
| `openclawConfig.sync.manifestUrl` | Remote manifest source | GitHub raw manifest URL |
| `openclawConfig.sync.allowedHosts` | Host allowlist for sync URLs | `["raw.githubusercontent.com"]` |
| `openclawConfig.sync.allowedRepositories` | Repository allowlist for artifact URLs | `["muxammadreza/openclaw-config-vscode"]` |
| `openclawConfig.codeActions.enabled` | Toggle OpenClaw quick fixes | `true` |
| `openclawConfig.integrator.strictSecrets` | Elevate secret hygiene to errors | `false` |
| `openclawConfig.integrator.explainOnHover` | Show explain text on hover | `true` |
| `openclawConfig.plugins.metadataUrl` | Optional remote plugin hint registry | `""` |
| `openclawConfig.plugins.metadataLocalPath` | Workspace-local plugin hint file | `.openclaw/plugin-hints.json` |

Full settings reference: [`docs/configuration.md`](./docs/configuration.md)

## Learn by Task

| I Want To... | Go Here |
|---|---|
| Get productive in minutes | [`docs/getting-started.md`](./docs/getting-started.md) |
| Learn every command in detail | [`docs/commands.md`](./docs/commands.md) |
| Configure sync/security/plugin hints safely | [`docs/configuration.md`](./docs/configuration.md) |
| Understand diagnostics and quick fixes | [`docs/diagnostics-and-quick-fixes.md`](./docs/diagnostics-and-quick-fixes.md) |
| Follow practical day-to-day flows | [`docs/workflows.md`](./docs/workflows.md) |
| Debug failures quickly | [`docs/troubleshooting.md`](./docs/troubleshooting.md) |
| Understand internals and module layout | [`docs/architecture.md`](./docs/architecture.md) |
| Contribute safely | [`docs/contributing.md`](./docs/contributing.md) |
| Operate/release with incident procedures | [`docs/runbook.md`](./docs/runbook.md) |
| Plan launch sequencing and gates | [`docs/release-roadmap.md`](./docs/release-roadmap.md) |
| Run feature-complete and release gates | [`docs/release-checklist.md`](./docs/release-checklist.md) |

## Development Commands

```bash
pnpm compile
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm sync:schema
```

## Documentation Index

- [`docs/README.md`](./docs/README.md)
- GitHub Pages site entrypoint: [`docs/index.md`](./docs/index.md)

## GitHub Pages Documentation

This repository includes a GitHub Pages documentation pipeline powered by VitePress.

- Site configuration: [`docs/.vitepress/config.mts`](./docs/.vitepress/config.mts)
- Deployment workflow: [`.github/workflows/docs-pages.yml`](./.github/workflows/docs-pages.yml)
- Docs source directory: [`docs/`](./docs/)

Local preview:

```bash
pnpm install
pnpm docs:dev
```

## License and Changelog

- License: [MIT](./LICENSE)
- Changelog: [`CHANGELOG.md`](./CHANGELOG.md)
- Security policy: [`SECURITY.md`](./SECURITY.md)
