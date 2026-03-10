# Project Guidelines

## Architecture
- This is a VS Code extension for `openclaw.json`; keep the runtime split documented in `docs/architecture.md`.
- Preserve module boundaries when changing behavior:
  - `src/extension*` for activation, settings, events, commands, and orchestration
  - `src/schema/*` for schema artifacts, sync, metadata, and security policy
  - `src/validation/*` for diagnostics, dedupe, and quick-fix plumbing
  - `src/templating/*` for normalization, snippets, and completion logic
- Keep lazy activation and the single in-flight initialization model intact unless a change intentionally redesigns startup behavior.

## Build and Test
- Use `pnpm` for all development commands.
- Core validation loop:
  - `pnpm compile`
  - `pnpm test:unit`
  - `pnpm test:integration`
- Use `pnpm lint` for strict TypeScript checks and `pnpm test:coverage` when changing validation-heavy logic.
- For release-sensitive changes, run `pnpm release:gate`.

## Conventions
- Keep command IDs and settings keys stable unless a deliberate versioned change is documented.
- Preserve diagnostic source semantics: `json-schema`, `openclaw-zod`, `openclaw-integrator`, and `openclaw-runtime` each mean something specific.
- Quick-fix payload contracts should remain backward compatible with existing code-action flows.
- For schema sync and security work, preserve HTTPS enforcement, host/repository allowlists, SHA-256 verification, and the `cache -> bundled` fallback path.
- Any user-visible behavior, configuration, diagnostics, or operational change should update the matching docs in the same change.

## Key Files and Docs
- `docs/architecture.md` for the module map and runtime flow
- `docs/contributing.md` for safety gates and test expectations by change type
- `docs/configuration.md` for settings and policy behavior
- `docs/diagnostics-and-quick-fixes.md` for validation semantics
- `src/extension.ts` for orchestration patterns
- `src/schema/artifactManager.ts` and `src/schema/security.ts` for sync/security behavior
- `test/unit/` and `test/integration/` for expected testing patterns
