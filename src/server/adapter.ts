import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { agentConfigurationDoc, models, type } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

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
      key: "devicePrivateKeyPem",
      label: "Device private key PEM",
      type: "textarea",
      hint: "Paste a dedicated Ed25519 PRIVATE KEY PEM to keep the bridge device id stable across heartbeats. Generate with: openssl genpkey -algorithm Ed25519 -out ari-openclaw-device-key.pem",
    },
    {
      key: "deviceFamily",
      label: "Device family",
      type: "text",
      default: "paperclip-openclaw-bridge",
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
      key: "autoPairOnFirstConnect",
      label: "Auto-pair on first connect",
      type: "toggle",
      default: true,
      hint: "If device pairing is required, try one automatic pair/approve round before failing.",
    },
    {
      key: "paperclipApiUrl",
      label: "Paperclip API URL",
      type: "text",
      hint: "Optional absolute Paperclip base URL to include in wake text.",
    },
    {
      key: "claimedApiKeyPath",
      label: "Claimed API key path",
      type: "text",
      hint: "Optional path to the claimed API key JSON file read at wake time.",
    },
  ],
};

export function createServerAdapter(): ExtendedServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models,
    getConfigSchema: () => configSchema,
    supportsLocalAgentJwt: false,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    agentConfigurationDoc,
  };
}

