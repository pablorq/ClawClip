# Changelog

## 260626.9

### Patch Changes

- **fix(self-heal): resolve dynamic UI asset paths and log errors**
  - Replace the hardcoded Docker-only `/app/ui/dist/assets` path with a candidate search helper (`findAssetsDir`).
  - Traverse `process.cwd()` and `process.argv[1]` parent folders to locate the UI dist assets folder when running in a local host or custom path layout.
  - Catch file reading and writing exceptions in `selfHealFrontend` and log them at the warning level (prefixed with `[DEBUG]`) to prevent silent failures.

## 260626.8

### Patch Changes

- **refactor(gateway): remove key source property from GatewayDeviceIdentity**
  - Remove `source` field from `GatewayDeviceIdentity` type definition in `adapter.ts`.
  - Omit `source` from all returned identity values in `resolveDeviceIdentity`.
  - Update debug logging in `execute.ts` to log `deviceId` directly without `keySource`.
  - Update corresponding unit test in `execute.test.ts` to assert against the updated log string.

## 260626.7

### Patch Changes

- **feat(clawclip): support signed device challenge in test probe & rename to gateway-test.ts**
  - Rename src/server/test.ts to src/server/gateway-test.ts to clarify it contains runtime code.
  - Extract device auth/config helper utilities from execute.ts to adapter.ts to share them.
  - Import shared helpers in execute.ts and gateway-test.ts, removing duplicated local copies.
  - Update testEnvironment and probeGateway to resolve device identity and build signed device challenge parameters.
  - Change non-loopback plaintext ws URL check warning level to info.
  - Add unit test verifying that testEnvironment successfully handles a connect challenge.

## 260626.6

### Patch Changes

- **feat(clawclip): support local_trusted cancellation, timeout coherence, and skill sync logging**
  - Register cancellation check interval unconditionally in execute.ts to support local/dev environments without JWT secrets.
  - Conditionally add Authorization header in checkRunCancelled to prevent Express auth middleware rejection in local_trusted mode.
  - Change timeout log and error messages from milliseconds to seconds (s) to match configured values in Board UI.
  - Emit a single system message log '[clawclip] Starting Skill Sync process...' at the start of syncPaperclipSkills.
  - Add unit tests for cancellation handling and skill sync system message logging.

## 260626.5

### Patch Changes

- **feat(server): immediately abort OpenClaw session when Paperclip run is cancelled**
  - Adds in-process REST API polling (every 3s) using local agent JWT to check for run cancellation.
  - Implements GatewayWsClient.abort() to immediately reject pending agent.wait requests and close the WebSocket.
  - Propagates cancellation to OpenClaw via chat.abort RPC request.
  - Properly handles error propagation, ensures the cleanup of polling intervals, and returns clean cancellation status code.

## 260626.4

### Patch Changes

- **fix(ui-parser): resolve command execution stdout duplication leak**
  - Map "exec" tool call inputs to an object structure containing a `command` string to satisfy the `isCommandTool` check in Paperclip.
  - Ignore "end" phase events for the "command_output" stream, restricting output emission strictly to "delta" phase to avoid duplicate stdout logs.
  - Update unit tests in ui-parser.test.ts to verify the updated mapping and ignored end phase.

## 260626.3

### Patch Changes

- **feat(ui-parser): implement structured Board UI transcript parser with self-healing sandbox worker fix**
  - Add regex-based self-healing routine to scan and patch all JS assets in the container to wrap worker global lockdown assignments in try-catch blocks, preventing TypeErrors on getter-only properties (e.g., caches, indexedDB) in strict mode.
  - Implement ui-parser.ts to translate raw [clawclip:event] streams to structured TranscriptEntry items (system banners, assistant markdown bubbles, and collapsible tool/command cards).
  - Configure package.json and tsconfig.ui-parser.json to compile the parser separately as expected by Paperclip.
  - Add comprehensive unit test suite in test/ui-parser.test.ts.
  - Normalize and reduce debug verbosity across server logs.

## 260626.2

### Patch Changes

