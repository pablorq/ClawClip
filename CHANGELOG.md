# Changelog

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
