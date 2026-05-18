import { describe, expect, it } from "vitest";
import { listBridgeSkills, syncBridgeSkills } from "../src/server/skills.js";

const PAPERCLIP_KEY = "paperclipai/paperclip/paperclip";

function makeSkillEntry(key: string, options: { required?: boolean } = {}) {
  const runtimeName = key.split("/").pop() ?? key;
  return {
    key,
    runtimeName,
    source: `/fake/skills/${runtimeName}`,
    required: options.required ?? false,
    requiredReason: options.required ? "Required by Paperclip" : null,
  };
}

function makeContext(config: Record<string, unknown> = {}) {
  return {
    agentId: "agent-test-1",
    companyId: "company-test-1",
    adapterType: "openclaw_bridge",
    config,
  };
}

describe("openclaw_bridge skill sync", () => {
  it("returns ephemeral supported snapshot with no skills configured", async () => {
    const ctx = makeContext({
      paperclipRuntimeSkills: [],
    });

    const snapshot = await listBridgeSkills(ctx);

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.adapterType).toBe("openclaw_bridge");
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.desiredSkills).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
  });

  it("shows available skills as configured when desired", async () => {
    const skillA = makeSkillEntry("company/repo/skill-a");
    const skillB = makeSkillEntry("company/repo/skill-b");

    const ctx = makeContext({
      paperclipRuntimeSkills: [skillA, skillB],
      paperclipSkillSync: {
        desiredSkills: [skillA.key],
      },
    });

    const snapshot = await listBridgeSkills(ctx);

    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.desiredSkills).toContain(skillA.key);
    expect(snapshot.desiredSkills).not.toContain(skillB.key);

    const entryA = snapshot.entries.find((e) => e.key === skillA.key);
    expect(entryA).toBeDefined();
    expect(entryA?.state).toBe("configured");
    expect(entryA?.desired).toBe(true);
    expect(entryA?.managed).toBe(true);
    expect(entryA?.origin).toBe("company_managed");
    expect(entryA?.detail).toMatch(/Will be materialized/i);

    const entryB = snapshot.entries.find((e) => e.key === skillB.key);
    expect(entryB).toBeDefined();
    expect(entryB?.state).toBe("available");
    expect(entryB?.desired).toBe(false);
  });

  it("warns on desired skill not found in available entries", async () => {
    const existing = makeSkillEntry("company/repo/real-skill");
    const missingKey = "company/repo/nonexistent-skill";

    const ctx = makeContext({
      paperclipRuntimeSkills: [existing],
      paperclipSkillSync: {
        desiredSkills: [existing.key, missingKey],
      },
    });

    const snapshot = await listBridgeSkills(ctx);

    expect(snapshot.warnings.length).toBeGreaterThan(0);
    expect(snapshot.warnings[0]).toContain(missingKey);

    const missingEntry = snapshot.entries.find((e) => e.key === missingKey);
    expect(missingEntry).toBeDefined();
    expect(missingEntry?.state).toBe("missing");
    expect(missingEntry?.origin).toBe("external_unknown");
    expect(missingEntry?.desired).toBe(true);
  });

  it("includes required skills in desiredSkills even without explicit preference", async () => {
    const requiredSkill = makeSkillEntry(PAPERCLIP_KEY, { required: true });
    const optionalSkill = makeSkillEntry("company/repo/optional");

    const ctx = makeContext({
      paperclipRuntimeSkills: [requiredSkill, optionalSkill],
    });

    const snapshot = await listBridgeSkills(ctx);

    expect(snapshot.desiredSkills).toContain(PAPERCLIP_KEY);
    expect(snapshot.desiredSkills).not.toContain(optionalSkill.key);

    const entry = snapshot.entries.find((e) => e.key === PAPERCLIP_KEY);
    expect(entry).toBeDefined();
    expect(entry?.state).toBe("configured");
    expect(entry?.origin).toBe("paperclip_required");
    expect(entry?.required).toBe(true);
  });

  it("syncBridgeSkills returns the same snapshot shape as listBridgeSkills", async () => {
    const skill = makeSkillEntry("company/repo/sync-test");

    const ctx = makeContext({
      paperclipRuntimeSkills: [skill],
      paperclipSkillSync: {
        desiredSkills: [skill.key],
      },
    });

    const listSnapshot = await listBridgeSkills(ctx);
    const syncSnapshot = await syncBridgeSkills(ctx, [skill.key]);

    expect(syncSnapshot.supported).toBe(listSnapshot.supported);
    expect(syncSnapshot.mode).toBe(listSnapshot.mode);
    expect(syncSnapshot.adapterType).toBe(listSnapshot.adapterType);
    expect(syncSnapshot.desiredSkills).toEqual(listSnapshot.desiredSkills);
    expect(syncSnapshot.entries.length).toBe(listSnapshot.entries.length);
    expect(syncSnapshot.warnings).toEqual(listSnapshot.warnings);
  });
});
