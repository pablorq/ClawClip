import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getCompanyName, ensureAgentAndSyncInstructions, getCompanyWorkspaceBaseDir, registerSessionTokenInBootstrap } from "../src/server/agent-manager.js";
import { runVerifiedAgentTask } from "../src/server/execute.js";
import { initLogger } from "../src/server/logger.js";

vi.mock("../src/server/execute.js", () => ({
  runVerifiedAgentTask: vi.fn().mockResolvedValue("OK"),
}));

function buildContext(
  config: Record<string, unknown>,
  overrides?: Partial<AdapterExecutionContext>
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "CEO",
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
    authToken: "token-123",
    onLog: async () => {},
    ...overrides,
  };
}

describe("agent-manager unit tests", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());
    initLogger(async () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("getCompanyName", () => {
    it("returns company name when fetch succeeds", async () => {
      const ctx = buildContext({ paperclipApiUrl: "http://localhost:3100" });
      const mockFetch = vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ name: "Acme Corp" }),
      } as any);

      const name = await getCompanyName(ctx);
      expect(name).toBe("Acme Corp");
      expect(mockFetch).toHaveBeenCalledWith("http://localhost:3100/api/companies/company-123", {
        headers: { Authorization: "Bearer token-123" },
      });
    });

    it("falls back gracefully if fetch throws or fails", async () => {
      const ctx = buildContext({ paperclipApiUrl: "http://localhost:3100" });
      vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

      const name = await getCompanyName(ctx);
      expect(name).toBe("Company company-123");
    });

    it("falls back gracefully if no authToken is provided", async () => {
      const ctx = buildContext({ paperclipApiUrl: "http://localhost:3100" }, { authToken: undefined });
      const name = await getCompanyName(ctx);
      expect(name).toBe("Company company-123");
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("getCompanyWorkspaceBaseDir", () => {
    it("returns config-specified root", () => {
      const ctx = buildContext({ remoteWorkspaceRoot: "/config/root" });
      const dir = getCompanyWorkspaceBaseDir(ctx);
      expect(dir).toBe("/config/root/workspace-paperclip/company-123");
    });

    it("extracts parent from defaultAgent workspace if present", () => {
      const ctx = buildContext({});
      const dir = getCompanyWorkspaceBaseDir(ctx, "/default/workspace/agent-main");
      expect(dir).toBe("/default/workspace/workspace-paperclip/company-123");
    });

    it("falls back to default /home/node/.openclaw", () => {
      const ctx = buildContext({});
      const dir = getCompanyWorkspaceBaseDir(ctx, null);
      expect(dir).toBe("/home/node/.openclaw/workspace-paperclip/company-123");
    });
  });

  describe("ensureAgentAndSyncInstructions", () => {
    let mockClient: any;
    let mockFsReadFile: any;

    beforeEach(() => {
      mockClient = {
        request: vi.fn(),
      };
      mockFsReadFile = vi.spyOn(fs, "readFile");
    });

    it("creates dedicated agent and updates name if it does not exist", async () => {
      const ctx = buildContext({
        instructionsFilePath: "/tmp/fake/AGENTS.md",
        paperclipApiUrl: "http://localhost:3100",
      });

      // Mock agents.list returning default agent but not target
      mockClient.request.mockImplementation(async (method: string, params: any) => {
        if (method === "agents.list") {
          return [{ agentId: "default", workspace: "/root/workspace/agent-default" }];
        }
        if (method === "agents.create") return { ok: true };
        if (method === "agents.update") return { ok: true };
        if (method === "agents.files.list") {
          // Attempt 1: return empty, which matches since AGENTS.md isn't there yet (so it gets synced)
          // Attempt 2: after set, return updated AGENTS.md matching local size
           if (mockClient.request.mock.calls.filter((c: any) => c[0] === "agents.files.list").length === 1) {
             return [];
           }
           return [{ name: "AGENTS.md", size: Buffer.byteLength("Perform instruction sync test", "utf8") }];
        }
        if (method === "agents.files.set") return { ok: true };
        return null;
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ name: "Acme Corp" }),
      } as any);

      mockFsReadFile.mockImplementation(async (filePath: string) => {
        if (filePath === "/tmp/fake/AGENTS.md") return "Perform instruction sync test";
        throw new Error("ENOENT");
      });

      await ensureAgentAndSyncInstructions(ctx, mockClient, "paperclip-agent-123");

      // Verify remote workspace provisioning
      expect(mockClient.request).toHaveBeenCalledWith("agents.create", {
        name: "paperclip-agent-123",
        workspace: path.normalize("/root/workspace/workspace-paperclip/company-123/agents/agent-123"),
      });

      // Verify IDENTITY.md was cleared before update
      expect(mockClient.request).toHaveBeenCalledWith("agents.files.set", {
        agentId: "paperclip-agent-123",
        name: "IDENTITY.md",
        content: "",
      });

      expect(mockClient.request).toHaveBeenCalledWith("agents.update", {
        agentId: "paperclip-agent-123",
        name: "Acme Corp - CEO",
        emoji: "📎",
      });

      // Verify instruction file was synced
      expect(mockClient.request).toHaveBeenCalledWith("agents.files.set", {
        agentId: "paperclip-agent-123",
        name: "AGENTS.md",
        content: "Perform instruction sync test",
      });
    });

    it("skips name update if remote agent name already matches", async () => {
      const ctx = buildContext({
        instructionsFilePath: "/tmp/fake/AGENTS.md",
        paperclipApiUrl: "http://localhost:3100",
      });

      mockClient.request.mockImplementation(async (method: string, params: any) => {
        if (method === "agents.list") {
          return [{ agentId: "paperclip-agent-123", name: "Acme Corp - CEO" }];
        }
        if (method === "agents.files.list") {
          return [{ name: "AGENTS.md", size: 5 }];
        }
        return null;
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ name: "Acme Corp" }),
      } as any);

      mockFsReadFile.mockImplementation(async (filePath: string) => {
        if (filePath === "/tmp/fake/AGENTS.md") return "dummy";
        throw new Error("ENOENT");
      });

      await ensureAgentAndSyncInstructions(ctx, mockClient, "paperclip-agent-123");

      expect(mockClient.request).not.toHaveBeenCalledWith("agents.update", expect.objectContaining({ name: expect.any(String) }));
    });

    it("empties remote files absent locally (Case b) and bypasses IDENTITY.md / MEMORY.md", async () => {
      const ctx = buildContext({
        instructionsFilePath: "/tmp/fake/AGENTS.md",
        paperclipApiUrl: "http://localhost:3100",
      });

      let filesListCallCount = 0;
      mockClient.request.mockImplementation(async (method: string, params: any) => {
        if (method === "agents.list") {
          return [{ agentId: "paperclip-agent-123", name: "Acme Corp - CEO" }];
        }
        if (method === "agents.files.list") {
          filesListCallCount++;
          if (filesListCallCount === 1) {
            // First call returns target instruction, extra files (SOUL.md, IDENTITY.md, MEMORY.md)
            return [
              { name: "AGENTS.md", size: 5 },
              { name: "SOUL.md", size: 100 },
              { name: "IDENTITY.md", size: 200 },
              { name: "MEMORY.md", size: 300 },
            ];
          }
          // Second call: after emptying SOUL.md, it should match
          return [
            { name: "AGENTS.md", size: 5 },
            { name: "SOUL.md", size: 0 },
            { name: "IDENTITY.md", size: 200 },
            { name: "MEMORY.md", size: 300 },
          ];
        }
        if (method === "agents.files.set") {
          return { ok: true };
        }
        return null;
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ name: "Acme Corp" }),
      } as any);

      mockFsReadFile.mockImplementation(async (filePath: string) => {
        if (filePath === "/tmp/fake/AGENTS.md") return "dummy"; // size 5
        throw new Error("ENOENT");
      });

      await ensureAgentAndSyncInstructions(ctx, mockClient, "paperclip-agent-123");

      // Verify SOUL.md was emptied immediately inside the loop
      expect(mockClient.request).toHaveBeenCalledWith("agents.files.set", {
        agentId: "paperclip-agent-123",
        name: "SOUL.md",
        content: "",
      });

      // Verify IDENTITY.md and MEMORY.md were strictly bypassed and NEVER emptied
      expect(mockClient.request).not.toHaveBeenCalledWith("agents.files.set", {
        agentId: "paperclip-agent-123",
        name: "IDENTITY.md",
        content: "",
      });
      expect(mockClient.request).not.toHaveBeenCalledWith("agents.files.set", {
        agentId: "paperclip-agent-123",
        name: "MEMORY.md",
        content: "",
      });
    });

    it("logs a warning to stdout if instruction loop fails to converge after 3 attempts", async () => {
      const ctx = buildContext({
        instructionsFilePath: "/tmp/fake/AGENTS.md",
        paperclipApiUrl: "http://localhost:3100",
      });

      mockClient.request.mockImplementation(async (method: string, params: any) => {
        if (method === "agents.list") {
          return [{ agentId: "paperclip-agent-123", name: "Acme Corp - CEO" }];
        }
        if (method === "agents.files.list") {
          // Always return mismatch size so it keeps trying to sync
          return [{ name: "AGENTS.md", size: 999 }];
        }
        if (method === "agents.files.set") {
          return { ok: true };
        }
        return null;
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ name: "Acme Corp" }),
      } as any);

      mockFsReadFile.mockImplementation(async (filePath: string) => {
        if (filePath === "/tmp/fake/AGENTS.md") return "dummy"; // size 5
        throw new Error("ENOENT");
      });

      const logs: string[] = [];
      const loggedCtx = {
        ...ctx,
        onLog: async (type: string, chunk: string) => {
          logs.push(chunk);
        },
      };

      initLogger(loggedCtx.onLog);

      await ensureAgentAndSyncInstructions(loggedCtx, mockClient, "paperclip-agent-123");

      expect(logs.some((l) => l.includes("WARNING: Instruction files injection loop could not get the \"Nothing to do\" scenario"))).toBe(true);
    });

    it("uses byte length (not char length) for multi-byte content so files converge in one iteration", async () => {
      const ctx = buildContext({
        instructionsFilePath: "/tmp/fake/AGENTS.md",
        paperclipApiUrl: "http://localhost:3100",
      });

      // Content with multi-byte characters: 4 arrow chars (→ = 3 UTF-8 bytes each)
      const contentWithArrows = "Step 1 → Step 2 → Step 3 → Step 4 →";
      const charLength = contentWithArrows.length; // 37 chars
      const byteLength = Buffer.byteLength(contentWithArrows, "utf8"); // 45 bytes

      mockClient.request.mockImplementation(async (method: string) => {
        if (method === "agents.list") {
          return [{ agentId: "paperclip-agent-123", name: "Acme Corp - CEO" }];
        }
        if (method === "agents.files.list") {
          // Remote reports byte size from stat — should match byteLength
          return [{ name: "AGENTS.md", size: byteLength }];
        }
        return null;
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ name: "Acme Corp" }),
      } as any);

      mockFsReadFile.mockImplementation(async (filePath: string) => {
        if (filePath === "/tmp/fake/AGENTS.md") return contentWithArrows;
        throw new Error("ENOENT");
      });

      const logs: string[] = [];
      const loggedCtx = {
        ...ctx,
        onLog: async (type: string, chunk: string) => {
          logs.push(chunk);
        },
      };

      initLogger(loggedCtx.onLog);

      await ensureAgentAndSyncInstructions(loggedCtx, mockClient, "paperclip-agent-123");

      // Verify it converged immediately — no Case A updates performed
      expect(logs.some((l) => l.includes("perfectly in sync"))).toBe(true);
      expect(logs.some((l) => l.includes("Case A"))).toBe(false);

      // Verify agents.files.set was NOT called for AGENTS.md (no update needed)
      expect(mockClient.request).not.toHaveBeenCalledWith("agents.files.set", expect.objectContaining({
        name: "AGENTS.md",
      }));

      // Sanity: char length differs from byte length
      expect(charLength).not.toBe(byteLength);
    });

    it("clears IDENTITY.md before agents.update when names differ (correct ordering)", async () => {
      const ctx = buildContext({
        instructionsFilePath: "/tmp/fake/AGENTS.md",
        paperclipApiUrl: "http://localhost:3100",
      });

      const callOrder: string[] = [];

      mockClient.request.mockImplementation(async (method: string, params: any) => {
        if (method === "agents.list") {
          // Remote name differs from expected
          return [{ agentId: "paperclip-agent-123", name: "Old Name" }];
        }
        if (method === "agents.files.set") {
          callOrder.push(`files.set:${params.name}:content=${params.content === "" ? "EMPTY" : "DATA"}`);
          return { ok: true };
        }
        if (method === "agents.update") {
          callOrder.push(`update:${params.name}`);
          return { ok: true };
        }
        if (method === "agents.files.list") {
          return [{ name: "AGENTS.md", size: Buffer.byteLength("dummy", "utf8") }];
        }
        return null;
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ name: "Acme Corp" }),
      } as any);

      mockFsReadFile.mockImplementation(async (filePath: string) => {
        if (filePath === "/tmp/fake/AGENTS.md") return "dummy";
        throw new Error("ENOENT");
      });

      await ensureAgentAndSyncInstructions(ctx, mockClient, "paperclip-agent-123");

      // Verify IDENTITY.md clear happens BEFORE agents.update
      const clearIdx = callOrder.findIndex((c) => c === "files.set:IDENTITY.md:content=EMPTY");
      const updateIdx = callOrder.findIndex((c) => c.startsWith("update:"));
      expect(clearIdx).toBeGreaterThanOrEqual(0);
      expect(updateIdx).toBeGreaterThanOrEqual(0);
      expect(clearIdx).toBeLessThan(updateIdx);

      // Verify actual calls
      expect(mockClient.request).toHaveBeenCalledWith("agents.files.set", {
        agentId: "paperclip-agent-123",
        name: "IDENTITY.md",
        content: "",
      });
      expect(mockClient.request).toHaveBeenCalledWith("agents.update", {
        agentId: "paperclip-agent-123",
        name: "Acme Corp - CEO",
        emoji: "📎",
      });
    });
  });

  describe("registerSessionTokenInBootstrap", () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = {
        request: vi.fn(),
      };
    });

    it("creates a new registry if BOOTSTRAP.md does not exist", async () => {
      const logs: string[] = [];
      const ctx = buildContext({}, {
        onLog: async (type, chunk) => {
          logs.push(`${type}:${chunk.trim()}`);
        }
      });

      initLogger(ctx.onLog);

      let bootstrapContent: string | null = null;

      mockClient.request.mockImplementation(async (method: string, params: any) => {
        if (method === "agents.files.get") {
          if (params.name === "BOOTSTRAP.md" && bootstrapContent !== null) {
            return { file: { name: "BOOTSTRAP.md", content: bootstrapContent } };
          }
          throw new Error("File not found");
        }
        if (method === "agents.files.set") {
          if (params.name === "BOOTSTRAP.md") {
            bootstrapContent = params.content;
          }
          return { ok: true };
        }
        return null;
      });

      await registerSessionTokenInBootstrap(ctx, mockClient, "paperclip-agent-123", "run-123", "token-123");

      expect(mockClient.request).toHaveBeenCalledWith("agents.files.set", {
        agentId: "paperclip-agent-123",
        name: "BOOTSTRAP.md",
        content: [
          "# Session Registry",
          "This registry maps session run IDs to authentication tokens.",
          "- run-123: token-123",
        ].join("\n"),
      });
      expect(logs.some((l) => l.includes("Registering session token for runId=run-123"))).toBe(true);
    });

    it("appends and prunes mappings if BOOTSTRAP.md already exists", async () => {
      const logs: string[] = [];
      const ctx = buildContext({}, {
        onLog: async (type, chunk) => {
          logs.push(`${type}:${chunk.trim()}`);
        }
      });

      initLogger(ctx.onLog);

      // Existing bootstrap with some older mappings
      let bootstrapContent = [
        "# Session Registry",
        "This registry maps session run IDs to authentication tokens.",
        "- run-999: token-999",
      ].join("\n");

      mockClient.request.mockImplementation(async (method: string, params: any) => {
        if (method === "agents.files.get") {
          if (params.name === "BOOTSTRAP.md") {
            return { file: { name: "BOOTSTRAP.md", content: bootstrapContent } };
          }
          throw new Error("File not found");
        }
        if (method === "agents.files.set") {
          if (params.name === "BOOTSTRAP.md") {
            bootstrapContent = params.content;
          }
          return { ok: true };
        }
        return null;
      });

      await registerSessionTokenInBootstrap(ctx, mockClient, "paperclip-agent-123", "run-123", "token-123");

      expect(mockClient.request).toHaveBeenCalledWith("agents.files.set", {
        agentId: "paperclip-agent-123",
        name: "BOOTSTRAP.md",
        content: [
          "# Session Registry",
          "This registry maps session run IDs to authentication tokens.",
          "- run-999: token-999",
          "- run-123: token-123",
        ].join("\n"),
      });
    });

    it("raises an error if BOOTSTRAP.md verification fails after 3 attempts", async () => {
      const ctx = buildContext({});
      mockClient.request.mockImplementation(async (method: string) => {
        if (method === "agents.files.get") {
          throw new Error("File not found");
        }
        if (method === "agents.files.set") {
          return { ok: true };
        }
        return null;
      });

      await expect(
        registerSessionTokenInBootstrap(ctx, mockClient, "paperclip-agent-123", "run-123", "token-123")
      ).rejects.toThrow("Failed to inject and verify BOOTSTRAP.md token registry after 3 attempts.");
    });
  });
});

