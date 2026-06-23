import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
export const type = "clawclip";
export const models: { id: string; label: string }[] = [];
export const agentConfigurationDoc = `# clawclip agent configuration

Adapter: clawclip

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
- deviceFamily (string, optional): label sent with device-auth pairing requests (default clawclip)
- disableDeviceAuth (boolean, optional): disable signed device payload in connect params (default false)

Request behavior fields:
- payloadTemplate (object, optional): additional fields merged into gateway agent params
- workspaceRuntime (object, optional): reserved workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- timeoutSec (number, optional): adapter timeout in seconds (default 120)
- waitTimeoutMs (number, optional): agent.wait timeout override (default timeoutSec * 1000)
- autoPairOnFirstConnect (boolean, optional): on first "pairing required", attempt device.pair.list/device.pair.approve via shared auth, then retry once (default true)
- enableSkillSync (boolean, optional): enable Skill synchronization before the main message (default false)
- paperclipApiUrl (string, optional): absolute Paperclip base URL advertised in wake text

Session routing fields:
- sessionKeyStrategy (string, optional): issue (default), fixed, or run
- sessionKey (string, optional): fixed session key when strategy=fixed (default paperclip)

Compatibility note:
- This adapter intentionally strips any root-level paperclip field from outbound agent params because current OpenClaw gateway validation rejects unknown root keys.
- Paperclip wake context is still delivered in the rendered message payload.
`;
import { execute } from "./execute.js";
import {
  listBridgeSkills,
  syncBridgeSkills,
} from "./skills.js";
import {
  type AdapterSkillContext,
  type AdapterSkillSnapshot,
} from "./skill-compat.js";
import { testEnvironment } from "./test.js";

export function resolvePaperclipHomeDir(): string {
  const raw = process.env.PAPERCLIP_HOME?.trim();
  if (raw) {
    if (raw === "~") return os.homedir();
    if (raw.startsWith("~/")) return path.resolve(os.homedir(), raw.slice(2));
    return path.resolve(raw);
  }
  return path.resolve(os.homedir(), ".paperclip");
}

export function getClawclipDataDir(): string {
  return path.join(resolvePaperclipHomeDir(), "clawclip");
}

export function ensureClawclipDataDir(): string {
  const dir = getClawclipDataDir();
  if (!fsSync.existsSync(dir)) {
    fsSync.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getDeviceKeyPath(url: string, authToken: string): string {
  const normalizedUrl = url.trim().toLowerCase();
  const normalizedToken = authToken.trim();
  const hash = crypto.createHash("sha256").update(`${normalizedUrl}|${normalizedToken}`).digest("hex");
  return path.join(getClawclipDataDir(), `device-key-${hash}.pem`);
}

export function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

type ConfigFieldSchema = {
  key: string;
  label: string;
  type: "text" | "select" | "toggle" | "number" | "textarea" | "combobox";
  options?: Array<{ value: string; label: string }>;
  default?: unknown;
  hint?: string;
  required?: boolean;
};

type AdapterConfigSchema = {
  fields: ConfigFieldSchema[];
};

type ExtendedServerAdapterModule = ServerAdapterModule & {
  getConfigSchema: () => AdapterConfigSchema;
  supportsInstructionsBundle: boolean;
  instructionsPathKey: string;
  listSkills: (ctx: AdapterSkillContext) => Promise<AdapterSkillSnapshot>;
  syncSkills: (ctx: AdapterSkillContext, desiredSkills: string[]) => Promise<AdapterSkillSnapshot>;
};


const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: "url",
      label: "Gateway WebSocket URL",
      type: "text",
      required: true,
      hint: "Required. Example: ws://127.0.0.1:18789 or wss://gateway.example.com",
    },
    {
      key: "authToken",
      label: "Gateway auth token",
      type: "text",
      hint: "Optional shared gateway token. Stored in adapterConfig.authToken.",
    },
    {
      key: "password",
      label: "Gateway password",
      type: "text",
      hint: "Optional shared gateway password when the gateway is password-protected.",
    },
    {
      key: "role",
      label: "Gateway role",
      type: "text",
      default: "operator",
      hint: "Usually operator.",
    },
    {
      key: "scopes",
      label: "Gateway scopes",
      type: "text",
      default: "operator.admin,operator.pairing",
      hint: "Comma-separated scopes. Include operator.pairing if you want automatic device-pair approval; the gateway token must also be allowed to use that scope.",
    },
    {
      key: "deviceFamily",
      label: "Device family",
      type: "text",
      default: "clawclip",
      hint: "Optional label sent with device-auth pairing requests.",
    },
    {
      key: "disableDeviceAuth",
      label: "Disable device auth",
      type: "toggle",
      default: false,
      hint: "Turn on only if you want to skip signed device auth in gateway connect params.",
    },
    {
      key: "timeoutSec",
      label: "Timeout (seconds)",
      type: "number",
      default: 120,
    },
    {
      key: "waitTimeoutMs",
      label: "Wait timeout (ms)",
      type: "number",
      default: 120000,
    },
    {
      key: "sessionKeyStrategy",
      label: "Session key strategy",
      type: "select",
      default: "issue",
      options: [
        { value: "issue", label: "issue" },
        { value: "fixed", label: "fixed" },
        { value: "run", label: "run" },
      ],
      hint: "Use issue for per-issue continuity, fixed for one shared session, or run for fully isolated runs.",
    },
    {
      key: "sessionKey",
      label: "Fixed session key",
      type: "text",
      hint: "Optional. Only used when sessionKeyStrategy=fixed.",
    },
    {
      key: "clientId",
      label: "Gateway client id",
      type: "text",
      default: "gateway-client",
    },
    {
      key: "clientMode",
      label: "Gateway client mode",
      type: "text",
      default: "backend",
    },
    {
      key: "clientVersion",
      label: "Gateway client version",
      type: "text",
      hint: "Optional custom client version string sent during connect.",
    },
    {
      key: "resetOpenclawPairing",
      label: "Reset Openclaw Pairing",
      type: "toggle",
      default: false,
      hint: "Deletes the stored pairing data of this OpenClaw instance to reset pairing.",
    },
    {
      key: "understandResetPairing",
      label: "I understand what I'm doing",
      type: "toggle",
      default: false,
      hint: "Check this to authorize resetting the pairing.",
    },
    {
      key: "enableSkillSync",
      label: "Skill Sync",
      type: "toggle",
      default: false,
      hint: "Enable Skill synchronization before the main message.",
    },
    {
      key: "paperclipApiUrl",
      label: "Paperclip API URL",
      type: "text",
      hint: "Optional absolute Paperclip base URL to include in wake text.",
    },
  ],
};

export function createServerAdapter(): ExtendedServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    listSkills: listBridgeSkills,
    syncSkills: syncBridgeSkills,
    models,
    getConfigSchema: () => configSchema,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    agentConfigurationDoc,
  };
}