- **feat(wait): detect and report OpenClaw connection aborts as transient failures**
  - Monitors the lifecycle event stream for phase cancellation and abort signals.
  - Inspects wait payload status, summaries, and error properties for aborted flags.
  - Maps aborted gateway runs to exitCode 1, timedOut false, clawclip_connection_aborted errorCode, and transient_upstream errorFamily.
  - Updates catch handler within wait loop to only abort reconnect immediately on ECONNREFUSED or aborted exceptions, keeping generic drops retryable.
  - Adds vitest unit tests covering wait payload aborts, lifecycle abort events, and abrupt socket terminations.

## 260626.1

### Patch Changes

- **feat(pairing): replace filesystem-based key storage with deterministic in-memory Ed25519 keys**
  - Derives Ed25519 private keys deterministically from the Gateway URL and Session/Auth Token.
  - Prepend the ASN.1 Ed25519 header (302e020100300506032b657004220420) to a SHA-256 hashed seed for on-the-fly PKCS#8 DER private key instantiation.
  - Removes local file storage under ~/.paperclip/clawclip.
  - Removes the resetOpenclawPairing and understandResetPairing configuration settings and associated REST PATCH logic.
  - Updates unit tests to verify deterministic key resolution without disk I/O.

## 260626

### Patch Changes

- **Release 260626**
  - Simplify config schema by removing redundant protocol fields and adopting a dated versioning format.
  - Automate persistent Ed25519 key generation to ~/.paperclip/clawclip/ to retain stable device pairing.
  - Use a typed AsyncLocalStorage LoggerContext to fix unsafe log callback mutations and support debug mode.
  - Correct false-positive FATAL logs on normal ws closes, secure key file modes to 0o600, and unify timeout units.
  - Create a GitHub Actions publish workflow to automate npm releases with validation checks and permissions.

## 260625.4

### Patch Changes

- **fix(execute): log warning on unreachable Paperclip API during pairing reset**
  - Add warning log when resolvePaperclipApiUrl(ctx) or ctx.authToken is unavailable during automatic pairing reset toggle clearance.
  - This prevents the silent skip of toggle reset that leads to an endless device re-pairing loop, informing the user to manually disable the switches in their adapter configuration.
  - Includes a unit test verifying warning output on missing API credentials.

## 260625.3

### Patch Changes

- **fix(server): prevent false positive FATAL logs on normal WebSocket closure**
  - Detect client-initiated shutdowns in execute.ts by checking if this.ws is null when the close event fires. For intentional closes, log normally to stdout without triggering failPending or rejectChallenge callbacks.
  - Unexpected closes continue to log as ERROR/FATAL to stderr.

## 260625.2

### Patch Changes

- **fix: resolve unsafe ctx.onLog mutation side-effect**
  - Define a strictly typed `LoggerContext` interface containing both `onLog` and `debug` fields in `src/server/logger.ts`.
  - Refactor `logContextStorage` to be a single `AsyncLocalStorage<LoggerContext>` instance, avoiding nested storage contexts.
  - Update `execute()` in `src/server/execute.ts` to enter log context with a unified `{ onLog, debug }` object.
  - Update `GatewayWsClient` and unit tests in `test/logger.test.ts` to utilize the new structured `LoggerContext` context.

## 260625.1

### Patch Changes

- **fix: log device identity resolution filesystem errors**
  - Convert `resolveDeviceIdentity` into an asynchronous function.
  - Await `toLog` inside the `catch` block of `resolveDeviceIdentity` to log filesystem/permission errors to `stderr` in a single line.
  - Update `execute()` to await `resolveDeviceIdentity`.
  - Add a unit test in `test/execute.test.ts` mocking a filesystem error to verify the fallback and logging.

## 260625

### Patch Changes

- **chore(release): transition to dated versioning with release 260625**
  - Simplified device pairing by introducing automatic, persistent device key generation and options to reset pairing state.
  - Streamlined adapter configuration schema by removing redundant protocol-level settings, enforcing mandatory device signatures, and deprecating password authentication.
  - Aligned remote execution timeout settings with Paperclip core configurations to ensure unified timeout management.
  - Improved logging and debugging capabilities by preventing WebSocket message truncation, adding a configurable debug toggle, and capturing raw gateway connection messages when debug mode is enabled.

## 0.5.13

### Patch Changes

