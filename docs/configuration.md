# Configuration Reference

Goal: configure validation, sync, security, and plugin hint behavior safely and predictably.

## Full Settings Table

| Setting | Type | Default | Allowed Range/Values | Practical Guidance |
|---|---|---|---|---|
| `openclawConfig.zodShadow.enabled` | `boolean` | `true` | `true` / `false` | Keep enabled for richer diagnostics; disable only for focused schema-only debugging. |
| `openclawConfig.sync.ttlHours` | `number` | `6` | `1..168` | Lower for more frequent updates, higher for network-constrained environments. |
| `openclawConfig.sync.manifestUrl` | `string` | `https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/schemas/live/manifest.json` | HTTPS URL | Use trusted, versioned manifest endpoints only. |
| `openclawConfig.sync.allowedHosts` | `string[]` | `["raw.githubusercontent.com"]` | Hostnames | Keep strict allowlist. Add hosts only when needed and trusted. |
| `openclawConfig.sync.allowedRepositories` | `string[]` | `["muxammadreza/openclaw-config-vscode"]` | `owner/repo` values or `"*"` | Prefer explicit repositories. Use `"*"` only in controlled environments. |
| `openclawConfig.codeActions.enabled` | `boolean` | `true` | `true` / `false` | Disable only if you need diagnostics without automatic fix suggestions. |
| `openclawConfig.integrator.strictSecrets` | `boolean` | `false` | `true` / `false` | Set to `true` in CI/hardening phases to fail fast on cleartext secret values. |
| `openclawConfig.integrator.explainOnHover` | `boolean` | `true` | `true` / `false` | Disable if hover noise is too high for your workflow. |
| `openclawConfig.plugins.metadataUrl` | `string` | `""` | HTTPS URL or empty | Optional remote hint layer. Must pass security policy checks. |
| `openclawConfig.plugins.metadataLocalPath` | `string` | `.openclaw/plugin-hints.json` | Workspace-relative or absolute path | Keep workspace-relative for team portability. |

## Security Policy Settings

These settings jointly control whether remote sync content is accepted:

- `openclawConfig.sync.manifestUrl`
- `openclawConfig.sync.allowedHosts`
- `openclawConfig.sync.allowedRepositories`

Behavior summary:

1. Manifest URL must be HTTPS.
2. Manifest host must be allowlisted.
3. Artifact URLs inside manifest must pass host and repository checks.
4. SHA-256 hash checks must match for downloaded artifacts.
5. On failure, extension falls back to cache or bundled artifacts.

## Configuration Profiles

### Safe default profile

```json
{
  "openclawConfig.zodShadow.enabled": true,
  "openclawConfig.sync.ttlHours": 6,
  "openclawConfig.sync.manifestUrl": "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/schemas/live/manifest.json",
  "openclawConfig.sync.allowedHosts": [
    "raw.githubusercontent.com"
  ],
  "openclawConfig.sync.allowedRepositories": [
    "muxammadreza/openclaw-config-vscode"
  ],
  "openclawConfig.codeActions.enabled": true,
  "openclawConfig.integrator.strictSecrets": false,
  "openclawConfig.integrator.explainOnHover": true,
  "openclawConfig.plugins.metadataUrl": "",
  "openclawConfig.plugins.metadataLocalPath": ".openclaw/plugin-hints.json"
}
```

### Strict security/hardening profile

```json
{
  "openclawConfig.sync.ttlHours": 1,
  "openclawConfig.sync.allowedHosts": [
    "raw.githubusercontent.com"
  ],
  "openclawConfig.sync.allowedRepositories": [
    "muxammadreza/openclaw-config-vscode"
  ],
  "openclawConfig.integrator.strictSecrets": true
}
```

### Controlled custom mirror profile

```json
{
  "openclawConfig.sync.manifestUrl": "https://raw.githubusercontent.com/muxammadreza/openclaw-config-vscode/main/schemas/live/manifest.json",
  "openclawConfig.sync.allowedHosts": [
    "raw.githubusercontent.com"
  ],
  "openclawConfig.sync.allowedRepositories": [
    "muxammadreza/openclaw-config-vscode"
  ]
}
```

## Plugin Metadata Hints

Two optional hint sources are merged:

1. Remote entries from `openclawConfig.plugins.metadataUrl`.
2. Local entries from `openclawConfig.plugins.metadataLocalPath`.

Precedence behavior:

- Layers are merged by pattern.
- Later layers can override existing property hints for same field key.
- Warnings are emitted to output when loading fails.

Optional property-level value hints:

- `type`: expected value type (`string`, `number`, `integer`, `boolean`, `object`, `array`).
- `enumValues`: allowed primitive values.
- `examples`: suggested primitive example values.
- `defaultValue`: preferred default primitive value.

Example `.openclaw/plugin-hints.json`:

```json
{
  "version": 1,
  "entries": [
    {
      "path": "channels.whatsapp.accounts.*",
      "properties": {
        "dynamicMode": {
          "description": "Plugin-specific mode toggle.",
          "type": "string",
          "enumValues": ["strict", "relaxed"],
          "examples": ["strict"],
          "defaultValue": "strict"
        }
      }
    }
  ]
}
```

## Recommended Validation Workflow After Config Changes

1. Update settings.
2. Run `OpenClaw: Refresh Schema Now`.
3. Run `OpenClaw: Show Schema Status`.
4. Confirm expected policy and source values.

## Related Guides

- Command usage details: [`commands.md`](./commands.md)
- Troubleshooting blocked policy and sync issues: [`troubleshooting.md`](./troubleshooting.md)
