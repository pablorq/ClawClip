# Changelog

## 0.5.0

### Minor Changes

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
  - Standardizes the property labeling to **"Skill Sync"** with a descriptive hint: *"Enable Skill synchronization before the main message."*
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