- **fix(logging): resolve WebSocket log truncation and add configurable debug switch**:
  - Capture and preserve AsyncLocalStorage context inside WebSocket event listeners (message, close, error).
  - Change client.close() to be asynchronous to await the close handshake and any pending event handlers.
  - Add 'debug' toggle configuration option to configSchema in adapter.ts.
  - Parse 'debug' option dynamically during execution and decorate ctx.onLog.
  - Set default logger debug mode to false.
  - Add unit test for context-sensitive debug logging logic.

## 0.5.12

### Patch Changes

- **refactor: unify timeout config and fix RPC parameter unit mismatch**:
  - Remove redundant `timeoutSec` and `waitTimeoutMs` from the adapter's configuration schema (`adapter.ts`) to rely on Paperclip core's default `timeoutSec` field.
  - Set default execution timeout fallback value to 300 seconds.
  - Correctly pass `timeoutSec` (seconds) instead of milliseconds to `agentParams.timeout` when requesting remote execution.
  - Refactor the execution wait loop in `execute.ts` to use a single unified `timeoutMs` (derived from `timeoutSec * 1000`) instead of `waitTimeoutMs`.
  - Adjust creation presets in `build-config.ts` and update Vitest cases in `execute.test.ts` to align with the new schema structure.

## 0.5.11

### Patch Changes

- **refactor: simplify gateway config schema and remove password auth**:
  - Remove redundant and protocol-level configuration fields from the adapter's UI schema (`password`, `role`, `scopes`, `deviceFamily`, `clientId`, `clientMode`, `clientVersion`).
  - Mark `authToken` as a required configuration field.
  - Hardcode internal defaults for client registration params to ensure stable OpenClaw gateway connection compliance (e.g., role="operator", mode="backend", scopes=["operator.admin", "operator.pairing"]).
  - Completely remove the unused and unsupported `password` auth logic from execution (`execute.ts`) and environment tests (`test.ts`).
  - Remove the `disableDeviceAuth` field, its UI schema, and related conditional bypass logic, making device authentication signatures mandatory.
  - Update vitest suites to align with configuration schema changes.

## 0.5.10

### Patch Changes

- **feat: simplify device pairing and add persistent key generation**:
  - Remove manual "Device private key PEM" textarea and "Auto-pair on first connect" toggle from configuration settings.
  - Implement automatic, persistent Ed25519 device key generation stored under `~/.paperclip/clawclip/device-key-<instanceHash>.pem`.
  - Add `resetOpenclawPairing` and `understandResetPairing` toggles to delete stored pairing keys.
  - Fix configuration PATCH payload to only send the pairing reset toggles, resolving `403 Forbidden` errors triggered by instructions bundle mutation checks.
  - Resolve package-level circular dependency by defining/exporting manifest variables from `adapter.ts`.
  - Update connectivity test pane and Vitest test suite assertions to support the new schema.

## 0.5.9

### Patch Changes

- **fix(server): remove redundant challenge log from handleMessage in GatewayWsClient (PR)**:
  - Remove the duplicate and premature log statement "[clawclip] Challenge received, sending hello..." from the connect.challenge event handler inside handleMessage().
  - Rely on the identical log statement inside connect() which is execution-safe and runs inside the proper AsyncLocalStorage log context binding zone.

## 0.5.8

### Patch Changes

- **fix(server): use anchored AGENT_ERROR sentinel to prevent false positive failures (PR)**:
  - Update system prompts in prompts.ts to instruct the agent to output `AGENT_ERROR: <last_error_message>` on its own line when the error loop guardrail triggers.
  - Update execute.ts to match the line-anchored regex `/^AGENT_ERROR:\s*(.+)/im` rather than globally scanning for "ERROR:".
  - Adjust tests in execute.test.ts and prompts.test.ts to expect the new sentinel.
  - Add a new integration test in execute.test.ts verifying that inline comments or code block log traces containing "error:" / "ERROR:" do not trigger failures.

## 0.5.7

### Patch Changes

- **fix(server): undefined skill sync defaults to false**:
  - Set the runtime fallback for `enableSkillSync` to `false` in `execute.ts` to align with the default configuration schema (`default: false`), disabling Skill Sync by default unless explicitly enabled.
  - Update `enableSkillSync` default documentation in `index.ts`.
  - Update and add corresponding test cases in `agent-manager.test.ts` and `execute.test.ts`.

