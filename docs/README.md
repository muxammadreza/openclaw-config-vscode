# OpenClaw Config Documentation

Use this index to find the fastest path for your current task.

## Start Here (Users)

1. [`getting-started.md`](./getting-started.md) for first setup and first successful `openclaw.json` flow.
2. [`commands.md`](./commands.md) for command-by-command usage.
3. [`configuration.md`](./configuration.md) to tune validation, sync, and security behavior.

## Daily Workflows

- [`workflows.md`](./workflows.md): practical routines for bootstrap, edits, secure secrets, and schema sync.
- [`diagnostics-and-quick-fixes.md`](./diagnostics-and-quick-fixes.md): understand and fix issues quickly.

## Troubleshoot and Debug

- [`troubleshooting.md`](./troubleshooting.md): symptom-first troubleshooting table and recovery steps.
- [`runbook.md`](./runbook.md): operations-oriented verification and incident handling.

## Contribute and Understand Internals

- [`architecture.md`](./architecture.md): runtime flow and module map.
- [`contributing.md`](./contributing.md): setup, test gates, and safe change workflow.

## Release Readiness and Publishing

- [`release-roadmap.md`](./release-roadmap.md): one-week launch roadmap with freeze rules, risk gates, and go/no-go criteria.
- [`release-feature-complete-checklist.md`](./release-feature-complete-checklist.md): feature-complete smoke matrix and evidence log.
- [`release-checklist.md`](./release-checklist.md): end-to-end manual release checklist for VS Marketplace and Open VSX.

## Full Link Map

| Document | Purpose |
|---|---|
| [`Project README`](https://github.com/muxammadreza/openclaw-config-vscode/blob/main/README.md) | Compact project hub and quick navigation |
| [`getting-started.md`](./getting-started.md) | First-run success path in under 5 minutes |
| [`commands.md`](./commands.md) | Full command reference with preconditions and outcomes |
| [`configuration.md`](./configuration.md) | Complete settings reference and safe configuration patterns |
| [`diagnostics-and-quick-fixes.md`](./diagnostics-and-quick-fixes.md) | Diagnostic model and before/after quick-fix examples |
| [`workflows.md`](./workflows.md) | Repeatable user workflows for daily use |
| [`troubleshooting.md`](./troubleshooting.md) | Symptom-driven debugging and recovery |
| [`architecture.md`](./architecture.md) | Code-level architecture and data/control flow |
| [`contributing.md`](./contributing.md) | Contributor workflow, constraints, and expectations |
| [`runbook.md`](./runbook.md) | Operations and incident procedures |
| [`release-roadmap.md`](./release-roadmap.md) | One-week launch roadmap and go/no-go gates |
| [`release-feature-complete-checklist.md`](./release-feature-complete-checklist.md) | Feature-complete gate criteria and evidence |
| [`release-checklist.md`](./release-checklist.md) | Manual release and publishing steps |

## GitHub Pages Build and Preview

This docs directory is configured as VitePress source for GitHub Pages.

Build locally:

```bash
pnpm install
pnpm docs:build
```

Preview locally:

```bash
pnpm install
pnpm docs:dev
```

Deployment workflow:

- [`.github/workflows/docs-pages.yml`](../.github/workflows/docs-pages.yml)
