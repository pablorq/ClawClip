# paperclip-openclaw-bridge

Third-party Paperclip adapter for connecting Paperclip to OpenClaw over the Gateway WebSocket protocol.

This package exists as a pragmatic external adapter path while Paperclip's built-in OpenClaw adapter remains unreliable for strict OpenClaw gateway deployments.

## What it changes

- Uses a distinct Paperclip adapter type: `openclaw_bridge`
- Keeps the familiar OpenClaw Gateway transport and config surface
- **Never sends a root-level `paperclip` key** in outbound OpenClaw `agent` requests
- Preserves Paperclip wake context by embedding it in the rendered `message` payload instead

That last point matters because current OpenClaw gateway validation rejects unknown top-level params with errors like:

```text
invalid agent params: at root: unexpected property 'paperclip'
```

## Install in Paperclip

### Option 1: install from npm

```bash
curl -X POST http://localhost:3102/api/adapters/install \
  -H "Authorization: Bearer <paperclip-token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-openclaw-bridge"}'
```

### Option 2: install from local path

Useful for self-hosted testing before npm publish:

```bash
curl -X POST http://localhost:3102/api/adapters/install \
  -H "Authorization: Bearer <paperclip-token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"/absolute/path/to/paperclip-openclaw-bridge","isLocalPath":true}'
```

## Configure an agent

In recent versions, Paperclip renders adapter-specific form fields for this external adapter automatically.

Use adapter type `openclaw_bridge`.

> [!NOTE]
> **Authentication Upgrade:** As of v0.2.0, the bridge securely injects an ephemeral Paperclip JWT token into the OpenClaw agent's environment automatically. You do not need to share or mount a static API key on the filesystem.

### Recommended self-hosted configuration

This is the known-good shape for a self-hosted Paperclip agent such as Ari connecting to an OpenClaw gateway that enforces device auth:

```json
{
  "url": "wss://openclaw-gateway.example.com",
  "authToken": "<gateway-auth-token>",
  "password": "",
  "role": "operator",
  "scopes": [
    "operator.admin",
    "operator.pairing",
    "operator.approvals",
    "operator.read",
    "operator.write"
  ],
  "devicePrivateKeyPem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
  "deviceFamily": "paperclip-openclaw-bridge",
  "disableDeviceAuth": false,
  "timeoutSec": 120,
  "waitTimeoutMs": 180000,
  "sessionKeyStrategy": "fixed",
  "sessionKey": "paperclip",
  "clientId": "gateway-client",
  "clientMode": "backend",
  "clientVersion": "",
  "autoPairOnFirstConnect": true,
  "paperclipApiUrl": "https://paperclip.example.com",
  "enableSkillSync": true
}
```

Equivalent Paperclip UI fields:

- **Gateway WebSocket URL**: `url`
- **Gateway auth token**: `authToken`
- **Gateway password**: `password`
- **Gateway role**: `role`
- **Gateway scopes**: `scopes`
- **Device private key PEM**: `devicePrivateKeyPem`
- **Device family**: `deviceFamily`
- **Disable device auth**: `disableDeviceAuth`
- **Timeout (seconds)**: `timeoutSec`
- **Wait timeout (ms)**: `waitTimeoutMs`
- **Session key strategy**: `sessionKeyStrategy`
- **Fixed session key**: `sessionKey`
- **Gateway client id**: `clientId`
- **Gateway client mode**: `clientMode`
- **Gateway client version**: `clientVersion`
- **Auto-pair on first connect**: `autoPairOnFirstConnect`
- **Paperclip API URL**: `paperclipApiUrl`
- **Skill Sync**: `enableSkillSync`

### Field reference

#### `url` / Gateway WebSocket URL

Required. The OpenClaw gateway WebSocket endpoint.

Examples:

- `ws://127.0.0.1:18789`
- `wss://openclaw-gateway.example.com`

#### `authToken` / Gateway auth token

Optional shared gateway token. When set, the adapter sends it as gateway authorization.

Treat this as a secret. Rotate it if it is pasted into chat, logs, screenshots, or issue comments.

#### `password` / Gateway password

