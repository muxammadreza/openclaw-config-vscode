# Security Policy

## Supported Versions

This project is currently in active development and follows a "latest main" support model.

| Version | Supported |
|---|---|
| `main` (latest) | Yes |
| older snapshots/releases | No |

## Reporting a Vulnerability

Please do **not** open public issues for security vulnerabilities.

Use GitHub private vulnerability reporting:

- [Report a vulnerability](https://github.com/muxammadreza/openclaw-config-vscode/security/advisories/new)

If private reporting is unavailable, open a private channel with the maintainers and include:

1. Affected version/commit.
2. Reproduction steps.
3. Impact assessment (confidentiality/integrity/availability).
4. Suggested fix or mitigation (if available).

## Response Targets

Best-effort targets for received reports:

- Initial acknowledgement: within 72 hours.
- Triage/impact confirmation: within 7 days.
- Fix timeline: depends on severity and exploitability.

## Disclosure Process

1. We validate and reproduce the issue.
2. We prepare a fix and regression checks.
3. We coordinate disclosure once a fix is available.
4. We document remediation guidance in release notes/changelog.

## Secret and Credential Handling

The repository must never contain active credentials.

Requirements:

- Use environment variables for secrets.
- Do not commit `.env` or key material (`*.pem`, `*.key`, certificates, keystores).
- Use `${env:...}` references in `openclaw.json` instead of cleartext secrets.
- Rotate and revoke credentials immediately if exposure is suspected.

## Automated Secret Scanning

This repository enforces continuous secret scanning in CI via Gitleaks.

- Workflow: `.github/workflows/secret-scan.yml`
- Scope: push, pull requests, scheduled scans, manual runs.

## Security Hardening Scope in This Extension

This extension already includes runtime hardening for remote schema sync:

- HTTPS-only remote manifests/artifacts.
- Host and repository allowlist checks.
- SHA-256 verification of downloaded artifacts.
- Cache/bundled fallback behavior on failure.

## Scope Boundaries

This extension validates and assists editing of `openclaw.json`. It does not act as a secret vault, key manager, or runtime credential broker.
