import * as ServerUtils from "@paperclipai/adapter-utils/server-utils";

// ---------------------------------------------------------------------------
// Skill sync for paperclip-openclaw-bridge
//
// The published @paperclipai/adapter-utils (0.3.x) does not yet export the
// skill-related types (AdapterSkillContext, AdapterSkillEntry, etc.) or the
// skill utility functions.
//
// This compatibility module handles the bridge between the adapter and the
// Paperclip skill contract. It attempts to use upstream utilities if they
// exist, and falls back to local implementations otherwise.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Skill types (mirrors the upstream type contract)
// ---------------------------------------------------------------------------

export type AdapterSkillSyncMode = "unsupported" | "persistent" | "ephemeral";

export type AdapterSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export type AdapterSkillOrigin =
  | "company_managed"
  | "paperclip_required"
  | "user_installed"
  | "external_unknown";

export interface AdapterSkillEntry {
  key: string;
  runtimeName: string | null;
  desired: boolean;
  managed: boolean;
  required?: boolean;
  requiredReason?: string | null;
  state: AdapterSkillState;
  origin?: AdapterSkillOrigin;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface AdapterSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: AdapterSkillSyncMode;
  desiredSkills: string[];
  entries: AdapterSkillEntry[];
  warnings: string[];
}

export interface AdapterSkillContext {
  agentId: string;
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Parsed skill entry from config.paperclipRuntimeSkills
// ---------------------------------------------------------------------------

export interface SkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  required: boolean;
  requiredReason: string | null;
}

// ---------------------------------------------------------------------------
// Config parsing helpers
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/**
 * Local fallback for parsing runtime skill entries.
 */
function localParseRuntimeSkillEntries(value: unknown): SkillEntry[] {
  if (!Array.isArray(value)) return [];

  const entries: SkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;

    entries.push({
      key,
      runtimeName,
      source,
      required: asBoolean(entry.required, false),
      requiredReason:
        typeof entry.requiredReason === "string" && entry.requiredReason.trim().length > 0
          ? entry.requiredReason.trim()
          : null,
    });
  }
  return entries;
}

/**
 * Public wrapper that favors upstream readPaperclipRuntimeSkillEntries if available.
 * Returns both configured skills and any skills bundled with the adapter.
 */
export async function readRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
): Promise<SkillEntry[]> {
  const upstream = (ServerUtils as any).readPaperclipRuntimeSkillEntries;
  if (typeof upstream === "function") {
    return await upstream(config, moduleDir);
  }

  // Fallback: only use the skills from the config. 
  // We don't bother with local discovery in the fallback because the 
  // bridge currently doesn't have any bundled skills.
  return localParseRuntimeSkillEntries(config.paperclipRuntimeSkills);
}

/**
 * Read the desired skill preference stored in adapterConfig.paperclipSkillSync.
 */
function readDesiredSkillPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

/**
 * Resolve the final desired skill list, always including required skills.
 * Favors upstream resolvePaperclipDesiredSkillNames if available.
 */
export function resolveDesiredSkills(
  config: Record<string, unknown>,
  availableEntries: SkillEntry[],
): string[] {
  const upstream = (ServerUtils as any).resolvePaperclipDesiredSkillNames;
  if (typeof upstream === "function") {
    return upstream(config, availableEntries);
  }

  const preference = readDesiredSkillPreference(config);
  const requiredSkills = availableEntries
    .filter((entry) => entry.required)
    .map((entry) => entry.key);

  if (!preference.explicit) {
    return Array.from(new Set(requiredSkills));
  }

  // Basic canonicalization for the fallback: try to match key or runtimeName
  const canonicalizedDesired = preference.desiredSkills.map((ref) => {
    const match = availableEntries.find(
      (e) => e.key === ref || e.runtimeName === ref || e.key.endsWith(`/${ref}`),
    );
    return match ? match.key : ref;
  });

  return Array.from(new Set([...requiredSkills, ...canonicalizedDesired]));
}