## 0.5.6

### Patch Changes

- **fix(server): resolve workspace path resolution (PR)**:
  - Propagate resolved `companyBaseDir` from `ensureAgentAndSyncInstructions` to `execute()`.
  - Delay prompt construction, environment setup, and payload logging in `execute()` until after remote workspace provisioning is completed and the correct `companyBaseDir` is retrieved.
  - Extract `remoteWorkspaceRoot` correctly from `defaultAgentWorkspace` by locating `/workspace-paperclip/` to prevent double-nesting paths.

## 0.5.5

### Patch Changes

- **refactor(server): make logging concurrency-safe using AsyncLocalStorage (PR)**:
  - Introduced Node's native `AsyncLocalStorage` to isolate `onLog` handlers under concurrent `execute()` runs, preventing log cross-contamination when multiple tasks execute concurrently in the same process.
  - Created and exported `logContextStorage` in `src/server/logger.ts`.
  - Updated `toLog()` and `isDebugEnabled()` to query `logContextStorage.getStore()` first and fall back to the module global `activeOnLog`.
  - Wrapped the execution context of `execute()` inside `logContextStorage.run()`.
  - Added a concurrent log isolation unit test in `test/logger.test.ts`.

## 0.5.4

### Patch Changes

- **refactor(server): remove unused imports, dead constant, and dead checksum module (PR)**:
  - Cleaned up unused imports (`resolveDesiredSkills` and `calculateSkillChecksum`) and the unused `LOCAL_CHECKSUM_STORE` constant from `src/server/execute.ts`.
  - Removed the unused `crypto` import from `src/server/agent-manager.ts`.

## 0.5.3

### Patch Changes

- **refactor(server): remove unused imports, dead constant, and dead checksum module (PR)**:
  - Deleted `src/server/checksum.ts` as the hashing algorithm is no longer used and is incompatible with the sync protocol.

## 0.5.2

### Patch Changes

- **refactor(server): remove unused authToken parameter from buildCachingOptimizedPrompt (PR)**:
  - Cleaned up the `authToken` parameter from `buildCachingOptimizedPrompt` signature and destructuring block in `src/server/prompts.ts`.
  - Updated the invocation inside `src/server/execute.ts` to stop passing `authToken`.
  - Removed the parameter from all test invocations and deleted the obsolete token-splitting test in `test/prompts.test.ts`.
  - Removed `package-lock.json` from `.gitignore`.

## 0.5.1

### Patch Changes

- **fix(sync): align remote skill zip injection path with hidden skills directory (PR)**:
  - Corrected the target zip path inside `syncPaperclipSkills` to write to `.openclaw/skills/` (relative to home directory) instead of `openclaw/skills/` to match the target path used during multi-skill synchronization.

## 0.5.0

### Major Changes

- **Release - Comprehensive agent creation and synchronization**:
  - Decoupled `execute.ts` by splitting its logic into `agent-manager.ts` and `prompts.ts`, and unified all heartbeat, wake, and resume flows under a single caching-optimized prompt builder.
  - Partitioned agent environments into dedicated folders (`agents/<agentId>`) under the company directory, establishing a shared collaborative workspace at `<companyBaseDir>/main` injected into the execution context.
  - Introduced an in-memory `spawningMutex` to prevent race conditions during sandbox setup, and implemented a write-and-verify loop to programmatically register and inject session tokens via a protected `BOOTSTRAP.md` registry.
  - Added a 3-attempt convergence loop for instruction sync, robust WebSocket reconnection logic to handle transient dropouts, and strict environment/auth halting guardrails (e.g., halting after 3 consecutive auth failures).
  - Centralized logging logic under `logger.ts` to enforce a standard prefix format (`[TIMESTAMP] [source] [DEBUG]`), and normalized inline bridge log statements to be collapsed into single-line calls.

## 0.4.8

### Patch Changes

- **Normalize bridge logging calls inline**:
  - Standardized logging calls by prepending `[bridge]` or `[openclaw]` source tags.
  - Placed the `[DEBUG]` flag directly after the source tag.
  - Collapsed logging statements to single-line inputs and stripped trailing newlines.

## 0.4.7

### Patch Changes

