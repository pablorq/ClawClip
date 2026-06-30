import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import crypto, { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  parseBoolean,
  resolveDeviceIdentity,
  signDevicePayload,
  buildDeviceAuthPayloadV3,
  resolveAuthToken,
  nonEmpty,
  toStringRecord,
  toStringArray,
  type GatewayDeviceIdentity,
} from "./adapter.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8"))),
    ).toString("utf8");
  }
  return String(data ?? "");
}

async function probeGateway(input: {
  url: string;
  headers: Record<string, string>;
  authToken: string | null;
  role: string;
  scopes: string[];
  timeoutMs: number;
  deviceIdentity: GatewayDeviceIdentity | null;
  config: Record<string, unknown>;
}): Promise<"ok" | "challenge_only" | "failed"> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(input.url, { headers: input.headers, maxPayload: 2 * 1024 * 1024 });
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve("failed");
    }, input.timeoutMs);

    let completed = false;

    const finish = (status: "ok" | "challenge_only" | "failed") => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(status);
    };

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch {
        return;
      }
      const event = asRecord(parsed);
      if (event?.type === "event" && event.event === "connect.challenge") {
        const nonce = nonEmpty(asRecord(event.payload)?.nonce);
        if (!nonce) {
          finish("failed");
          return;
        }

        const connectId = randomUUID();
        const signedAtMs = Date.now();
        const clientId = nonEmpty(input.config.clientId) ?? "gateway-client";
        const clientMode = nonEmpty(input.config.clientMode) ?? "probe";
        const clientVersion = nonEmpty(input.config.clientVersion) ?? "paperclip-probe";
        const deviceFamily = nonEmpty(input.config.deviceFamily) ?? "clawclip";

        const connectParams: Record<string, unknown> = {
          minProtocol: 3,
          maxProtocol: 4,
          client: {
            id: clientId,
            version: clientVersion,
            platform: process.platform,
            ...(deviceFamily ? { deviceFamily } : {}),
            mode: clientMode,
          },
          role: input.role,
          scopes: input.scopes,
          ...(input.authToken
            ? {
              auth: {
                token: input.authToken,
              },
            }
            : {}),
        };

        if (input.deviceIdentity) {
          const payload = buildDeviceAuthPayloadV3({
            deviceId: input.deviceIdentity.deviceId,
            clientId,
            clientMode,
            role: input.role,
            scopes: input.scopes,
            signedAtMs,
            token: input.authToken,
            nonce,
            platform: process.platform,
            deviceFamily,
          });
          connectParams.device = {
            id: input.deviceIdentity.deviceId,
            publicKey: input.deviceIdentity.publicKeyRawBase64Url,
            signature: signDevicePayload(input.deviceIdentity.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce,
          };
        }

        ws.send(
          JSON.stringify({
            type: "req",
            id: connectId,
            method: "connect",
            params: connectParams,
          }),
        );
        return;
      }

      if (event?.type === "res") {
        if (event.ok === true) {
          finish("ok");
        } else {
          finish("challenge_only");
        }
      }
    });

    ws.on("error", () => {
      finish("failed");
    });

    ws.on("close", () => {
      if (!completed) finish("failed");
    });
  });
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "").trim();

  if (!urlValue) {
    checks.push({
      code: "clawclip_url_missing",
      level: "error",
      message: "OpenClaw gateway adapter requires a WebSocket URL.",
      hint: "Set adapterConfig.url to ws://host:port (or wss://).",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "clawclip_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "ws:" && url.protocol !== "wss:") {
    checks.push({
      code: "clawclip_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use ws:// or wss://.",
    });
  }

  if (url) {
    checks.push({
      code: "clawclip_url_valid",
      level: "info",
      message: `Configured gateway URL: ${url.toString()}`,
    });

    if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
      checks.push({
        code: "clawclip_plaintext_remote_ws",
        level: "info",
        message: "Gateway URL uses plaintext ws:// on a non-loopback host.",
        hint: "Prefer wss:// for remote gateways.",
      });
    }
  }

  const headers = toStringRecord(config.headers);
  const authToken = resolveAuthToken(config, headers);
  const role = nonEmpty(config.role) ?? "operator";
  const scopes = toStringArray(config.scopes);



  if (authToken) {
    checks.push({
      code: "clawclip_auth_present",
      level: "info",
      message: "Gateway credentials are configured.",
    });
  } else {
    checks.push({
      code: "clawclip_auth_missing",
      level: "warn",
      message: "No gateway credentials detected in adapter config.",
      hint: "Set authToken or headers.x-openclaw-token for authenticated gateways.",
    });
  }

  if (url && (url.protocol === "ws:" || url.protocol === "wss:")) {
    try {
      const deviceIdentity = await resolveDeviceIdentity(config);
      const probeResult = await probeGateway({
        url: url.toString(),
        headers,
        authToken,
        role,
        scopes: scopes.length > 0 ? scopes : ["operator.admin"],
        timeoutMs: 3_000,
        deviceIdentity,
        config,
      });

      if (probeResult === "ok") {
        checks.push({
          code: "clawclip_probe_ok",
          level: "info",
          message: "Gateway connect probe succeeded.",
        });
      } else if (probeResult === "challenge_only") {
        checks.push({
          code: "clawclip_probe_challenge_only",
          level: "warn",
          message: "Gateway challenge was received, but connect probe was rejected.",
          hint: "Check gateway credentials, scopes, role, and device-auth requirements.",
        });
      } else {
        checks.push({
          code: "clawclip_probe_failed",
          level: "warn",
          message: "Gateway probe failed.",
          hint: "Verify network reachability and gateway URL from the Paperclip server host.",
        });
      }
    } catch (err) {
      checks.push({
        code: "clawclip_probe_error",
        level: "warn",
        message: err instanceof Error ? err.message : "Gateway probe failed",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
