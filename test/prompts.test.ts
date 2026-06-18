import { describe, expect, it } from "vitest";
import {
  determineWakePromptType,
  buildCachingOptimizedPrompt,
  buildSkillSyncListPrompt,
  buildSkillSyncZipPrompt,
  stringifyWakePayload,
} from "../src/server/prompts.js";
import type { SkillEntry } from "../src/server/skill-compat.js";

describe("prompts state detection", () => {
  it("defaults to heartbeat on empty context", () => {
    expect(determineWakePromptType(undefined)).toBe("heartbeat");
    expect(determineWakePromptType({})).toBe("heartbeat");
  });

  it("detects resume if livenessContinuation attempt > 1 or state exists", () => {
    expect(determineWakePromptType({ livenessContinuation: { attempt: 2 } })).toBe("resume");
    expect(determineWakePromptType({ livenessContinuation: { attempt: 1, state: "active" } })).toBe("resume");
    expect(determineWakePromptType({ livenessContinuation: { attempt: 1 } })).toBe("wake");
  });

  it("detects resume if executionStage lastDecisionOutcome exists", () => {
    expect(determineWakePromptType({ executionStage: { lastDecisionOutcome: "retry" } })).toBe("resume");
    expect(determineWakePromptType({ executionStage: {} })).toBe("wake");
  });

  it("detects resume if checkedOutByHarness is true", () => {
    expect(determineWakePromptType({ checkedOutByHarness: true })).toBe("resume");
    expect(determineWakePromptType({ checkedOutByHarness: false })).toBe("wake");
  });

  it("detects resume if continuationSummary body exists", () => {
    expect(determineWakePromptType({ continuationSummary: { body: "progress log" } })).toBe("resume");
    expect(determineWakePromptType({ continuationSummary: {} })).toBe("wake");
  });
});

