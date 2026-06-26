import { afterEach, describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import adapterDefault, { manifest } from "../src/index.js";
import { execute, resolveSessionKey, parseAgentResponse, syncPaperclipSkills, runVerifiedAgentTask } from "../src/server/execute.js";
import { createServerAdapter } from "../src/server/adapter.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";

let tmpHomeDir: string;

beforeAll(async () => {
  tmpHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawclip-test-home-"));
  process.env.PAPERCLIP_HOME = tmpHomeDir;
});

afterAll(async () => {
  if (tmpHomeDir) {
    await fs.rm(tmpHomeDir, { recursive: true, force: true });
  }
});

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
      adapterType: "clawclip",
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
            protocol: 4,
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

      if (frame.method === "agents.list") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: [{ agentId: "default", workspace: "/root/workspace/agent-default" }],
        }));
        return;
      }

      if (frame.method === "agents.create" || frame.method === "agents.update" || frame.method === "agents.files.set") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { ok: true },
        }));
        return;
      }

      if (frame.method === "agents.files.list") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: [],
        }));
        return;
      }

      if (frame.method === "agents.files.get") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { file: { missing: true } },
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
      id: "clawclip",
      adapters: [{ type: "clawclip", label: "ClawClip" }],
    });
    expect(adapterDefault).toMatchObject({ type: "clawclip" });
  });
});

describe("createServerAdapter", () => {
  it("exposes a config schema so Paperclip can render gateway fields in the agent form", async () => {
    const adapter = createServerAdapter();
    const schema = await adapter.getConfigSchema?.();

    expect(schema?.fields.some((field) => field.key === "url" && field.required === true)).toBe(true);
    expect(schema?.fields.some((field) => field.key === "authToken" && field.required === true)).toBe(true);
    expect(schema?.fields.some((field) => field.key === "sessionKeyStrategy")).toBe(true);
    expect(schema?.fields.some((field) => field.key === "resetOpenclawPairing" && field.type === "toggle")).toBe(true);
    expect(schema?.fields.some((field) => field.key === "understandResetPairing" && field.type === "toggle")).toBe(true);
  });
});

describe("parseAgentResponse", () => {
  it("detects checksums correctly", () => {
    // SHA-256 is exactly 64 hex characters
    const hash = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";
    expect(parseAgentResponse(`The checksum is ${hash}`, "checksum")).toEqual({ result: hash, consumedLength: 16 + 64 });
  });

  it("detects checksums in markdown", () => {
    const hash = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";
    expect(parseAgentResponse(`\`\`\`\n${hash}\n\`\`\``, "checksum")).toEqual({ result: hash, consumedLength: 4 + 64 });
  });

  it("detects MISSING for checksums", () => {
    expect(parseAgentResponse("The files are MISSING.", "checksum")).toEqual({ result: "MISSING", consumedLength: 21 });
  });

  it("detects OK with conversational filler", () => {
    // Should consume from start up to end of matched path
    expect(parseAgentResponse("I have finished the task. OK: /path/to/file and more text", "ok", "/path/to/file")).toEqual({ result: "OK", consumedLength: 43 });
  });

  it("detects OK in markdown", () => {
    expect(parseAgentResponse("```\nOK: /path/to/file\n```", "ok", "/path/to/file")).toEqual({ result: "OK", consumedLength: 21 });
  });

  it("detects OK in the middle of a buffer", () => {
    expect(parseAgentResponse("Processing... OK: /path/to/file. Done.", "ok", "/path/to/file")).toEqual({ result: "OK", consumedLength: 31 });
  });

  it("detects OK with quoted paths", () => {
    expect(parseAgentResponse('Success! OK: "/path/to/file"', "ok", "/path/to/file")).toEqual({ result: "OK", consumedLength: 28 });
  });

  it("detects READY", () => {
    expect(parseAgentResponse("The directory is READY: /target/dir", "ready", "/target/dir")).toEqual({ result: "READY", consumedLength: 35 });
  });

  it("detects DONE", () => {
    // It matches "done" in "All done." due to case-insensitivity and word boundary
    expect(parseAgentResponse("All done. DONE: task completed", "done")).toEqual({ result: "DONE", consumedLength: 8 });
  });

  it("detects hashes with [DONE:HASHES] token", () => {
    const hash1 = "a".repeat(64);
    const hash2 = "b".repeat(64);
    const hashes = `${hash1}  path1\n${hash2}  path2`;
    expect(parseAgentResponse(`Starting...\n${hashes}\n[DONE:HASHES]\nExtra`, "hashes")).toEqual({ result: hashes, consumedLength: 12 + hashes.length + 14 });
  });

  it("detects MISSING for hashes", () => {
    expect(parseAgentResponse("The list is MISSING.\n[DONE:HASHES]", "hashes")).toEqual({ result: "MISSING.", consumedLength: 34 });
  });

  it("detects hashes concatenated with filler and followed by text (User Production Case)", () => {
    const hash1 = "c3fb37c3d610f20a83cfd35a4453aa7391701f231492db261c0404c052a9ca84";
    const text = `...Última entrada el 14 de mayo, 20:10.${hash1}  ./TestFile01.md\n[DONE:HASHES]community`;
    const result = parseAgentResponse(text, "hashes");
    expect(result.result).toBe(`${hash1}  ./TestFile01.md`);
    expect(result.consumedLength).toBe(text.indexOf("community"));
  });

  it("returns empty result if expectedPath is not found", () => {
    expect(parseAgentResponse("OK: /wrong/path", "ok", "/right/path")).toEqual({ result: "", consumedLength: 0 });
  });
});

