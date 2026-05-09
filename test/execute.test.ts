import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import adapterDefault, { manifest } from "../src/index.js";
import { execute, resolveSessionKey } from "../src/server/execute.js";
import { createServerAdapter } from "../src/server/adapter.js";

function buildContext(
  config: Record<string, unknown>,
  overrides?: Partial<AdapterExecutionContext>,
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "OpenClaw Bridge Agent",
      adapterType: "openclaw_bridge",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {
      taskId: "task-123",
      issueId: "issue-123",
      wakeReason: "issue_assigned",
      issueIds: ["issue-123"],
    },
    onLog: async () => {},
    ...overrides,
  };
}

async function createMockGatewayServer() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let agentPayload: Record<string, unknown> | null = null;

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));

    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      const frame = JSON.parse(text) as {
        type: string;
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      if (frame.type !== "req") return;

      if (frame.method === "connect") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
            server: { version: "test", connId: "conn-1" },
            features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
            snapshot: { version: 1, ts: Date.now() },
            policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
          },
        }));
        return;
      }

      if (frame.method === "agent") {
        agentPayload = frame.params ?? null;
        const runId = typeof frame.params?.idempotencyKey === "string" ? frame.params.idempotencyKey : "run-123";
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { runId, status: "accepted", acceptedAt: Date.now() },
        }));
        return;
      }

      if (frame.method === "agent.wait") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { runId: frame.params?.runId, status: "ok", startedAt: 1, endedAt: 2 },
        }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to resolve test server address");

  return {
    url: `ws://127.0.0.1:${address.port}`,
    getAgentPayload: () => agentPayload,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(() => {
  // no-op hook so vitest doesn't complain if we expand cleanup later
});

describe("resolveSessionKey", () => {
  it("prefixes run-scoped session keys with the configured agent", () => {
    expect(resolveSessionKey({ strategy: "run", configuredSessionKey: null, agentId: "meridian", runId: "run-123", issueId: null })).toBe(
      "agent:meridian:paperclip:run:run-123",
    );
  });

  it("prefixes issue-scoped session keys with the configured agent", () => {
    expect(resolveSessionKey({ strategy: "issue", configuredSessionKey: null, agentId: "meridian", runId: "run-123", issueId: "issue-456" })).toBe(
      "agent:meridian:paperclip:issue:issue-456",
    );
  });

  it("prefixes fixed session keys with the configured agent", () => {
    expect(resolveSessionKey({ strategy: "fixed", configuredSessionKey: "paperclip", agentId: "meridian", runId: "run-123", issueId: null })).toBe(
      "agent:meridian:paperclip",
    );
  });

  it("does not double-prefix an already-routed session key", () => {
    expect(resolveSessionKey({ strategy: "fixed", configuredSessionKey: "agent:meridian:paperclip", agentId: "meridian", runId: "run-123", issueId: null })).toBe(
      "agent:meridian:paperclip",
    );
  });
});

describe("package root exports", () => {
  it("exposes manifest metadata and a default server adapter instance", () => {
    expect(manifest).toMatchObject({
      id: "paperclip-openclaw-bridge",
      adapters: [{ type: "openclaw_bridge", label: "OpenClaw Bridge" }],
    });
    expect(adapterDefault).toMatchObject({ type: "openclaw_bridge" });
  });
});

describe("createServerAdapter", () => {
  it("exposes a config schema so Paperclip can render gateway fields in the agent form", async () => {
    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema?.();

    expect(schema?.fields.some((field) => field.key === "url" && field.required === true)).toBe(true);
    expect(schema?.fields.some((field) => field.key === "authToken")).toBe(true);
    expect(schema?.fields.some((field) => field.key === "sessionKeyStrategy")).toBe(true);
    expect(schema?.fields.some((field) => field.key === "devicePrivateKeyPem" && field.type === "textarea")).toBe(true);
    expect(schema?.fields.some((field) => field.key === "scopes" && String(field.default).includes("operator.pairing"))).toBe(true);
  });
});

describe("execute", () => {
  it("strips root paperclip payloads before sending the gateway request", async () => {
    const gateway = await createMockGatewayServer();
    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          disableDeviceAuth: true,
          payloadTemplate: {
            paperclip: { shouldNot: "ship" },
            model: "gpt-5",
          },
        }),
      );

      expect(result.exitCode).toBe(0);
      const payload = gateway.getAgentPayload() ?? {};
      expect(payload).not.toHaveProperty("paperclip");
      expect(payload).toMatchObject({
        model: "gpt-5",
        sessionKey: "paperclip:issue:issue-123",
        idempotencyKey: "run-123",
      });
      expect(String(payload.message ?? "")).toContain("Paperclip wake event");
    } finally {
      await gateway.close();
    }
  });

  it("redacts the injected auth token from outbound logs", async () => {
    const gateway = await createMockGatewayServer();
    try {
      const logs: string[] = [];
      const secretToken = "super-secret-jwt-token-value-123";
      
      await execute(
        buildContext({
          url: gateway.url,
          disableDeviceAuth: true,
        }, {
          authToken: secretToken,
          onLog: async (stream, chunk) => {
            logs.push(String(chunk));
          },
        })
      );
      
      const fullLog = logs.join("");
      expect(fullLog).not.toContain(secretToken);
    } finally {
      await gateway.close();
    }
  });
});
