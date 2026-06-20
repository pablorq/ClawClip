import { describe, expect, it, vi } from "vitest";
import { runVerifiedAgentTask, syncPaperclipSkills } from "../src/server/execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { initLogger } from "../src/server/logger.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

describe("syncPaperclipSkills resilience", () => {
  it("retries sub-tasks during sync injection phase on transient failures", async () => {
    const ctx = {
      runId: "run-123",
      onLog: vi.fn(),
      config: {},
    } as unknown as AdapterExecutionContext;

    initLogger(ctx.onLog);

    const mockRequest = vi.fn();
    const client = {
      request: mockRequest,
      isConnected: () => true,
      onLog: vi.fn(),
    } as any;

    const fileHash = crypto.createHash("sha256").update("content1").digest("hex");
    const manifest = `${fileHash}  ./file1.txt\n`;
    const realLocalAggregateHash = crypto.createHash("sha256").update(manifest).digest("hex");
    const remoteAggregateHash = "b".repeat(64);

    // Mock sequence matching the strict nested Loop A / Loop B paths:
    // --- Loop A (Attempt 1) ---
    // 1. Loop B Attempt 1: Returns Mismatch
    mockRequest.mockImplementationOnce(async () => {
      setTimeout(() => {
        client.onSyncEvent?.(`HASH_RESULT:${remoteAggregateHash}:paperclip\n[DONE:HASHES]`, "agent:main:paperclip:run:123");
      }, 50);
      return { runId: "list-run-1", status: "accepted" };
    });

    // 2. Loop B Attempt 2: Returns Mismatch
    mockRequest.mockImplementationOnce(async () => {
      setTimeout(() => {
        client.onSyncEvent?.(`HASH_RESULT:${remoteAggregateHash}:paperclip\n[DONE:HASHES]`, "agent:main:paperclip:run:123");
      }, 50);
      return { runId: "list-run-2", status: "accepted" };
    });

    // 3. Loop B Attempt 3: Returns Mismatch
    mockRequest.mockImplementationOnce(async () => {
      setTimeout(() => {
        client.onSyncEvent?.(`HASH_RESULT:${remoteAggregateHash}:paperclip\n[DONE:HASHES]`, "agent:main:paperclip:run:123");
      }, 50);
      return { runId: "list-run-3", status: "accepted" };
    });

    // 4. Injection: SYNC_ZIP (Attempt 1): FAIL (simulate gateway error)
    mockRequest.mockImplementationOnce(async () => {
      throw new Error("⚠️ API rate limit reached");
    });

    // --- Loop A (Attempt 2) ---
    // 5. Loop B Attempt 1: Returns Mismatch
    mockRequest.mockImplementationOnce(async () => {
      setTimeout(() => {
        client.onSyncEvent?.(`HASH_RESULT:${remoteAggregateHash}:paperclip\n[DONE:HASHES]`, "agent:main:paperclip:run:123");
      }, 50);
      return { runId: "list-run-4", status: "accepted" };
    });

    // 6. Loop B Attempt 2: Returns Mismatch
    mockRequest.mockImplementationOnce(async () => {
      setTimeout(() => {
        client.onSyncEvent?.(`HASH_RESULT:${remoteAggregateHash}:paperclip\n[DONE:HASHES]`, "agent:main:paperclip:run:123");
      }, 50);
      return { runId: "list-run-5", status: "accepted" };
    });

    // 7. Loop B Attempt 3: Returns Mismatch
    mockRequest.mockImplementationOnce(async () => {
      setTimeout(() => {
        client.onSyncEvent?.(`HASH_RESULT:${remoteAggregateHash}:paperclip\n[DONE:HASHES]`, "agent:main:paperclip:run:123");
      }, 50);
      return { runId: "list-run-6", status: "accepted" };
    });

    // 8. Injection: SYNC_ZIP (Attempt 2): SUCCESS
    mockRequest.mockImplementationOnce(async () => {
      setTimeout(() => {
        client.onSyncEvent?.("OK: MULTI_SYNC", "agent:main:paperclip:run:123");
      }, 50);
      return { runId: "write-run-success", status: "accepted" };
    });

    // --- Loop A (Attempt 3) ---
    // 9. Loop B Attempt 1: Returns Match (Bypass, success!)
    mockRequest.mockImplementationOnce(async () => {
      setTimeout(() => {
        client.onSyncEvent?.(`HASH_RESULT:${realLocalAggregateHash}:paperclip\n[DONE:HASHES]`, "agent:main:paperclip:run:123");
      }, 50);
      return { runId: "list-run-7", status: "accepted" };
    });

    // Setup local file
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-test-"));
    await fs.writeFile(path.join(tmpDir, "file1.txt"), "content1");
    const localSkill = { key: "paperclip", runtimeName: "paperclip", source: tmpDir } as any;

    await syncPaperclipSkills(
      ctx, client, [localSkill], "paperclip:run:123"
    );

    // Verify 2 zip calls were made (1st failed/timedout, 2nd retried)
    const zipCalls = mockRequest.mock.calls.filter(c => c[1].message?.includes("SYNC_ZIP"));
    expect(zipCalls.length).toBe(2);

    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 30000);

  it("recovers from dual-field payloads (text + delta) where text is cumulative", async () => {
    const ctx = {
      runId: "run-456",
      onLog: vi.fn(),
      config: {},
    } as any;

    initLogger(ctx.onLog);
    
    const sessionKey = "agent:main:paperclip:run:456";
    
    const data = {
      text: "c3fb37c3d610f20a83cfd35a4453aa7391701f231492db261c0404c052a9ca84  ./TestFile01.md\n\n[DONE:HASHES]",
    };

    const client = {
      request: vi.fn().mockImplementation(async () => {
        setTimeout(() => {
          client.onSyncEvent?.(data.text, sessionKey);
        }, 50);
        return { runId: "sub-run-1", status: "accepted" };
      }),
      isConnected: () => true,
    } as any;

    const result = await runVerifiedAgentTask(
      ctx, 
      client, 
      "list-checksums", 
      "hashes", 
      sessionKey, 
      5000
    );
    expect(result).toContain("c3fb37c3d610f20a83cfd35a4453aa7391701f231492db261c0404c052a9ca84");
  });
});