describe("sessionBuffers runId isolation", () => {
  it("correctly isolates assistant events by runId (User Production Case)", () => {
    const sessionBuffers = new Map<string, { text: string, offset: number }>();
    const mainRunId = "4b01435a-9e3e-40e2-9b7a-0bdc7e2ec0fe";
    const subRunId = "sub-run-123";
    
    // Helper to simulate the onEvent logic
    const simulateAssistantEvent = (rid: string, text: string) => {
      if (rid === mainRunId) {
        // Main run accumulation (ignored by sync logic)
      } else {
        let buf = sessionBuffers.get(rid);
        if (!buf) {
          buf = { text: "", offset: 0, sessionKey: "mock-session" };
          sessionBuffers.set(rid, buf);
        }
        buf.text += text;
      }
    };
    
    // Interleaved events as seen in user's logs
    simulateAssistantEvent(mainRunId, "ha reportado ningún avance...");
    simulateAssistantEvent(subRunId, "c3fb37c3d610f20a83cfd35a4453aa7391701f231492db261c0404c052a9ca84  ./TestFile01.md\n");
    simulateAssistantEvent(mainRunId, "### 🚨 Ejecución del Protocolo...");
    simulateAssistantEvent(subRunId, "[DONE:HASHES]");
    
    // Verify isolation
    expect(sessionBuffers.get(mainRunId)).toBeUndefined();
    expect(sessionBuffers.get(subRunId)?.text).toBe("c3fb37c3d610f20a83cfd35a4453aa7391701f231492db261c0404c052a9ca84  ./TestFile01.md\n[DONE:HASHES]");
    
    // Verify parsing from the isolated buffer
    const parsed = parseAgentResponse(sessionBuffers.get(subRunId)!.text, "hashes");
    expect(parsed.result).toBe("c3fb37c3d610f20a83cfd35a4453aa7391701f231492db261c0404c052a9ca84  ./TestFile01.md");
  });

  it("handles runId mismatch using session-aware capturing", () => {
    const sessionKey = "agent:main:paperclip:run:123";
    const sessionBuffers = new Map<string, { text: string, offset: number, sessionKey?: string }>();
    const runIdA = "run-A"; // ID returned by Gateway (e.g. from chat.send delivery)
    const runIdB = "run-B"; // ID used by Agent (e.g. for the actual turn)
    
    // Task initialized with runIdA
    sessionBuffers.set(runIdA, { text: "", offset: 0, sessionKey });
    
    // Simulate event arriving for runIdB (auto-initialized by listener)
    const textB = "OK: /path/to/file\n";
    sessionBuffers.set(runIdB, { text: textB, offset: 0, sessionKey });

    // Simulate runVerifiedAgentTask polling across session buffers
    let detectedToken = "";
    const expectedPath = "/path/to/file";
    for (const [rid, buf] of sessionBuffers.entries()) {
      if (buf.sessionKey === sessionKey) {
        const parsed = parseAgentResponse(buf.text.slice(buf.offset), "ok", expectedPath);
        if (parsed.result !== "") {
          detectedToken = parsed.result;
          buf.offset += parsed.consumedLength;
          break;
        }
      }
    }
    
    expect(detectedToken).toBe("OK");
    expect(sessionBuffers.get(runIdB)!.offset).toBe(17); // Path consumed, newline remains
  });

  it("handles runId mismatch with prefixed session key (Production Edge Case)", () => {
    // Local key as calculated in bridge
    const localSessionKey = "paperclip:run:123";
    // Remote key as returned by Gateway
    const remoteSessionKey = "agent:main:paperclip:run:123";
    
    const sessionBuffers = new Map<string, { text: string, offset: number, sessionKey?: string }>();
    const subRunId = "sub-run-456";
    
    // Simulate event arriving with prefixed key
    sessionBuffers.set(subRunId, { text: "OK: /path/to/file\n", offset: 0, sessionKey: remoteSessionKey });

    // Simulate runVerifiedAgentTask polling using local sessionKey
    let detectedToken = "";
    for (const [rid, buf] of sessionBuffers.entries()) {
      if (buf.sessionKey && buf.sessionKey.includes(localSessionKey)) {
        const parsed = parseAgentResponse(buf.text.slice(buf.offset), "ok", "/path/to/file");
        if (parsed.result !== "") {
          detectedToken = parsed.result;
          break;
        }
      }
    }
    
    expect(detectedToken).toBe("OK");
  });
});

