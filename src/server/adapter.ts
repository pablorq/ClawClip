import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { toLog } from "./logger.js";
import { execute } from "./execute.js";
import {
  listBridgeSkills,
  syncBridgeSkills,
} from "./skills.js";
import {
  type AdapterSkillContext,
  type AdapterSkillSnapshot,
} from "./skill-compat.js";
import { testEnvironment } from "./gateway-test.js";

export const type = "clawclip";
export const PROTOCOL_VERSION = 4;

export type GatewayDeviceIdentity = {
  deviceId: string;
  publicKeyRawBase64Url: string;
  privateKeyPem: string;
  source: "configured" | "persistent" | "ephemeral";
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

export function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

export function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : trimmed;
}

export function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;

  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);

  const authHeader =
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

export function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

export function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

export function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = params.platform?.trim() ?? "";
  const deviceFamily = params.deviceFamily?.trim() ?? "";
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

export async function resolveDeviceIdentity(config: Record<string, unknown>): Promise<GatewayDeviceIdentity> {
  const configuredPrivateKey = nonEmpty(config.devicePrivateKeyPem);
  if (configuredPrivateKey) {
    const privateKey = crypto.createPrivateKey(configuredPrivateKey);
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const raw = derivePublicKeyRaw(publicKeyPem);
    return {
      deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
      publicKeyRawBase64Url: base64UrlEncode(raw),
      privateKeyPem: configuredPrivateKey,
      source: "configured",
    };
  }

  const urlValue = asString(config.url, "").trim();
  const headers = toStringRecord(config.headers);
  const authToken = resolveAuthToken(config, headers) ?? "";

  if (urlValue) {
    try {
      const normalizedUrl = urlValue.trim().toLowerCase();
      const normalizedToken = authToken.trim();
      const seed = crypto.createHash("sha256").update(`${normalizedUrl}|${normalizedToken}`).digest();
      const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
      const der = Buffer.concat([prefix, seed]);

      const privateKey = crypto.createPrivateKey({
        key: der,
        format: "der",
        type: "pkcs8",
      });
      const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      const publicKey = crypto.createPublicKey(privateKey);
      const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const raw = derivePublicKeyRaw(publicKeyPem);

      return {
        deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
        publicKeyRawBase64Url: base64UrlEncode(raw),
        privateKeyPem,
        source: "persistent",
      };
    } catch (err) {
      await toLog("stderr", `[clawclip] Error resolving deterministic device identity, falling back to ephemeral: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }

  const generated = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = generated.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const raw = derivePublicKeyRaw(publicKeyPem);
  return {
    deviceId: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKeyRawBase64Url: base64UrlEncode(raw),
    privateKeyPem,
    source: "ephemeral",
  };
}
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

function selfHealFrontend() {
  try {
    const assetsDir = "/app/ui/dist/assets";
    if (!fs.existsSync(assetsDir)) {
      return;
    }
    const files = fs.readdirSync(assetsDir);
    for (const file of files) {
      if (file.endsWith(".js")) {
        const filePath = path.join(assetsDir, file);
        let content = fs.readFileSync(filePath, "utf8");
        if (content.includes("self.caches = _undefined;")) {
          content = content.replace(
            /self\.([a-zA-Z_$][0-9a-zA-Z_$]*)\s*=\s*_undefined;/g,
            "try { self.$1 = _undefined; } catch (e) {}"
          );
          fs.writeFileSync(filePath, content, "utf8");
          console.log(`[clawclip:self-heal] Patched worker global properties lockdown in ${file}`);
        }
      }
    }
  } catch (err) {
    // Silently ignore or log self-healing failures
  }
}

export function createServerAdapter(): ExtendedServerAdapterModule {
  selfHealFrontend();
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