Optional gateway password for deployments that use password auth instead of, or in addition to, token auth.

#### `role` / Gateway role

Defaults to `operator`. Most Paperclip-to-OpenClaw deployments should keep this value.

#### `scopes` / Gateway scopes

Comma-separated string in the UI, or an array in raw JSON.

Recommended broad operator set for self-hosted agent execution:

```text
operator.admin, operator.pairing, operator.approvals, operator.read, operator.write
```

Notes:

- `operator.admin` is the broad operator capability used by normal gateway agent execution.
- `operator.pairing` is required for automatic device-pair approval.
- The gateway token must be allowed to use the scopes you request. Adding a scope in Paperclip does not grant it if the gateway policy rejects that scope.
- If automatic pairing fails with `missing scope: operator.pairing`, either the scope is absent from config or the gateway token/policy does not allow that scope.

#### `devicePrivateKeyPem` / Device private key PEM

Strongly recommended for device-auth deployments.

Paste a dedicated Ed25519 private key PEM, including the header and footer:

```text
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

The bridge derives a stable OpenClaw `deviceId` from this key. Without it, the adapter generates an ephemeral key on each run, so every heartbeat can look like a new unapproved device.

Generate a dedicated key for each Paperclip agent. Do not reuse SSH keys.

Persistent key generation example:

```bash
mkdir -p ~/.openclaw/device-keys
chmod 700 ~/.openclaw ~/.openclaw/device-keys

openssl genpkey -algorithm Ed25519 \
  -out ~/.openclaw/device-keys/ari-paperclip-openclaw-device-private.pem
chmod 600 ~/.openclaw/device-keys/ari-paperclip-openclaw-device-private.pem

