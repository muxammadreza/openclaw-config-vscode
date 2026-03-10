# Public Launch Roadmap (`0.1.0`)

Goal: controlled public launch of extension and repository within one week, with hard feature freeze and release-critical cleanup only.

## Scope and Rules

Release-critical scope means:

1. No new features before launch.
2. Allowed changes: bug fixes, release docs, packaging/release safety.
3. Public APIs remain stable:
   - Command IDs unchanged
   - Settings keys unchanged
   - JSON validation mapping unchanged

## Day-by-Day Plan (1 Week)

## Day 1: Freeze + Baseline

Tasks:

1. Activate feature freeze for launch branch.
2. Finalize release-prep changes in one release PR.
3. Confirm version/changelog/scripts consistency.

Verification:

1. `git status --short` clean before/after commit window.
2. `package.json` version and scripts match release docs.
3. `CHANGELOG.md` has `0.1.0` release section.

## Day 2: Release-Critical Cleanup

Tasks:

1. Validate link and policy consistency across:
   - `README.md`
   - `SECURITY.md`
   - release docs in `docs/`
2. Run local secret/leak scan with same Gitleaks image/profile as CI.
3. Validate no TODO/FIXME blockers in production paths.

Verification:

1. No broken release/security/publisher links.
2. No secret findings.
3. No release-blocking TODO/FIXME in `src/`, `docs/`, `README.md`, `SECURITY.md`.

## Day 3: RC Gate + Packaging Hardening

Tasks:

1. Run full gate:
   - `pnpm install --frozen-lockfile`
   - `pnpm release:gate`
   - `pnpm docs:build`
   - `pnpm package:vsix`
2. Validate VSIX payload contains runtime artifacts only.

Verification:

1. VSIX exists at `dist/openclaw-config-vscode-0.1.0.vsix`.
2. No packaging warnings for LICENSE/file filtering.
3. No `src/`, `test/`, `docs/`, `.github/` content in VSIX.

## Day 4: Publisher Onboarding + Publish Preflight

Tasks:

1. Ensure VS Marketplace publisher matches `muxammadreza`.
2. Ensure Open VSX namespace exists and is accessible.
3. Configure tokens:
   - `VSCE_PAT`
   - `OVSX_PAT`
4. Run preflight checks without publishing.

Verification:

1. CLI tooling available (`vsce`, `ovsx` via `pnpm dlx`).
2. Tokens present in environment.
3. No namespace/publisher mismatch.

## Day 5: Go/No-Go + Public Launch

Tasks:

1. Go/No-Go review using:
   - `release-feature-complete-checklist.md`
   - `release-checklist.md`
   - this roadmap
2. Publish exactly the same VSIX to:
   - VS Marketplace
   - Open VSX
3. Make repository public only after successful store publish and final secret check.

Verification:

1. Listings visible in both stores.
2. Install works from both stores.
3. `README.md` quick-start works in clean workspace.

## Release-Critical Cleanup Checklist

- [ ] Working tree clean and intentional.
- [ ] `LICENSE` present and correct.
- [ ] Security reporting link correct.
- [ ] `package.json` file allowlist active and verified.
- [ ] Release scripts (`release:gate`, `package:vsix`, `publish:*`) executable.
- [ ] Docs build strict without errors.
- [ ] Local secret scan and CI secret scan pass.
- [ ] Release docs complete and interlinked.

## Go/No-Go Decision Criteria

Go only if all are true:

1. All automated gates pass.
2. Smoke matrix is fully PASS with zero blockers.
3. Publisher + token preflight is successful.
4. VSIX artifact is stable and reproducible.

No-Go triggers:

1. Any failed gate or smoke blocker.
2. Secret-scan findings.
3. Publisher/token/access mismatch.
4. Packaging drift between tested and published artifact.

## Assumptions

1. Target version stays `0.1.0` stable.
2. Manual publishing remains the release mode.
3. Packaging/publish commands use `--no-dependencies`.
4. Work is constrained to release-critical cleanup only.
