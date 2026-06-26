import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
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
- authToken (string, required): shared gateway token

Request behavior fields:
- payloadTemplate (object, optional): additional fields merged into gateway agent params
- workspaceRuntime (object, optional): reserved workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats
- timeoutSec (number, optional): adapter timeout in seconds (default 300)
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
      required: true,
      hint: "Required. Gateway auth token.",
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
      hint: "Optional. Only used when 'Session key strategy' is set to 'fixed'.",
    },
    {
      key: "enableSkillSync",
      label: "Enable Skill Sync",
      type: "toggle",
      default: false,
      hint: "Enable skill synchronization from Paperclip to Openclaw. Use only when skills were changed in Paperclip. Keep disabled to speed up the agent response.",
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
      key: "paperclipApiUrl",
      label: "Paperclip API URL",
      type: "text",
      hint: "Required. The absolute Paperclip base URL to include in wake text. It must be reachable from the OpenClaw gateway.",
    },
    {
      key: "debug",
      label: "Enable Debug Mode",
      type: "toggle",
      default: false,
      hint: "Enable debug logging for the ClawClip adapter and WebSocket gateway.",
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