cat ~/.openclaw/device-keys/ari-paperclip-openclaw-device-private.pem
```

Keep the file as a recovery copy, but the runtime uses the value persisted in Paperclip's `adapterConfig.devicePrivateKeyPem`.

#### `deviceFamily` / Device family

Optional label sent with device-auth pairing requests. Defaults to `paperclip-openclaw-bridge`.

Use a stable, recognizable value so pending devices are easier to identify in OpenClaw.

#### `disableDeviceAuth` / Disable device auth

Defaults to `false`.

Keep this off for normal secured gateways. Only turn it on if the target gateway explicitly does not require signed device authentication.

#### `timeoutSec` / Timeout (seconds)

Overall adapter execution timeout in seconds. Default: `120`.

#### `waitTimeoutMs` / Wait timeout (ms)

How long the adapter waits for the OpenClaw run to finish after the gateway accepts it. Default: `120000`.

Use a higher value such as `180000` for slower heartbeat or issue execution paths.

#### `sessionKeyStrategy` / Session key strategy

Controls OpenClaw session continuity.

Supported values:

- `issue`: one OpenClaw session per Paperclip issue. Good default for issue-driven work.
- `fixed`: one shared OpenClaw session for the agent. Useful for a single persistent agent identity like Ari.
- `run`: new session per Paperclip run. Most isolated, least continuity.

#### `sessionKey` / Fixed session key

Only used when `sessionKeyStrategy` is `fixed`.

Example:

```text
paperclip
```

The bridge prefixes session keys with agent routing where appropriate, so keep this short and stable.

#### `clientId` / Gateway client id

Defaults to `gateway-client`. Usually safe to leave unchanged.

#### `clientMode` / Gateway client mode

Defaults to `backend`. Usually safe to leave unchanged for Paperclip.

#### `clientVersion` / Gateway client version

Optional custom client version string sent during gateway connect. Leave blank unless you need to distinguish a custom deployment.

#### `autoPairOnFirstConnect` / Auto-pair on first connect

Defaults to `true`.

When enabled, the bridge tries one automatic pair/approve round if the gateway reports that device pairing is required.

This only works when:

1. `devicePrivateKeyPem` is stable, and
2. requested scopes include `operator.pairing`, and
3. the gateway token/policy actually allows `operator.pairing`.

If auto-pairing is unavailable, manually approve the pending OpenClaw device once. With a stable `devicePrivateKeyPem`, future heartbeats should reuse the same approved device.

#### `paperclipApiUrl` / Paperclip API URL

Optional absolute Paperclip base URL included in wake text and runtime context.

Example:

```text
https://paperclip.example.com
```

#### `enableSkillSync` / Skill Sync

Defaults to `true`.

A boolean configuration switch that toggles the Paperclip-to-OpenClaw pre-flight **Comprehensive Skill Synchronization Protocol**.
- When **enabled** (`true`), the bridge will automatically verify and synchronize local skills to the remote agent before execution.
- When **disabled** (`false`), the bridge will bypass pre-flight synchronization entirely to optimize latency in pre-seeded or high-security environments.

## Skill Synchronization Protocol

Starting with `v0.3.0`, the bridge features a **Comprehensive Skill Synchronization Protocol** to align the remote agent's skills environment with Paperclip's local skill repository.

### High-Level Workflow
1. **Fast-Path Verification**: The bridge computes a local aggregate hash representing all required skills. It then performs a single remote check to verify if the remote skills match. If matching, synchronization completes **instantly** (Fast-Path).
2. **Atomic Fallback Sync**: On checksum mismatch, the bridge falls back to a single **ZIP Injection**. It bundles the skills into a compressed package, uploads it as a single binary attachment, and instructs the agent to unpack and groom the destination folder (deleting old/obsolete folders).
3. **Continuous Convergence**: The process retries up to 3 times to guarantee absolute environment alignment.

For more details, see [doc/Skills Sync Protocol.md](doc/Skills%20Sync%20Protocol.md).

## Device-auth troubleshooting

### `pairing required: device is not approved yet`

The gateway requires device approval. Approve the pending device in OpenClaw, then retry.

If this happens repeatedly after approval, check that `devicePrivateKeyPem` is set and stable. Repeated approvals usually mean the adapter is generating a new ephemeral device identity every run.

### `auto-pairing failed: missing scope: operator.pairing`

The bridge attempted automatic pairing, but the gateway rejected the pairing scope.

Check both sides:

1. Paperclip adapter config includes `operator.pairing` in `scopes`.
2. The gateway token/policy allows `operator.pairing`.

Manual approval can still work without auto-pairing if `devicePrivateKeyPem` is stable.

### The `devicePrivateKeyPem` field does not appear in Paperclip

Make sure Paperclip is running a bridge package version that includes the field, then restart the Paperclip server if the schema remains stale.

Useful checks:

```bash
npm view paperclip-openclaw-bridge version
curl -H "Authorization: Bearer <paperclip-token>" \
  https://paperclip.example.com/api/adapters/openclaw_bridge/config-schema
```

The schema should include `devicePrivateKeyPem` with type `textarea`.

## Development

```bash
npm install
npm run typecheck
npm run test
npm run build
```

## Release and publish

This repo uses **Changesets** for semver decisions, changelog generation, and npm publishing.

### Day-to-day flow

1. Open a PR with code changes
2. Add a changeset with `npx changeset` if the change should ship
3. Merge the PR to `main`
4. GitHub Actions automatically opens or updates a release PR
5. When that release PR is merged, GitHub Actions publishes the package to npm automatically

### Versioning rules

- `patch` for fixes and low-risk behavior corrections
- `minor` for backward-compatible features
- `major` for breaking changes

### Prereleases

If we want preview builds, we can cut prerelease versions such as `0.2.0-beta.1` through Changesets and publish them under a non-default npm dist-tag when needed.

### Merge strategy

Recommended default: **squash merge PRs into `main`**.

That keeps `main` readable while still preserving the full small-commit history inside each PR branch and PR timeline.

### Commit style

Use conventional-commit style when practical (`fix:`, `feat:`, `chore:`), but Changesets — not commit parsing — is the source of truth for version bumps and changelog entries.

## Package contract

This package exports:

- `.` → root metadata + `createServerAdapter()`
- `./server` → server adapter entrypoints
- `./ui` → helper UI exports
- `./cli` → CLI output formatter
- `./ui-parser` → self-contained Paperclip dynamic UI parser

## License

MIT