describe("execute", () => {
  it("strips root paperclip payloads before sending the gateway request with enableSkillSync false", async () => {
    const gateway = await createMockGatewayServer();
    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          enableSkillSync: false,
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
        sessionKey: "agent:paperclip-agent-123:paperclip:issue:issue-123",
        idempotencyKey: "run-123",
      });
      expect(String(payload.message ?? "")).toContain("# Persona & Rules (Static System Instructions)");
    } finally {
      await gateway.close();
    }
  });

  it("sends a caching-optimized prompt when enableSkillSync is true", async () => {
    const gateway = await createMockGatewayServer();
    try {
      const result = await execute(
        buildContext({
          url: gateway.url,
          enableSkillSync: true,
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
        sessionKey: "agent:paperclip-agent-123:paperclip:issue:issue-123",
        idempotencyKey: "run-123",
      });
      const message = String(payload.message ?? "");
      expect(message).toContain("# Persona & Rules (Static System Instructions)");
      expect(message).toContain("# Dynamic Context (Active Event Payload)");
      expect(message).toContain("- (No auxiliary skills available)");
    } finally {
      await gateway.close();
    }
  });

  it("does not start skill sync by default (enableSkillSync is false by default)", async () => {
    const gateway = await createMockGatewayServer();
    try {
      const logs: string[] = [];
      const result = await execute(
        buildContext({
          url: gateway.url,
          paperclipRuntimeSkills: [
            {
              key: "paperclip",
              runtimeName: "paperclip",
              source: "/tmp/fake-skill-path",
              required: true,
            }
          ],
          payloadTemplate: {
            paperclip: { shouldNot: "ship" },
            model: "gpt-5",
          },
        }, {
          onLog: async (stream, chunk) => {
            logs.push(String(chunk));
          }
        }),
      );

      expect(result.exitCode).toBe(0);
      const fullLog = logs.join("");
      expect(fullLog).toContain("but Skill Sync is disabled by configuration. Skipping sync.");
      expect(fullLog).not.toContain("starting durable sync");
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
        }, {
          authToken: secretToken,
          onLog: async (stream, chunk) => {
            logs.push(String(chunk));
          },
        })
      );
      
      const fullLog = logs.join("");
      const filteredLog = fullLog
        .split("\n")
        .filter((line) => !line.includes("info:"))
        .join("\n");
      expect(filteredLog).not.toContain(secretToken);
    } finally {
      await gateway.close();
    }
  });

  it("produces standardized log format [TIMESTAMP] [clawclip]", async () => {
    const gateway = await createMockGatewayServer();
    try {
      const logs: string[] = [];
      await execute(
        buildContext({
          url: gateway.url,
        }, {
          onLog: async (stream, chunk) => {
            logs.push(String(chunk));
          },
        })
      );
      
      const firstLine = logs[0];
      expect(firstLine).toBeDefined();
      // Format: starts with [20260515-094301] or 20260515-094301 followed by [clawclip]
      expect(firstLine).toMatch(/^(?:\[)?\d{8}-\d{6}(?:\])?\s+\[clawclip\]/);
    } finally {
      await gateway.close();
    }
  });

  it("filters remote events by sessionKey or runID and logs under [openclaw]", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    const receivedLogs: string[] = [];

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));

      socket.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const frame = JSON.parse(text);
        if (frame.type !== "req") return;

        if (frame.method === "agents.list") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: [{ agentId: "default", workspace: "/root/workspace/agent-default" }],
          }));
          return;
        }

        if (frame.method === "agents.create" || frame.method === "agents.update" || frame.method === "agents.files.set") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { ok: true },
          }));
          return;
        }

        if (frame.method === "agents.files.list") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: [],
          }));
          return;
        }

        if (frame.method === "agents.files.get") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { file: { missing: true } },
          }));
          return;
        }

        if (frame.method === "connect") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }));

          // Send agent events to trigger onEvent inside execute
          // Event 1: matching sessionKey, stream = assistant (should be logged under [openclaw])
          socket.send(JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId: "sub-run-1",
              sessionKey: "agent:paperclip-agent-123:paperclip:issue:issue-123",
              stream: "assistant",
              data: { text: "Matching sessionKey text" }
            }
          }));

          // Event 2: matching runId, stream = lifecycle (should be logged under [openclaw])
          socket.send(JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId: "run-123", // Matches context runId
              sessionKey: "other-session",
              stream: "lifecycle",
              data: { phase: "start", text: "Matching runId text" }
            }
          }));

          // Event 3: matching sessionKey, stream = command_output (should log "Running a command...")
          socket.send(JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId: "sub-run-1",
              sessionKey: "agent:paperclip-agent-123:paperclip:issue:issue-123",
              stream: "command_output",
              data: { text: "Command event payload" }
            }
          }));

          // Event 4: matching sessionKey but unsupported stream = tool (should be filtered out)
          socket.send(JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId: "sub-run-1",
              sessionKey: "agent:paperclip-agent-123:paperclip:issue:issue-123",
              stream: "tool",
              data: { text: "Matching sessionKey but unsupported stream" }
            }
          }));

          // Event 5: mismatching sessionKey and mismatching runId, stream = assistant (should be completely filtered out)
          socket.send(JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId: "some-other-run",
              sessionKey: "unrelated-session",
              stream: "assistant",
              data: { text: "Unrelated text" }
            }
          }));
          return;
        }

        if (frame.method === "agent") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId: "run-123", status: "accepted", acceptedAt: Date.now() },
          }));
          return;
        }

        if (frame.method === "agent.wait") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId: "run-123", status: "ok" },
          }));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to resolve test server address");

    try {
      await execute(
        buildContext({
          url: `ws://127.0.0.1:${address.port}`,
          enableSkillSync: false,
          sessionKeyStrategy: "issue",
        }, {
          onLog: async (stream, chunk) => {
            receivedLogs.push(String(chunk));
          },
        })
      );

      // Polling helper to wait for asynchronous log events with timeout
      const waitForLog = async (pattern: string, timeout = 1000): Promise<string> => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const found = receivedLogs.find(l => l.includes(pattern));
          if (found) return found;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timeout waiting for log pattern: ${pattern}. Current logs: ${JSON.stringify(receivedLogs)}`);
      };

      const sessionKeyLog = await waitForLog("Matching sessionKey text");
      const runIdLog = await waitForLog("Matching runId text");
      const commandLog = await waitForLog("Running a command...");

      const unsupportedStreamLog = receivedLogs.find(l => !l.includes("[DEBUG]") && !l.includes("DEBUG:") && l.includes("Matching sessionKey but unsupported stream"));
      const filteredLog = receivedLogs.find(l => !l.includes("[DEBUG]") && !l.includes("DEBUG:") && l.includes("Unrelated text"));

      expect(sessionKeyLog).toMatch(/^(?:\[)?\d{8}-\d{6}(?:\])?\s+\[openclaw\](?:\s+\[DEBUG\])?/);
      expect(runIdLog).toMatch(/^(?:\[)?\d{8}-\d{6}(?:\])?\s+\[openclaw\](?:\s+\[DEBUG\])?/);
      expect(commandLog).toMatch(/^(?:\[)?\d{8}-\d{6}(?:\])?\s+\[openclaw\]/);

      expect(unsupportedStreamLog).toBeUndefined();
      expect(filteredLog).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("returns exitCode 1 when remote agent reports AGENT_ERROR: in assistant summary", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));

      socket.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const frame = JSON.parse(text);
        if (frame.type !== "req") return;

        if (frame.method === "agents.list") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: [{ agentId: "default", workspace: "/root/workspace/agent-default" }] }));
          return;
        }

        if (frame.method === "agents.create" || frame.method === "agents.update" || frame.method === "agents.files.set") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
          return;
        }

        if (frame.method === "agents.files.list") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: [] }));
          return;
        }

        if (frame.method === "agents.files.get") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { file: { missing: true } },
          }));
          return;
        }

        if (frame.method === "connect") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }));
          return;
        }

        if (frame.method === "agent") {
          const runId = typeof frame.params?.idempotencyKey === "string" ? frame.params.idempotencyKey : "run-123";
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId, status: "accepted", acceptedAt: Date.now() },
          }));

          // Simulate the remote agent streaming AGENT_ERROR in assistant summary (anchored at line start)
          socket.send(JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId,
              sessionKey: "agent:paperclip-agent-123:paperclip:issue:issue-123",
              stream: "assistant",
              data: { text: "AGENT_ERROR: Agent authentication required" },
            },
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

    try {
      const logs: string[] = [];
      const result = await execute(
        buildContext({
          url: `ws://127.0.0.1:${address.port}`,
          enableSkillSync: false,
        }, {
          onLog: async (_stream, chunk) => {
            logs.push(String(chunk));
          },
        })
      );

      expect(result.exitCode).toBe(1);
      expect(result.errorCode).toBe("remote_agent_error");
      expect(result.errorMessage).toContain("Remote agent error: Agent authentication required");

      const stderrLog = logs.find(l => l.includes("Remote agent reported error"));
      expect(stderrLog).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not trigger remote_agent_error when remote agent mentions 'error:' in prose or has 'ERROR:' mid-line", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));

      socket.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const frame = JSON.parse(text);
        if (frame.type !== "req") return;

        if (frame.method === "agents.list") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: [{ agentId: "default", workspace: "/root/workspace/agent-default" }] }));
          return;
        }

        if (frame.method === "agents.create" || frame.method === "agents.update" || frame.method === "agents.files.set") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
          return;
        }

        if (frame.method === "agents.files.list") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: [] }));
          return;
        }

        if (frame.method === "agents.files.get") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { file: { missing: true } },
          }));
          return;
        }

        if (frame.method === "connect") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }));
          return;
        }

        if (frame.method === "agent") {
          const runId = typeof frame.params?.idempotencyKey === "string" ? frame.params.idempotencyKey : "run-123";
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId, status: "accepted", acceptedAt: Date.now() },
          }));

          // Send prose containing "error:" and "ERROR:" in ways that should NOT match the new /^AGENT_ERROR:/m regex
          socket.send(JSON.stringify({
            type: "event",
            event: "agent",
            payload: {
              runId,
              sessionKey: "agent:paperclip-agent-123:paperclip:issue:issue-123",
              stream: "assistant",
              data: { text: "I fixed the compile error: syntax error in main.ts. The log had some details: ERROR: failed to compile" },
            },
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

    try {
      const logs: string[] = [];
      const result = await execute(
        buildContext({
          url: `ws://127.0.0.1:${address.port}`,
          enableSkillSync: false,
        }, {
          onLog: async (_stream, chunk) => {
            logs.push(String(chunk));
          },
        })
      );

      // Verify that exitCode is 0, which means no remote_agent_error was falsely triggered
      expect(result.exitCode).toBe(0);
      expect(result.errorCode).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reconnects and resumes agent.wait if WebSocket drops during execution", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    let connectionCount = 0;

    wss.on("connection", (socket) => {
      connectionCount++;
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
              protocol: 4,
              server: { version: "test", connId: `conn-${connectionCount}` },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }));
          return;
        }

        if (frame.method === "agent") {
          const runId = typeof frame.params?.idempotencyKey === "string" ? frame.params.idempotencyKey : "run-123";
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId, status: "accepted", acceptedAt: Date.now() },
          }));
          return;
        }

        if (frame.method === "agents.list") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: [{ agentId: "default", workspace: "/root/workspace/agent-default" }],
          }));
          return;
        }

        if (frame.method === "agents.create" || frame.method === "agents.update" || frame.method === "agents.files.set") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { ok: true },
          }));
          return;
        }

        if (frame.method === "agents.files.list") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: [],
          }));
          return;
        }

        if (frame.method === "agents.files.get") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { file: { missing: true } },
          }));
          return;
        }

        if (frame.method === "agent.wait") {
          if (connectionCount === 1) {
            // Abruptly terminate connection on first wait call to simulate network drop
            socket.terminate();
          } else {
            // Respond successfully on subsequent connection
            socket.send(JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: { runId: frame.params?.runId, status: "ok", startedAt: 1, endedAt: 2 },
            }));
          }
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to resolve test server address");

    try {
      const logs: string[] = [];
      const result = await execute(
        buildContext({
          url: `ws://127.0.0.1:${address.port}`,
          enableSkillSync: false,
          timeoutSec: 5,
        }, {
          onLog: async (_stream, chunk) => {
            logs.push(String(chunk));
          },
        })
      );

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);

      // Verify reconnection logs were emitted
      const disconnectLog = logs.find(l => l.includes("WebSocket disconnected. Reconnecting to gateway"));
      const reconnectLog = logs.find(l => l.includes("Reconnected to gateway successfully"));
      expect(disconnectLog).toBeDefined();
      expect(reconnectLog).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("handles remote agent timeout and logs the remote timeout message", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));

      socket.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const frame = JSON.parse(text);
        if (frame.type !== "req") return;

        if (frame.method === "connect") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }));
          return;
        }

        if (frame.method === "agent") {
          const runId = typeof frame.params?.idempotencyKey === "string" ? frame.params.idempotencyKey : "run-123";
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId, status: "accepted", acceptedAt: Date.now() },
          }));
          return;
        }

        if (frame.method === "agents.list" || frame.method === "agents.create" || frame.method === "agents.update" || frame.method === "agents.files.set") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
          return;
        }

        if (frame.method === "agents.files.list") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: [] }));
          return;
        }

        if (frame.method === "agents.files.get") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { file: { missing: true } } }));
          return;
        }

        if (frame.method === "agent.wait") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId: frame.params?.runId, status: "timeout" },
          }));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to resolve test server address");

    try {
      const logs: string[] = [];
      const result = await execute(
        buildContext({
          url: `ws://127.0.0.1:${address.port}`,
          enableSkillSync: false,
          timeoutSec: 5,
        }, {
          onLog: async (_stream, chunk) => {
            logs.push(String(chunk));
          },
        })
      );

      expect(result.timedOut).toBe(true);
      expect(result.errorMessage).toContain("(remote timeout: openclaw gateway reported timeout status)");
      const remoteTimeoutLog = logs.find(l => l.includes("Remote Timeout:"));
      expect(remoteTimeoutLog).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("handles local wait timeout and logs the local timeout message", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));

      socket.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const frame = JSON.parse(text);
        if (frame.type !== "req") return;

        if (frame.method === "connect") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }));
          return;
        }

        if (frame.method === "agent") {
          const runId = typeof frame.params?.idempotencyKey === "string" ? frame.params.idempotencyKey : "run-123";
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId, status: "accepted", acceptedAt: Date.now() },
          }));
          return;
        }

        if (frame.method === "agents.list" || frame.method === "agents.create" || frame.method === "agents.update" || frame.method === "agents.files.set") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
          return;
        }

        if (frame.method === "agents.files.list") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: [] }));
          return;
        }

        if (frame.method === "agents.files.get") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { file: { missing: true } } }));
          return;
        }

        if (frame.method === "agent.wait") {
          // Do not respond to simulate a wait hang that triggers local timeout
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to resolve test server address");

    try {
      const logs: string[] = [];
      const result = await execute(
        buildContext({
          url: `ws://127.0.0.1:${address.port}`,
          enableSkillSync: false,
          timeoutSec: 1, // Set timeout very short (1 second) to trigger it quickly
        }, {
          onLog: async (_stream, chunk) => {
            logs.push(String(chunk));
          },
        })
      );

      expect(result.timedOut).toBe(true);
      expect(result.errorMessage).toContain("(local timeout: elapsed time exceeded timeout limit waiting for gateway)");
      const localTimeoutLog = logs.find(l => l.includes("Local Timeout:"));
      expect(localTimeoutLog).toBeDefined();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("logs raw connection messages in debug mode and suppresses them when debug mode is disabled", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));

      socket.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const frame = JSON.parse(text);
        if (frame.type !== "req") return;

        if (frame.method === "connect") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }));
          return;
        }

        if (frame.method === "agent") {
          const runId = typeof frame.params?.idempotencyKey === "string" ? frame.params.idempotencyKey : "run-123";
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId, status: "accepted", acceptedAt: Date.now() },
          }));
          return;
        }

        if (frame.method === "agents.list" || frame.method === "agents.create" || frame.method === "agents.update" || frame.method === "agents.files.set") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
          return;
        }

        if (frame.method === "agents.files.list") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: [] }));
          return;
        }

        if (frame.method === "agents.files.get") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { file: { missing: true } } }));
          return;
        }

        if (frame.method === "agent.wait") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId: frame.params?.runId, status: "ok" },
          }));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to resolve test server address");

    try {
      // 1. Run with debug: true
      const logsDebug: string[] = [];
      await execute(
        buildContext({
          url: `ws://127.0.0.1:${address.port}`,
          enableSkillSync: false,
          debug: true,
        }, {
          onLog: async (_stream, chunk) => {
            logsDebug.push(String(chunk));
          },
        })
      );

      const debugMsg = logsDebug.find(l => l.includes("[openclaw] [DEBUG] WebSocket message received:"));
      expect(debugMsg).toBeDefined();

      // 2. Run with debug: false
      const logsNoDebug: string[] = [];
      await execute(
        buildContext({
          url: `ws://127.0.0.1:${address.port}`,
          enableSkillSync: false,
          debug: false,
        }, {
          onLog: async (_stream, chunk) => {
            logsNoDebug.push(String(chunk));
          },
        })
      );

      const noDebugMsg = logsNoDebug.find(l => l.includes("[openclaw] [DEBUG] WebSocket message received:"));
      expect(noDebugMsg).toBeUndefined();

    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("logs a warning when resolving persistent device identity fails and falls back to ephemeral", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } }));

      socket.on("message", (raw) => {
        const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
        const frame = JSON.parse(text);
        if (frame.type !== "req") return;

        if (frame.method === "connect") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "test", connId: "conn-1" },
              features: { methods: ["connect", "agent", "agent.wait"], events: ["agent"] },
              snapshot: { version: 1, ts: Date.now() },
              policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 },
            },
          }));
          return;
        }

        if (frame.method === "agent") {
          const runId = typeof frame.params?.idempotencyKey === "string" ? frame.params.idempotencyKey : "run-123";
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId, status: "accepted", acceptedAt: Date.now() },
          }));
          return;
        }

        if (frame.method === "agents.list" || frame.method === "agents.create" || frame.method === "agents.update" || frame.method === "agents.files.set") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { ok: true } }));
          return;
        }

        if (frame.method === "agents.files.list") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: [] }));
          return;
        }

        if (frame.method === "agents.files.get") {
          socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { file: { missing: true } } }));
          return;
        }

        if (frame.method === "agent.wait") {
          socket.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { runId: frame.params?.runId, status: "ok" },
          }));
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to resolve test server address");

    // Force existsSync to throw
    const spy = vi.spyOn(fsSync, "existsSync").mockImplementation(() => {
      throw new Error("Disk permission denied");
    });

    try {
      const logs: string[] = [];
      await execute(
        buildContext({
          url: `ws://127.0.0.1:${address.port}`,
          enableSkillSync: false,
        }, {
          onLog: async (_stream, chunk) => {
            logs.push(String(chunk));
          },
        })
      );

      const errorLog = logs.find((l) => l.includes("Error resolving persistent device identity, falling back to ephemeral:"));
      expect(errorLog).toBeDefined();
      expect(errorLog).toContain("Disk permission denied");

      const ephemeralLog = logs.find((l) => l.includes("device auth enabled keySource=ephemeral"));
      expect(ephemeralLog).toBeDefined();
    } finally {
      spy.mockRestore();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
