import { createServerAdapter } from "./server/adapter.js";

export const type = "openclaw_bridge";
export const label = "OpenClaw Bridge";

export const models: { id: string; label: string }[] = [];

export const manifest = {
  id: "paperclip-openclaw-bridge",
  name: label,
  description: "Third-party Paperclip adapter for OpenClaw Gateway",
  adapters: [
    {
      type,
      label,
      models,
    },
  ],
};

export const agentConfigurationDoc = `# openclaw_bridge agent configuration

Adapter: openclaw_bridge

Use when:
- You want Paperclip to invoke OpenClaw over the Gateway WebSocket protocol.
- You want native gateway auth/connect semantics instead of HTTP /v1/responses or /hooks/*.
- You want a standalone third-party adapter package instead of Paperclip's built-in OpenClaw adapter.

Don't use when:
- You only expose OpenClaw HTTP endpoints.
- Your deployment does not permit outbound WebSocket access from the Paperclip server.

Core fields:
- url (string, required): OpenClaw gateway WebSocket URL (ws:// or wss://)
- headers (object, optional): handshake headers; supports x-openclaw-token / x-openclaw-auth
- authToken (string, optional): shared gateway token override
- password (string, optional): gateway shared password, if configured

Gateway connect identity fields:
- clientId (string, optional): gateway client id (default gateway-client)
- clientMode (string, optional): gateway client mode (default backend)
- clientVersion (string, optional): client version string
- role (string, optional): gateway role (default operator)
- scopes (string[] | comma string, optional): gateway scopes (default ["operator.admin", "operator.pairing"]); the gateway token must also be allowed to use requested scopes
- devicePrivateKeyPem (string, recommended): dedicated Ed25519 private key PEM used for stable device identity across heartbeats
- deviceFamily (string, optional): label sent with device-auth pairing requests (default paperclip-openclaw-bridge)
- disableDeviceAuth (boolean, optional): disable signed device payload in connect params (default false)

Request behavior fields:
- payloadTemplate (object, optional): additional fields merged into gateway agent params
- workspaceRuntime (object, optional): reserved workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- timeoutSec (number, optional): adapter timeout in seconds (default 120)
- waitTimeoutMs (number, optional): agent.wait timeout override (default timeoutSec * 1000)
- autoPairOnFirstConnect (boolean, optional): on first "pairing required", attempt device.pair.list/device.pair.approve via shared auth, then retry once (default true)
- paperclipApiUrl (string, optional): absolute Paperclip base URL advertised in wake text

Session routing fields:
- sessionKeyStrategy (string, optional): issue (default), fixed, or run
- sessionKey (string, optional): fixed session key when strategy=fixed (default paperclip)

Compatibility note:
- This adapter intentionally strips any root-level paperclip field from outbound agent params because current OpenClaw gateway validation rejects unknown root keys.
- Paperclip wake context is still delivered in the rendered message payload.
`;

export { createServerAdapter } from "./server/adapter.js";
export default createServerAdapter();