- **Unify logging logic and format output in openclaw-bridge**:
  - Unified all logging methods into a centralized `logger.ts` model.
  - Standardized the output log format to the unified `[TIMESTAMP] [source] message` layout.
  - Enabled dynamic filtering of debug logs depending on debug mode.

## 0.4.6

### Patch Changes

- **Rename shared workspace to main and stabilize token setup and websocket reconnects**:
  - Added a 3-attempt write-and-verify loop when writing session tokens in `BOOTSTRAP.md`.
  - Integrated robust reconnection and wait retry logic in the websocket monitoring loop to withstand transient drops.

## 0.4.5

### Patch Changes

- **Implement mutex-protected session registry and token injection lifecycle**:
  - Introduced an in-memory `spawningMutex` to serialize remote sandbox provisioning and prevent workspace setup race conditions across concurrent spawns.
  - Implemented programmatic registration of the short-lived session token mappings (`runId` -> token) inside `BOOTSTRAP.md` via file RPCs (pruned to 20 entries).
  - Exempted `BOOTSTRAP.md` from smart reconciliation wipes to preserve the session registry.
  - Instructed the agent to extract the token via `grep` + `cut` in `BOOTSTRAP.md` and inject it in subsequent `exec` tool environment blocks.

## 0.4.4

### Patch Changes

- **Split isolated agent workspace and shared company workspace**:
  - Implemented company-scoped workspace partitioning to prevent file access conflicts.
  - Dedicated agent folders were nested at `agents/<agentId>` under the company directory.
  - A shared/collaborative workspace was established at `<companyBaseDir>/main` and injected as `PAPERCLIP_MAIN_WORKSPACE_DIR` into the runner context.
  - Added prompt instructions directing the agent to run all execution tasks in the main directory.

## 0.4.3

### Patch Changes

- **Add strict environment guardrails and unify caching-optimized prompts**:
  - Unified all heartbeat, wake, and resume prompt types under a single caching-optimized prompt builder.
  - Appended strict JSON environment variable guardrails (Literal & Unmodified, Direct Value Fallback constraints) in prompts.
  - Replaced stream regex-checks with a generalized `ERROR:` resilience loop guardrail in the execution engine.

## 0.4.2

### Patch Changes

- **Enhance instruction sync stability and add auth failure guardrails**:
  - Implemented a 3-attempt convergence loop in `syncPaperclipInstructions` to stabilize instructions sync instead of relying on a local cache.
  - Ensured selective cleanup of stale files in remote workspaces while protecting critical logs/state files like `MEMORY.md` and `IDENTITY.md`.
  - Added an authentication guardrail instructing remote agents to halt after 3 consecutive authentication errors.

## 0.4.1

### Patch Changes

- **Modularize execution architecture & implement robust sync/routing**:
  - Decoupled `execute.ts` by introducing two main files: `agent-manager.ts` (handling workspace paths and file sync orchestration) and `prompts.ts` (handling prompts compilation and cache optimization).
  - Wrapped `agents.create` in a try-catch block to handle existing agent scenarios gracefully.

## 0.4.0

### Minor Changes

- **Upgrade to Gateway WebSocket Protocol Version 4**:
  - Updates the bridge's internal protocol version to `4`.
  - Modifies communication frames to leverage low-level protocol advancements.
  - Negotiates handshakes with strict protocol version checks to prevent version mismatch fatals.
  - Refines authorization header formatting to enforce standardized JWT transmission structures.
  - Leverages strict log redactors to ensure high-security token isolation, preventing secrets from leaking in standard output logs during WebSocket handshakes.

## 0.3.1

### Patch Changes

- **Adapter Configuration: Skill Sync**:
  - Exposes a new boolean parameter inside the adapter's capabilities schema.
  - Standardizes the property labeling to **"Skill Sync"** with a descriptive hint: _"Enable Skill synchronization before the main message."_
  - Integrates directly with Paperclip's dynamic Agent Configuration UI, making the setting visible to operators on the agent edit screen.
  - Defaults to `true` to ensure backwards compatibility. When set to `false`, the bridge bypasses the entire skill synchronization phase, improving latency by skipping pre-flight checks and dropping directly into primary prompt execution.

## 0.3.0

### Minor Changes