describe("caching-optimized prompt construction", () => {
  const mockAgent = { id: "agent-123", name: "Claude Coder" };
  const mockSkills: SkillEntry[] = [
    { key: "paperclip", runtimeName: "paperclip", path: "", hash: "" },
    { key: "clawsweeper", runtimeName: "clawsweeper", path: "", hash: "" },
  ];
  const mockEnv = {
    PAPERCLIP_AGENT_ID: "agent-123",
    PAPERCLIP_COMPANY_ID: "company-456",
    PAPERCLIP_API_URL: "http://localhost:3100",
    PAPERCLIP_RUN_ID: "run-789",
    PAPERCLIP_MAIN_WORKSPACE_DIR: "/home/node/.openclaw/workspace-paperclip/company-456/main",
  };
  const mockWake = {
    reason: "issue_assigned",
    latestCommentId: "comment-1",
    issue: { identifier: "ISS-1", title: "Fix the bridge", status: "todo", priority: "high" },
  };

  it("constructs a clean markdown layout with '#' headers and a bulleted list of skills", () => {
    const prompt = buildCachingOptimizedPrompt({
      agent: mockAgent,
      desiredSkills: mockSkills,
      paperclipEnv: mockEnv,
      paperclipWake: mockWake,
    });

    // Verify markdown headers
    expect(prompt).toContain("# Persona & Rules (Static System Instructions)");
    expect(prompt).toContain("# Dynamic Context (Active Event Payload)");
    expect(prompt).toContain("## Parsed Event Type: WAKE_PAYLOAD (Cold Start)");
    expect(prompt).not.toContain("====");

    // Verify collaborative main workspace instructions are present
    expect(prompt).toContain("## Collaborative Main Workspace Instruction:");
    expect(prompt).toContain("/home/node/.openclaw/workspace-paperclip/company-456/main");

    // Verify bulleted list of skills
    expect(prompt).toContain("- clawsweeper");
    expect(prompt).not.toContain("<available_skills>");
    expect(prompt).not.toContain("- paperclip"); // Paperclip excluded since it is the main driver

    // Verify JSON details inside dynamic suffix
    expect(prompt).toContain('"PAPERCLIP_WAKE_PAYLOAD_JSON":');
    expect(prompt).toContain('"PAPERCLIP_MAIN_WORKSPACE_DIR": "/home/node/.openclaw/workspace-paperclip/company-456/main"');
    expect(prompt).not.toContain('"state": "WAKE_PAYLOAD"');
  });

  it("adjusts dynamic instructions when resuming an active session", () => {
    const resumeWake = {
      ...mockWake,
      checkedOutByHarness: true,
    };
    const prompt = buildCachingOptimizedPrompt({
      agent: mockAgent,
      desiredSkills: mockSkills,
      paperclipEnv: mockEnv,
      paperclipWake: resumeWake,
    });

    expect(prompt).toContain("## Parsed Event Type: Paperclip Resume Delta");
    expect(prompt).not.toContain('"state": "RESUME_DELTA"');
  });

  it("includes error-loop guardrail in the static instructions", () => {
    const prompt = buildCachingOptimizedPrompt({
      agent: mockAgent,
      desiredSkills: mockSkills,
      paperclipEnv: mockEnv,
      paperclipWake: mockWake,
    });

    expect(prompt).toContain("Error Loop Guardrail");
    expect(prompt).toContain("If you experience any error");
    expect(prompt).toContain("ERROR: <last_error_message>");
    expect(prompt).toContain("Direct Value Fallback");
    expect(prompt).toContain("Execution Boundary");
    expect(prompt).toContain("operate strictly within this designated company");
  });

  it("includes correct programmatic key auto-loading instruction in the static instructions", () => {
    const prompt = buildCachingOptimizedPrompt({
      agent: mockAgent,
      desiredSkills: mockSkills,
      paperclipEnv: mockEnv,
      paperclipWake: mockWake,
    });

    expect(prompt).toContain("Initial Extraction");
    expect(prompt).toContain("Continuous Injection");
    expect(prompt).toContain("grep $PAPERCLIP_RUN_ID BOOTSTRAP.md | cut -d' ' -f3");
    expect(prompt).toContain("Anti-Patterns");
  });

  it("constructs correct heartbeat prompt layout when paperclipWake is empty", () => {
    const prompt = buildCachingOptimizedPrompt({
      agent: mockAgent,
      desiredSkills: mockSkills,
      paperclipEnv: mockEnv,
      paperclipWake: {},
    });

    expect(prompt).toContain("## Parsed Event Type: HEARTBEAT (Background Maintenance)");
    expect(prompt).toContain("You are running on a scheduled or manual background maintenance heartbeat.");
    expect(prompt).toContain('"PAPERCLIP_AGENT_ID": "agent-123"');
  });

  it("strips trailing slash from PAPERCLIP_API_URL in prompt environment block", () => {
    const envWithSlash = {
      ...mockEnv,
      PAPERCLIP_API_URL: "http://localhost:3100/",
    };
    const prompt = buildCachingOptimizedPrompt({
      agent: mockAgent,
      desiredSkills: mockSkills,
      paperclipEnv: envWithSlash,
      paperclipWake: mockWake,
    });

    expect(prompt).toContain('"PAPERCLIP_API_URL": "http://localhost:3100"');
    expect(prompt).not.toContain('"PAPERCLIP_API_URL": "http://localhost:3100/"');
  });


});

describe("utility prompts", () => {
  it("constructs correct skill list prompt", () => {
    const listPrompt = buildSkillSyncListPrompt("/target", "skillA skillB");
    expect(listPrompt).toContain("ACTION: GET_MULTIPLE_HASHES");
    expect(listPrompt).toContain("/target");
  });

  it("constructs correct skill sync zip prompt", () => {
    const syncPrompt = buildSkillSyncZipPrompt("/target", "/tmp/zip", "zipName", "rm -rf old");
    expect(syncPrompt).toContain("ACTION: SYNC_ZIP");
    expect(syncPrompt).toContain("rm -rf old");
  });
});
