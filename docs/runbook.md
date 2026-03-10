# OpenClaw Config Operations Runbook

Goal: provide operator-focused procedures for verification, incidents, and recovery.

For first-time usage and feature walkthroughs, start with [`getting-started.md`](./getting-started.md).

## Operational Verification

Run baseline quality gates:

```bash
pnpm compile
pnpm test:unit
pnpm test:integration
```

Expected result:

- Build succeeds.
- Unit and integration tests pass.

## Release Preflight (No Publish)

Use this before any public launch decision.

1. Install and build gates:

```bash
pnpm install --frozen-lockfile
pnpm release:gate
pnpm docs:build
pnpm package:vsix
```

2. Verify release artifact exists:

```bash
ls -la dist/openclaw-config-vscode-0.1.0.vsix
```

3. Verify package payload excludes source and docs content:

```bash
unzip -l dist/openclaw-config-vscode-0.1.0.vsix | rg "extension/(src|test|docs|\\.github)/"
```

Expected result: no matches.

4. Verify publish prerequisites (without publishing):

```bash
node -p "require('./package.json').publisher"
test -n "$VSCE_PAT" && echo "VSCE_PAT set"
test -n "$OVSX_PAT" && echo "OVSX_PAT set"
```

Expected result:

- Publisher is `muxammadreza`.
- Both token checks report as set.

5. Secret scan preflight (same image profile as CI):

```bash
docker run --rm \
  -v "$PWD:/repo" \
  zricethezav/gitleaks@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9 \
  detect \
  --source=/repo \
  --redact \
  --verbose \
  --report-format=sarif \
  --report-path=/repo/gitleaks.sarif
```

Expected result: no leaks found.

For actual publish commands, use [`release-checklist.md`](./release-checklist.md).

## Runtime Status Inspection

Primary command:

- `OpenClaw: Show Schema Status` (`openclawConfig.showSchemaStatus`)

Inspect these output fields:

- `source` (`cache` or `bundled`)
- `manifestUrl`
- `openclawCommit`
- `generatedAt`
- `lastCheckedAt`
- `lastSuccessfulSyncAt`
- `lastError`
- `policy.manifest.allowed`
- `policy.manifest.reason`
- `policy.artifacts[*].allowed`
- `policy.artifacts[*].reason`

## Incident: Live Sync Not Updating

Symptoms:

- Schema appears stale.
- Sync status not changing.

Procedure:

1. Run `OpenClaw: Show Schema Status`.
2. Check `lastCheckedAt` and `ttlHours` expectations.
3. Force refresh via `OpenClaw: Refresh Schema Now`.
4. Re-check `source`, `lastSuccessfulSyncAt`, and `lastError`.

Escalation data to capture:

- Full status output block.
- Active sync-related settings values.

## Incident: Policy Blocking Manifest/Artifacts

Symptoms:

- Status indicates policy blocked states.

Procedure:

1. Confirm `manifestUrl` uses HTTPS.
2. Verify host in `openclawConfig.sync.allowedHosts`.
3. Verify repository in `openclawConfig.sync.allowedRepositories`.
4. Re-run `OpenClaw: Refresh Schema Now`.
5. Validate status output again.

## Incident: Metadata Hint Ingestion Failure

Symptoms:

- Missing expected dynamic subfield hints.
- Output channel warnings for plugin metadata.

Procedure:

1. Validate local metadata path existence and JSON shape.
2. Validate remote metadata URL reachability and policy compliance.
3. Temporarily disable remote metadata to isolate local layer behavior.
4. Trigger refresh and retest completion.

## Fallback Behavior Expectations

Fallback order on sync failure:

1. Last known good cache artifacts.
2. Bundled artifacts in `schemas/live`.

If source remains `bundled` unexpectedly:

- Investigate `lastError` and policy fields.
- Confirm remote endpoint and checksums upstream.

## Recovery Verification Checklist

After incident remediation:

- [ ] `OpenClaw: Show Schema Status` has expected policy values.
- [ ] `lastError` is `none` or no longer incident-related.
- [ ] `OpenClaw: Refresh Schema Now` completes without blocking issues.
- [ ] Validation and command workflows work on a sample `openclaw.json`.

## Related Guides

- Symptom-first troubleshooting: [`troubleshooting.md`](./troubleshooting.md)
- Settings and policy reference: [`configuration.md`](./configuration.md)
- Full command behavior: [`commands.md`](./commands.md)