- **Comprehensive Skill Synchronization Protocol**:
  - Introduces the **Comprehensive Skill Synchronization Protocol** between the Paperclip database/manifest system and remote OpenClaw agents.
  - **High-Performance Fast-Path Hashing (Aggregate Hashes)**: Implements a deterministic local aggregate hashing function that hashes the entire local skill list. Leverages a single remote execution check on the remote agent. If local and remote aggregate hashes match, synchronization resolves **instantly** (Fast-Path), saving bandwidth and execution overhead.
  - **Atomic Fallback Recovery (ZIP Injection)**: When a mismatch or absolute absence of remote skills is detected, the bridge falls back to an **Atomic ZIP Injection**, compressing all required skills into a single in-memory buffer, uploading it as a single binary attachment, and instructing the agent to unpack and atomically groom the remote skills directory (pruning old or obsolete skills).
  - **Stateless Event-Driven Stream Architecture (Session Key Tracking)**: Introduces a streamlined, live session key-driven event listener. Solves issues with OpenClaw agents running complex multi-step processes or spawning sub-runs (which generate dynamic child runs) by flawlessly capturing sync tokens without tracking dynamic run IDs since parent and child runs share the same session key.

## 0.2.0

### Minor Changes

- Transitioned the adapter to use secure, ephemeral JWT-based authentication (`supportsLocalAgentJwt`) instead of requiring a manually shared filesystem API key.
- Removed the deprecated `claimedApiKeyPath` configuration field. The Paperclip API key is now securely injected directly into the agent's environment variables.

## Project forked from paperclip-openclaw-bridge

## 0.1.4

### Patch Changes

- Expose adapter configuration fields in the Paperclip UI by enabling `supportsInstructionsBundle` capability.
- Update UI configuration builder to correctly merge schema-driven values (e.g., Gateway URL, roles).

## 0.1.3

### Patch Changes

- [#10](https://github.com/gregagi/paperclip-openclaw-bridge/pull/10) [`3a4c819`](https://github.com/gregagi/paperclip-openclaw-bridge/commit/3a4c819ada16e2ab99e648e63d673cdc7987db05) Thanks [@gregagi](https://github.com/gregagi)! - Align package metadata and root exports more closely with known external adapter examples by adding manifest metadata, a default adapter export, and explicit main/types entries.

- [#10](https://github.com/gregagi/paperclip-openclaw-bridge/pull/10) [`3a4c819`](https://github.com/gregagi/paperclip-openclaw-bridge/commit/3a4c819ada16e2ab99e648e63d673cdc7987db05) Thanks [@gregagi](https://github.com/gregagi)! - Expose stable device-auth configuration in the adapter schema, including `devicePrivateKeyPem`, and default requested scopes to include `operator.pairing` for auto-pairing flows.

## 0.1.2

### Patch Changes

- [#8](https://github.com/gregagi/paperclip-openclaw-bridge/pull/8) [`2fd2552`](https://github.com/gregagi/paperclip-openclaw-bridge/commit/2fd25523a12243b450b2d780d7c9674334e5440d) Thanks [@gregagi](https://github.com/gregagi)! - Align package metadata and root exports more closely with known external adapter examples by adding manifest metadata, a default adapter export, and explicit main/types entries.

## 0.1.1

### Patch Changes

- [#5](https://github.com/gregagi/paperclip-openclaw-bridge/pull/5) [`56e5439`](https://github.com/gregagi/paperclip-openclaw-bridge/commit/56e54391eab70e01715dd06cda9975e25cc28bab) Thanks [@gregagi](https://github.com/gregagi)! - Add an adapter config schema so Paperclip can render the required OpenClaw Bridge fields, including the gateway WebSocket URL, when creating or editing agents.

## Unreleased

- Switch release automation to Changesets-driven versioning and npm publishing
- Add CI on PRs and `main` so validation runs separately from publishing
- Document squash-merge + semver + changeset workflow for autonomous releases

## 0.1.0

- Initial standalone `openclaw_bridge` adapter package for Paperclip
- Forked from Paperclip's built-in OpenClaw gateway adapter surface
- Strips root-level `paperclip` params from outbound OpenClaw gateway requests
- Adds a regression test for strict OpenClaw gateway compatibility
