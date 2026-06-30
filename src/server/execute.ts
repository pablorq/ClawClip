import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeServiceReport,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  buildPaperclipEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import AdmZip from "adm-zip";
import {
  readRuntimeSkillEntries,
  type SkillEntry,
} from "./skill-compat.js";
import {
  buildSkillSyncListPrompt,
  buildSkillSyncZipPrompt,
  stringifyWakePayload,
  buildCachingOptimizedPrompt,
  type WakePayload,
} from "./prompts.js";
import { ensureAgentAndSyncInstructions, registerSessionTokenInBootstrap, resolvePaperclipApiUrl } from "./agent-manager.js";
import { toLog, initLogger, logContextStorage, type LoggerContext } from "./logger.js";
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
  PROTOCOL_VERSION,
} from "./adapter.js";

// Promise-based lightweight Mutex to serialize sandbox spawns across concurrent runs
class SimpleMutex {
  private queue = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void = () => { };
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = this.queue;
    this.queue = this.queue.then(() => next);
    await current;
    return release;
  }
}

export const spawningMutex = new SimpleMutex();

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

type SessionKeyStrategy = "fixed" | "issue" | "run";

type GatewayRequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
};

type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  expectFinal: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

type GatewayResponseError = Error & {
  gatewayCode?: string;
  gatewayDetails?: Record<string, unknown>;
};

type GatewayClientOptions = {
  url: string;
  headers: Record<string, string>;
  onEvent: (frame: GatewayEventFrame) => Promise<void> | void;
};

type GatewayClientRequestOptions = {
  timeoutMs: number;
  expectFinal?: boolean;
};

const DEFAULT_SCOPES = ["operator.admin", "operator.pairing"];
const DEFAULT_CLIENT_ID = "gateway-client";
const DEFAULT_CLIENT_MODE = "backend";
const DEFAULT_CLIENT_VERSION = "paperclip";
const DEFAULT_ROLE = "operator";

const SENSITIVE_LOG_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)|^x-openclaw-(auth|token)$/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseOptionalPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return Math.max(1, Math.floor(parsed));
  }
  return null;
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const normalized = asString(value, "issue").trim().toLowerCase();
  if (normalized === "fixed" || normalized === "run") return normalized;
  return "issue";
}

function prefixSessionKeyForAgent(sessionKey: string, agentId: string | null): string {
  if (!agentId || sessionKey.startsWith("agent:")) return sessionKey;
  return `agent:${agentId}:${sessionKey}`;
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  configuredSessionKey: string | null;
  agentId: string | null;
  runId: string;
  issueId: string | null;
}): string {
  const fallback = input.configuredSessionKey ?? "paperclip";
  if (input.strategy === "run") {
    return prefixSessionKeyForAgent(`paperclip:run:${input.runId}`, input.agentId);
  }
  if (input.strategy === "issue" && input.issueId) {
    return prefixSessionKeyForAgent(`paperclip:issue:${input.issueId}`, input.agentId);
  }
  return prefixSessionKeyForAgent(fallback, input.agentId);
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function normalizeScopes(value: unknown): string[] {
  const parsed = toStringArray(value);
  return parsed.length > 0 ? parsed : [...DEFAULT_SCOPES];
}

function headerMapHasIgnoreCase(headers: Record<string, string>, key: string): boolean {
  return Object.keys(headers).some((entryKey) => entryKey.toLowerCase() === key.toLowerCase());
}

function toAuthorizationHeaderValue(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (!trimmed) return trimmed;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_LOG_KEY_PATTERN.test(key.trim());
}

function sha256Prefix(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function redactSecretForLog(value: string): string {
  return `[redacted len=${value.length} sha256=${sha256Prefix(value)}]`;
}

function truncateForLog(value: string, maxChars = 320): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`;
}

function redactForLog(value: unknown, keyPath: string[] = [], depth = 0): unknown {
  const currentKey = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (isSensitiveLogKey(currentKey)) return redactSecretForLog(value);
    return truncateForLog(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 6) return "[array-truncated]";
    const out = value.slice(0, 20).map((entry, index) => redactForLog(entry, [...keyPath, `${index}`], depth + 1));
    if (value.length > 20) out.push(`[+${value.length - 20} more items]`);
    return out;
  }
  if (typeof value === "object") {
    if (depth >= 6) return "[object-truncated]";
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, 80)) {
      out[key] = redactForLog(entry, [...keyPath, key], depth + 1);
    }
    if (entries.length > 80) {
      out.__truncated__ = `+${entries.length - 80} keys`;
    }
    return out;
  }
  return String(value);
}

// Unified logging helpers are imported from logger.ts

async function walkDir(
  rootPath: string,
  relativePath: string,
  files: { path: string; content: string; localHash: string }[]
): Promise<void> {
  const fullPath = path.join(rootPath, relativePath);
  const stats = await fs.stat(fullPath);

  if (stats.isDirectory()) {
    const entries = await fs.readdir(fullPath);
    for (const entry of entries) {
      // Exclude hidden files and .checksum
      if (entry.startsWith(".") || entry === ".checksum") continue;
      await walkDir(rootPath, path.join(relativePath, entry), files);
    }
  } else if (stats.isFile()) {
    const content = await fs.readFile(fullPath, "utf8");
    files.push({
      path: relativePath,
      content,
      localHash: crypto.createHash("sha256").update(content).digest("hex"),
    });
  }
}

async function createMultiSkillZip(ctx: AdapterExecutionContext, skills: SkillEntry[]): Promise<Buffer> {
  const zip = new AdmZip();
  let count = 0;

  for (const skill of skills) {
    async function addFilesRecursively(currentPath: string, relativePath: string) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === ".checksum") continue;
        const fullPath = path.join(currentPath, entry.name);
        const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;
        if (entry.isDirectory()) {
          await addFilesRecursively(fullPath, relPath);
        } else if (entry.isFile()) {
          const content = await fs.readFile(fullPath);
          zip.addFile(relPath, content);
          count++;
        }
      }
    }

    await addFilesRecursively(skill.source, skill.runtimeName);
  }

  await toLog(`[clawclip] [DEBUG] Created multi-skill ZIP with ${count} files across ${skills.length} skills.`);
  return zip.toBuffer();
}

/**
 * Computes a single SHA-256 hash representing the entire skill state.
 * Matches the shell pipeline: find . -type f | sort | sha256sum
 */
function computeAggregateHash(localMap: Map<string, string>): string {
  // Create lines: <hash>  ./<path>
  const lines = Array.from(localMap.keys()).map(p => `${localMap.get(p)}  ./${p}`);
  // Sort the lines exactly like shell 'sort' (alphabetical by line, which starts with hash)
  lines.sort();
  // sort output usually ends with a newline
  const manifest = lines.join("\n") + "\n";
  return crypto.createHash("sha256").update(manifest).digest("hex");
}

export async function syncPaperclipSkills(
  ctx: AdapterExecutionContext,
  client: GatewayWsClient,
  desiredSkills: SkillEntry[],
  sessionKey: string | undefined,
  targetAgentId?: string
): Promise<void> {
  const targetBaseDir = "~/.openclaw/skills";

  if (!desiredSkills || desiredSkills.length === 0) {
    await toLog(`[clawclip] [DEBUG] No desired skills to sync.`);
    return;
  }

  await toLog(`[clawclip] Starting Skill Sync process...`);

  // 1. Recursive Local Discovery (Pre-calculate everything for all skills)
  const localSkillHashes = new Map<string, string>();
  const localSkillsByRuntimeName = new Map<string, SkillEntry>();

  for (const skill of desiredSkills) {
    const localFiles: { path: string; content: string; localHash: string }[] = [];
    try {
      await walkDir(skill.source, "", localFiles);
      const localMap = new Map(localFiles.map(f => [f.path, f.localHash]));
      const localAggregateHash = computeAggregateHash(localMap);
      localSkillHashes.set(skill.runtimeName, localAggregateHash);
      localSkillsByRuntimeName.set(skill.runtimeName, skill);
    } catch (err) {
      await toLog("stderr", `[clawclip] ERROR: Failed to walk local skill directory for ${skill.runtimeName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const skillDirs = Array.from(localSkillHashes.keys()).join(" ");
  await toLog(`[clawclip] [DEBUG] Prepared local hashes for: ${skillDirs}`);

  // Loop A: Overall Sync Attempt (up to 3 times)
  for (let attemptA = 1; attemptA <= 3; attemptA++) {
    await toLog(`[clawclip] [DEBUG] [LOOP A] (Attempt ${attemptA}/3): Achieving synchronized state for multiple skills...`);

    let lastError: Error | undefined;
    let skillsToSync: SkillEntry[] = [];
    let successMatchFound = false;
    let anyMismatchFound = false;

    // Loop B: Verification (up to 3 times)
    for (let attemptB = 1; attemptB <= 3; attemptB++) {
      try {
        const listPrompt = buildSkillSyncListPrompt(targetBaseDir, skillDirs);

        await toLog(`[clawclip] [DEBUG] [LOOP B] (Attempt ${attemptB}/3): Querying remote aggregate hashes...`);
        const remoteHashesRaw = await runVerifiedAgentTask(ctx, client, listPrompt, "hashes", sessionKey, 60_000, undefined, undefined, targetAgentId);

        // Parse remoteHashesRaw
        const lines = remoteHashesRaw.split("\n");
        const remoteHashes = new Map<string, string>();
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("HASH_RESULT:")) {
            const parts = trimmed.substring("HASH_RESULT:".length).split(":");
            if (parts.length >= 2) {
              const hash = parts[0];
              const dir = parts.slice(1).join(":");
              remoteHashes.set(dir, hash);
            }
          }
        }

        skillsToSync = [];
        for (const [runtimeName, localHash] of localSkillHashes.entries()) {
          const remoteHash = remoteHashes.get(runtimeName);
          if (remoteHash !== localHash) {
            skillsToSync.push(localSkillsByRuntimeName.get(runtimeName)!);
            if (remoteHash === "MISSING") {
              await toLog(`[clawclip] [DEBUG] [MISMATCH] Skill ${runtimeName} is missing remotely.`);
            } else {
              await toLog(`[clawclip] [DEBUG] [MISMATCH] Skill ${runtimeName} mismatch. Local: ${localHash.substring(0, 8)}..., Remote: ${remoteHash ? remoteHash.substring(0, 8) + '...' : 'NONE'}`);
            }
          } else {
            await toLog(`[clawclip] [DEBUG] [SUCCESS] Skill ${runtimeName} matches.`);
          }
        }

        if (skillsToSync.length === 0) {
          successMatchFound = true;
          break; // Success Path: If any attempt reports a match, exit Loop B immediately
        } else {
          anyMismatchFound = true;
          await toLog(`[clawclip] [DEBUG] [LOOP B] (Attempt ${attemptB}/3): Mismatch detected. Continuing verification attempts...`);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await toLog("stderr", `[clawclip] [DEBUG] [ERROR] Loop B attempt ${attemptB}/3 failed: ${lastError.message}`);
      }
    }

    if (successMatchFound) {
      await toLog(`[clawclip] [DEBUG] [SUCCESS] All skills match. Sync complete.`);
      return; // Success Path: Exit the entire skill sync function
    }

    if (anyMismatchFound) {
      await toLog(`[clawclip] [DEBUG] [INJECTION] Proceeding with ZIP-based injection for ${skillsToSync.length} skills...`);

      try {
        const zipBuffer = await createMultiSkillZip(ctx, skillsToSync);
        const zipBase64 = zipBuffer.toString("base64");
        const zipName = "paperclip-skills.zip";
        const zipPath = `~/.openclaw/skills/${zipName}`;

        const deleteCommands = skillsToSync.map(s => `rm -rf ${targetBaseDir}/${s.runtimeName}`).join(" && ");

        const syncPrompt = buildSkillSyncZipPrompt(targetBaseDir, zipPath, zipName, deleteCommands);

        await toLog(`[clawclip] [DEBUG] Injecting ZIP (${zipBuffer.length} bytes)...`);

        await runVerifiedAgentTask(
          ctx, client, syncPrompt, "ok", sessionKey, 300_000,
          [{
            fileName: zipName + ".bin",
            mimeType: "application/zip",
            content: zipBase64
          }],
          undefined,
          targetAgentId
        );

        await toLog(`[clawclip] [DEBUG] Injection phase (ZIP) completed for Loop A attempt ${attemptA}/3. Retrying verification...`);
        continue;
      } catch (err) {
        await toLog("stderr", `[clawclip] [DEBUG] [ERROR] ZIP injection failed: ${err instanceof Error ? err.message : String(err)}`);
        if (attemptA === 3) throw err;
        continue;
      }
    }

    // Failure Path: Loop B completed 3 attempts without ever receiving a matching checksum OR a definitive mismatch (i.e. all attempts failed/timed out)
    await toLog("stderr", `[clawclip] [FATAL] Loop B failed 3 times without definitive result at attempt A=${attemptA}. Exiting bridge.`);
    throw lastError ?? new Error("Sync verification failed: Loop B timeout/error");
  }

  throw new Error("Fatal: Skill sync failed to converge after 3 full attempts (Loop A)");
}

export async function runVerifiedAgentTask(
  ctx: AdapterExecutionContext,
  client: GatewayWsClient,
  prompt: string,
  expectedType: "checksum" | "ok" | "ready" | "done" | "hashes",
  sessionKey: string | undefined,
  timeoutMs = 60_000,
  attachments?: any[],
  expectedPath?: string,
  targetAgentId?: string
): Promise<string> {
  const runId = randomUUID();
  const payloadTemplate = parseObject(ctx.config.payloadTemplate);

  const method = attachments && attachments.length > 0 ? "chat.send" : "agent";
  await client.request<Record<string, unknown>>(
    method,
    {
      ...payloadTemplate,
      message: prompt,
      attachments,
      deliver: false,
      ...(method === "agent" ? {
        bootstrapContextRunKind: "heartbeat",
        timeout: Math.ceil(timeoutMs / 1000), // Convert to seconds for OpenClaw RPC
        ...(targetAgentId
          ? { agentId: targetAgentId }
          : ctx.config.agentId
            ? { agentId: asString(ctx.config.agentId, "") }
            : {}),
      } : {}),
      idempotencyKey: runId,
      sessionKey,
    },
    { timeoutMs: timeoutMs + 5000 },
  );

  return new Promise<string>((resolve, reject) => {
    let isDone = false;

    const timeoutTimer = setTimeout(() => {
      if (isDone) return;
      isDone = true;
      client.onSyncEvent = undefined;
      reject(new Error(`Agent task timed out after ${Math.ceil(timeoutMs / 1000)}s waiting for ${expectedType}.`));
    }, timeoutMs);

    client.onSyncEvent = (text: string, incomingSessionKey: string) => {
      if (isDone) return;
      if (sessionKey && !incomingSessionKey.includes(sessionKey)) return;

      const parsed = parseAgentResponse(text, expectedType, expectedPath);
      if (parsed.result !== "") {
        isDone = true;
        clearTimeout(timeoutTimer);
        client.onSyncEvent = undefined;
        resolve(parsed.result);
      }
    };
  });
}

function stringifyForLog(value: unknown, limit = 10_000): string {
  const text = JSON.stringify(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

export function parseAgentResponse(text: string, expectedType: "checksum" | "ok" | "ready" | "done" | "hashes", expectedPath?: string): { result: string, consumedLength: number } {
  // 1. Handle MISSING (only for checksum - hashes expects full stream completion)
  const missingRegex = /\bMISSING\b/i;
  const missingMatch = text.match(missingRegex);
  if (missingMatch && expectedType === "checksum") {
    return { result: "MISSING", consumedLength: missingMatch.index! + missingMatch[0].length };
  }

  // 2. Type-specific parsing
  switch (expectedType) {
    case "checksum": {
      const checksumRegex = /[a-f0-9]{64}/i;
      const match = text.match(checksumRegex);
      if (match) {
        return { result: match[0].toLowerCase(), consumedLength: match.index! + match[0].length };
      }
      break;
    }

    case "ok":
    case "ready":
    case "done": {
      const token = expectedType.toUpperCase();
      const tokenRegex = new RegExp(`\\b${token}\\b`, 'i');
      const tokenMatch = text.match(tokenRegex);
      if (tokenMatch) {
        let consumedLength = tokenMatch.index! + tokenMatch[0].length;

        if (expectedPath) {
          // Look for the path specifically after the token
          const escapedPath = expectedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Allow for ": ", quotes, markdown, and whitespace
          const pathRegex = new RegExp(`[:\\s"'\\(\`]*${escapedPath}["'\\)\`]*`, 'i');
          const pathMatch = text.slice(consumedLength).match(pathRegex);

          if (pathMatch && pathMatch.index! < 20) { // Path must be reasonably close to the token
            consumedLength += pathMatch.index! + pathMatch[0].length;
            return { result: token, consumedLength };
          }
          // If expectedPath was requested but not found near the token, keep looking (don't consume)
          return { result: "", consumedLength: 0 };
        }

        return { result: token, consumedLength };
      }
      break;
    }

    case "hashes": {
      const hashesEndRegex = /\[DONE:HASHES\]/i;
      const hashesEndMatch = text.match(hashesEndRegex);
      if (hashesEndMatch) {
        const tokenIndex = hashesEndMatch.index!;
        const firstHashOrMissingRegex = /(?:HASH_RESULT:|[a-f0-9]{64}|MISSING)/i;
        const match = text.slice(0, tokenIndex).match(firstHashOrMissingRegex);

        if (match) {
          const start = match.index!;
          return {
            result: text.slice(start, tokenIndex).trim(),
            consumedLength: tokenIndex + hashesEndMatch[0].length,
          };
        }

        // Fallback: use text up to the token if no hash found
        return {
          result: text.slice(0, tokenIndex).trim(),
          consumedLength: tokenIndex + hashesEndMatch[0].length,
        };
      }
      break;
    }
  }

  return { result: "", consumedLength: 0 };
}

function buildWakePayload(ctx: AdapterExecutionContext): WakePayload {
  const { runId, agent, context } = ctx;
  return {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
      : [],
  };
}

function resolvePaperclipApiUrlOverride(value: unknown): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

const DEFAULT_CLAIMED_API_KEY_PATH = "~/.openclaw/workspace/paperclip-claimed-api-key.json";

function resolveClaimedApiKeyPath(value: unknown): string {
  return nonEmpty(value) ?? DEFAULT_CLAIMED_API_KEY_PATH;
}

function buildPaperclipEnvForWake(ctx: AdapterExecutionContext, wakePayload: WakePayload, companyBaseDir: string): Record<string, string> {
  const paperclipApiUrlOverride = resolvePaperclipApiUrlOverride(ctx.config.paperclipApiUrl);
  const paperclipEnv: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
    PAPERCLIP_MAIN_WORKSPACE_DIR: path.posix.join(companyBaseDir, "main"),
  };

  if (paperclipApiUrlOverride) {
    paperclipEnv.PAPERCLIP_API_URL = paperclipApiUrlOverride;
  }
  if (paperclipEnv.PAPERCLIP_API_URL) {
    paperclipEnv.PAPERCLIP_API_URL = paperclipEnv.PAPERCLIP_API_URL.replace(/\/$/, "");
  }
  if (wakePayload.taskId) paperclipEnv.PAPERCLIP_TASK_ID = wakePayload.taskId;
  if (wakePayload.wakeReason) paperclipEnv.PAPERCLIP_WAKE_REASON = wakePayload.wakeReason;
  if (wakePayload.wakeCommentId) paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID = wakePayload.wakeCommentId;
  if (wakePayload.approvalId) paperclipEnv.PAPERCLIP_APPROVAL_ID = wakePayload.approvalId;
  if (wakePayload.approvalStatus) paperclipEnv.PAPERCLIP_APPROVAL_STATUS = wakePayload.approvalStatus;
  if (wakePayload.issueIds.length > 0) {
    paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS = wakePayload.issueIds.join(",");
  }

  return paperclipEnv;
}

// Removed legacy prompt helper functions, which are now imported from prompts.ts

function normalizeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}



function isResponseFrame(value: unknown): value is GatewayResponseFrame {
  const record = asRecord(value);
  return Boolean(record && record.type === "res" && typeof record.id === "string" && typeof record.ok === "boolean");
}

function isEventFrame(value: unknown): value is GatewayEventFrame {
  const record = asRecord(value);
  return Boolean(record && record.type === "event" && typeof record.event === "string");
}

export class GatewayWsClient {
  public onSyncEvent?: (text: string, sessionKey: string) => void;
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private challengePromise: Promise<string>;
  private resolveChallenge!: (nonce: string) => void;
  private rejectChallenge!: (err: Error) => void;

  private readonly logContext: LoggerContext | null = null;
  private eventPromises: Promise<void>[] = [];
  private closePromise: Promise<void> | null = null;

  constructor(private readonly opts: GatewayClientOptions) {
    this.logContext = logContextStorage.getStore() || null;
    this.challengePromise = new Promise<string>((resolve, reject) => {
      this.resolveChallenge = resolve;
      this.rejectChallenge = reject;
    });
    this.challengePromise.catch(() => { });
  }

  private runInContext<T>(fn: () => Promise<T> | T): Promise<T> | T {
    if (this.logContext) {
      return logContextStorage.run(this.logContext, fn);
    }
    return fn();
  }

  async waitPendingEvents(): Promise<void> {
    while (this.eventPromises.length > 0) {
      await Promise.all([...this.eventPromises]);
    }
  }

  async connect(
    buildConnectParams: (nonce: string) => Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null> {
    this.challengePromise = new Promise<string>((resolve, reject) => {
      this.resolveChallenge = resolve;
      this.rejectChallenge = reject;
    });
    this.challengePromise.catch(() => { });

    this.ws = new WebSocket(this.opts.url, {
      headers: this.opts.headers,
      maxPayload: 25 * 1024 * 1024,
    });

    const ws = this.ws;
    await toLog(`[clawclip] [DEBUG] WebSocket instance created, readyState=${ws.readyState}`);

    this.closePromise = null;

    ws.on("message", (data) => {
      const raw = rawDataToString(data);
      // Suppress noisy WebSocket raw message received logging, except in debug mode
      void this.runInContext(async () => {
        try {
          await toLog(`[openclaw] [DEBUG] WebSocket message received: ${raw}`);
          await this.handleMessage(raw);
        } catch (err) {
          await toLog("stderr", `[clawclip] Error handling message: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    });

    ws.on("close", (code, reason) => {
      this.closePromise = Promise.resolve(this.runInContext(async () => {
        const reasonText = rawDataToString(reason);
        const isIntentional = this.ws === null;
        if (isIntentional) {
          await toLog(`[clawclip] [DEBUG] WebSocket closed: code=${code} reason=${reasonText || "no reason"}`);
        } else {
          const level = code === 1000 ? "ERROR" : "FATAL";
          await toLog("stderr", `[clawclip] ${level}: WebSocket closed unexpectedly: code=${code} reason=${reasonText || "no reason"}`);
          const err = new Error(`gateway closed unexpectedly (${code}): ${reasonText}`);
          this.failPending(err);
          this.rejectChallenge(err);
        }
      }));
    });

    ws.on("error", (err) => {
      void this.runInContext(async () => {
        const message = err instanceof Error ? err.message : String(err);
        await toLog("stderr", `[clawclip] websocket error: ${message}`);
      });
    });

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const onOpen = async () => {
          await toLog(`[clawclip] [DEBUG]  WebSocket open, waiting for challenge...`);
          cleanup();
          resolve();
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const onClose = (code: number, reason: Buffer) => {
          cleanup();
          reject(new Error(`gateway closed before open (${code}): ${rawDataToString(reason)}`));
        };
        const cleanup = () => {
          ws.off("open", onOpen);
          ws.off("error", onError);
          ws.off("close", onClose);
        };
        ws.once("open", onOpen);
        ws.once("error", onError);
        ws.once("close", onClose);
      }),
      timeoutMs,
      "gateway websocket open timeout",
    );

    const nonce = await withTimeout(this.challengePromise, timeoutMs, "gateway connect challenge timeout");
    await toLog(`[clawclip] [DEBUG] Challenge received, sending hello...`);
    const signedConnectParams = buildConnectParams(nonce);

    const hello = await this.request<Record<string, unknown> | null>("connect", signedConnectParams, {
      timeoutMs,
    });

    return hello;
  }

  abort(err: Error): void {
    this.failPending(err);
    this.rejectChallenge(err);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.close(1000, err.message);
      }
    }
  }

  async request<T>(
    method: string,
    params: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }

    const id = randomUUID();
    const frame: GatewayRequestFrame = {
      type: "req",
      id,
      method,
      params,
    };

    const payload = JSON.stringify(frame);
    const requestPromise = new Promise<T>((resolve, reject) => {
      const timer =
        opts && opts.timeoutMs > 0
          ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`gateway request timeout (${method})`));
          }, opts.timeoutMs)
          : null;

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        expectFinal: opts?.expectFinal === true,
        timer,
      });
    });

    this.ws.send(payload);
    return requestPromise;
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;

    if (ws.readyState !== WebSocket.CLOSED) {
      ws.close(1000, "paperclip-complete");
    }

    if (ws.readyState !== WebSocket.CLOSED) {
      if (this.closePromise) {
        await this.closePromise;
      } else {
        await new Promise<void>((resolve) => {
          ws.once("close", () => {
            setTimeout(async () => {
              if (this.closePromise) {
                await this.closePromise;
              }
              resolve();
            }, 0);
          });
        });
      }
    } else if (this.closePromise) {
      await this.closePromise;
    }

    await this.waitPendingEvents();
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private failPending(err: Error) {
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private async handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (isEventFrame(parsed)) {
      if (parsed.event === "connect.challenge") {
        const payload = asRecord(parsed.payload);
        const nonce = nonEmpty(payload?.nonce);
        if (nonce) {
          this.resolveChallenge(nonce);
          return;
        }
      }
      const promise = Promise.resolve(this.opts.onEvent(parsed)).catch(() => {
        // Ignore event callback failures and keep stream active.
      });
      this.eventPromises.push(promise);
      promise.finally(() => {
        const index = this.eventPromises.indexOf(promise);
        if (index !== -1) {
          this.eventPromises.splice(index, 1);
        }
      });
      return;
    }

    if (!isResponseFrame(parsed)) return;

    const pending = this.pending.get(parsed.id);
    if (!pending) return;

    const payload = asRecord(parsed.payload);
    const status = nonEmpty(payload?.status)?.toLowerCase();
    if (pending.expectFinal && status === "accepted") {
      return;
    }

    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(parsed.id);

    if (parsed.ok) {
      pending.resolve(parsed.payload ?? null);
      return;
    }

    const errorRecord = asRecord(parsed.error);
    const message =
      nonEmpty(errorRecord?.message) ??
      nonEmpty(errorRecord?.code) ??
      "gateway request failed";
    const err = new Error(message) as GatewayResponseError;
    const code = nonEmpty(errorRecord?.code);
    const details = asRecord(errorRecord?.details);
    if (code) err.gatewayCode = code;
    if (details) err.gatewayDetails = details;
    pending.reject(err);
  }
}



function parseUsage(value: unknown): AdapterExecutionResult["usage"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const inputTokens = asNumber(record.inputTokens ?? record.input, 0);
  const outputTokens = asNumber(record.outputTokens ?? record.output, 0);
  const cachedInputTokens = asNumber(
    record.cachedInputTokens ?? record.cached_input_tokens ?? record.cacheRead ?? record.cache_read,
    0,
  );

  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function extractRuntimeServicesFromMeta(meta: Record<string, unknown> | null): AdapterRuntimeServiceReport[] {
  if (!meta) return [];
  const reports: AdapterRuntimeServiceReport[] = [];

  const runtimeServices = Array.isArray(meta.runtimeServices)
    ? meta.runtimeServices.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
    : [];
  for (const entry of runtimeServices) {
    const serviceName = nonEmpty(entry.serviceName) ?? nonEmpty(entry.name);
    if (!serviceName) continue;
    const rawStatus = nonEmpty(entry.status)?.toLowerCase();
    const status =
      rawStatus === "starting" || rawStatus === "running" || rawStatus === "stopped" || rawStatus === "failed"
        ? rawStatus
        : "running";
    const rawLifecycle = nonEmpty(entry.lifecycle)?.toLowerCase();
    const lifecycle = rawLifecycle === "shared" ? "shared" : "ephemeral";
    const rawScopeType = nonEmpty(entry.scopeType)?.toLowerCase();
    const scopeType =
      rawScopeType === "project_workspace" ||
        rawScopeType === "execution_workspace" ||
        rawScopeType === "agent"
        ? rawScopeType
        : "run";
    const rawHealth = nonEmpty(entry.healthStatus)?.toLowerCase();
    const healthStatus =
      rawHealth === "healthy" || rawHealth === "unhealthy" || rawHealth === "unknown"
        ? rawHealth
        : status === "running"
          ? "healthy"
          : "unknown";

    reports.push({
      id: nonEmpty(entry.id),
      projectId: nonEmpty(entry.projectId),
      projectWorkspaceId: nonEmpty(entry.projectWorkspaceId),
      issueId: nonEmpty(entry.issueId),
      scopeType,
      scopeId: nonEmpty(entry.scopeId),
      serviceName,
      status,
      lifecycle,
      reuseKey: nonEmpty(entry.reuseKey),
      command: nonEmpty(entry.command),
      cwd: nonEmpty(entry.cwd),
      port: parseOptionalPositiveInteger(entry.port),
      url: nonEmpty(entry.url),
      providerRef: nonEmpty(entry.providerRef) ?? nonEmpty(entry.previewId),
      ownerAgentId: nonEmpty(entry.ownerAgentId),
      stopPolicy: asRecord(entry.stopPolicy),
      healthStatus,
    });
  }

  const previewUrl = nonEmpty(meta.previewUrl);
  if (previewUrl) {
    reports.push({
      serviceName: "preview",
      status: "running",
      lifecycle: "ephemeral",
      scopeType: "run",
      url: previewUrl,
      providerRef: nonEmpty(meta.previewId) ?? previewUrl,
      healthStatus: "healthy",
    });
  }

  const previewUrls = Array.isArray(meta.previewUrls)
    ? meta.previewUrls.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  previewUrls.forEach((url, index) => {
    reports.push({
      serviceName: index === 0 ? "preview" : `preview-${index + 1}`,
      status: "running",
      lifecycle: "ephemeral",
      scopeType: "run",
      url,
      providerRef: `${url}#${index}`,
      healthStatus: "healthy",
    });
  });

  return reports;
}

function extractResultText(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;

  const payloads = Array.isArray(record.payloads) ? record.payloads : [];
  const texts = payloads
    .map((entry) => {
      const payload = asRecord(entry);
      return nonEmpty(payload?.text);
    })
    .filter((entry): entry is string => Boolean(entry));

  if (texts.length > 0) return texts.join("\n\n");
  return nonEmpty(record.text) ?? nonEmpty(record.summary) ?? null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const configDebug = parseBoolean(ctx.config.debug, false);
  return logContextStorage.run({ onLog: ctx.onLog, debug: configDebug }, async () => {

    initLogger(ctx.onLog);

    const targetAgentId = "paperclip-" + ctx.agent.id;
    const instructionsFilePath = (ctx.config as any).instructionsFilePath;
    const runtimeSkillsRaw = (ctx.config as any).paperclipRuntimeSkills;

    await toLog(`[clawclip] [DEBUG] Execute started for run ${ctx.runId}`);
    if (instructionsFilePath) {
      await toLog(`[clawclip] [DEBUG] Instructions bundle path: ${instructionsFilePath}`);
    }

    const skillEntries = await readRuntimeSkillEntries(ctx.config, __moduleDir);
    const desiredSkills = skillEntries;

    const resolvedApiUrl = resolvePaperclipApiUrl(ctx);
    const paperclipApiUrl = resolvedApiUrl
      ? resolvedApiUrl.replace(/\/$/, "")
      : `http://${process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "127.0.0.1"}:${process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100"}`;

    let isCancelled = false;
    let cancelCheckInterval: NodeJS.Timeout | undefined;
    let client: GatewayWsClient | null = null;
    let acceptedRunId: string | null = null;

    async function checkRunCancelled(runId: string, token?: string): Promise<boolean> {
      try {
        const headers: Record<string, string> = {};
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }
        const response = await fetch(`${paperclipApiUrl}/api/heartbeat-runs/${runId}`, {
          headers
        });
        if (!response.ok) {
          return false;
        }
        const run = await response.json() as { status?: string };
        return run.status === "cancelled";
      } catch {
        return false;
      }
    }

    const urlValue = asString(ctx.config.url, "").trim();
    if (!urlValue) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "OpenClaw gateway adapter missing url",
        errorCode: "clawclip_url_missing",
      };
    }

    const parsedUrl = normalizeUrl(urlValue);
    if (!parsedUrl) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Invalid gateway URL: ${urlValue}`,
        errorCode: "clawclip_url_invalid",
      };
    }

    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `Unsupported gateway URL protocol: ${parsedUrl.protocol}`,
        errorCode: "clawclip_url_protocol",
      };
    }

    const timeoutSec = Math.max(0, Math.floor(asNumber(ctx.config.timeoutSec, 300)));
    const timeoutMs = timeoutSec > 0 ? timeoutSec * 1000 : 0;
    const connectTimeoutMs = timeoutMs > 0 ? Math.min(timeoutMs, 15_000) : 10_000;

    const payloadTemplate = parseObject(ctx.config.payloadTemplate);
    const transportHint = nonEmpty(ctx.config.streamTransport) ?? nonEmpty(ctx.config.transport);

    const headers = toStringRecord(ctx.config.headers);
    const authToken = resolveAuthToken(parseObject(ctx.config), headers);
    const deviceToken = nonEmpty(ctx.config.deviceToken);

    if (authToken && !headerMapHasIgnoreCase(headers, "authorization")) {
      headers.authorization = toAuthorizationHeaderValue(authToken);
    }

    const clientId = nonEmpty(ctx.config.clientId) ?? DEFAULT_CLIENT_ID;
    const clientMode = nonEmpty(ctx.config.clientMode) ?? DEFAULT_CLIENT_MODE;
    const clientVersion = nonEmpty(ctx.config.clientVersion) ?? DEFAULT_CLIENT_VERSION;
    const role = nonEmpty(ctx.config.role) ?? DEFAULT_ROLE;
    const scopes = normalizeScopes(ctx.config.scopes);
    const deviceFamily = nonEmpty(ctx.config.deviceFamily) ?? "clawclip";

    const wakePayload = buildWakePayload(ctx);

    const sessionKeyStrategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
    const configuredSessionKey = nonEmpty(ctx.config.sessionKey);
    const sessionKey = resolveSessionKey({
      strategy: sessionKeyStrategy,
      configuredSessionKey,
      agentId: nonEmpty(ctx.config.agentId) ?? targetAgentId,
      runId: ctx.runId,
      issueId: wakePayload.issueId,
    });

    cancelCheckInterval = setInterval(async () => {
      const runCancelled = await checkRunCancelled(ctx.runId, ctx.authToken);
      if (runCancelled) {
        isCancelled = true;
        clearInterval(cancelCheckInterval);
        if (client) {
          if (acceptedRunId) {
            try {
              await toLog(`[clawclip] [DEBUG] Run cancelled in Paperclip UI. Aborting session in OpenClaw...`);
              if (client.isConnected()) {
                await client.request("chat.abort", {
                  sessionKey,
                  runId: acceptedRunId,
                });
              }
            } catch (abortErr) {
              await toLog("stderr", `[clawclip] Failed to abort remote run on gateway: ${abortErr instanceof Error ? abortErr.message : String(abortErr)}`);
            }
          }
          client.abort(new Error("Run cancelled in Paperclip UI"));
        }
      }
    }, 3000);

    const enableSkillSync = parseBoolean(ctx.config.enableSkillSync, false);

    // DEBUG: authToken
    // await toLog(`[clawclip] [DEBUG] info: ${JSON.stringify(ctx.authToken)}`);

    if (ctx.onMeta) {
      await ctx.onMeta({
        adapterType: "clawclip",
        command: "gateway",
        commandArgs: ["ws", parsedUrl.toString(), "agent"],
        context: ctx.context,
      });
    }

    const outboundHeaderKeys = Object.keys(headers).sort();
    await toLog(`[clawclip] [DEBUG] outbound headers (redacted): ${stringifyForLog(redactForLog(headers), 4_000)}`);

    if (transportHint) {
      await toLog(`[clawclip] [DEBUG] ignoring streamTransport=${transportHint}; gateway adapter always uses websocket protocol`);
    }
    if (parsedUrl.protocol === "ws:") {
      if (isLoopbackHost(parsedUrl.hostname)) {
        await toLog(`[clawclip] [DEBUG]  loopback host detected; skipping TLS requirement for ws://`);
      } else {
        await toLog(`[clawclip] [DEBUG]  warning: using plaintext ws:// to a non-loopback host; prefer wss:// for remote endpoints`);
      }
    }

    let latestResultPayload: unknown = null;

    while (true) {
      if (isCancelled) {
        throw new Error("Run cancelled in Paperclip UI");
      }
      const trackedRunIds = new Set<string>([ctx.runId]);
      let assistantSummary = "";
      let lifecycleError: string | null = null;
      let runAborted = false;
      let deviceIdentity: GatewayDeviceIdentity | null = null;

      const onEvent = async (frame: GatewayEventFrame) => {
        if (frame.event !== "agent") {
          if (frame.event === "shutdown") {
            await toLog(`[clawclip] [DEBUG] gateway shutdown notice: ${JSON.stringify(frame.payload ?? {})}`);
          }
          return;
        }

        const payload = asRecord(frame.payload);
        if (!payload) return;

        const runId = nonEmpty(payload.runId);
        if (!runId) return;

        const stream = nonEmpty(payload.stream) ?? "unknown";
        const data = asRecord(payload.data) ?? {};

        const incomingSessionKey = payload.sessionKey ? asString(payload.sessionKey, "") : "";
        const matchesSessionKey = sessionKey && incomingSessionKey.includes(sessionKey);
        const matchesRunId = runId === ctx.runId;
        const matchesStream =
          stream === "lifecycle" ||
          stream === "assistant" ||
          stream === "command_output" ||
          stream === "item" ||
          stream === "error";

        // await toLog(`[openclaw] [DEBUG] run=${runId} stream=${stream} data=${JSON.stringify(data)}`);
        if ((matchesSessionKey || matchesRunId) && matchesStream) {
          await ctx.onLog(
            "stdout",
            `[clawclip:event] run=${runId} stream=${stream} data=${JSON.stringify(data)}\n`,
          );
        }

        if (stream === "assistant") {
          const text = nonEmpty(data.text);
          if (text) {
            if (runId === ctx.runId) {
              assistantSummary = text;
            }
            if (payload.sessionKey) {
              client?.onSyncEvent?.(text, asString(payload.sessionKey, ""));
            }
          }
          return;
        }

        if (stream === "error") {
          const error = nonEmpty(data.error) ?? nonEmpty(data.message) ?? "Unknown error";
          if (runId === ctx.runId) {
            lifecycleError = error;
          }
          return;
        }

        if (stream === "lifecycle") {
          const phase = nonEmpty(data.phase)?.toLowerCase();
          const error = nonEmpty(data.error) ?? nonEmpty(data.message);
          const stopReason = nonEmpty(data.stopReason)?.toLowerCase();
          const aborted = parseBoolean(data.aborted, false);

          if (runId === ctx.runId) {
            if (aborted || stopReason === "aborted" || phase === "cancelled") {
              runAborted = true;
            }
            if (phase === "error" || phase === "failed" || phase === "cancelled") {
              lifecycleError = error ?? lifecycleError;
            }
          }
        }
      };

      client = new GatewayWsClient({
        url: parsedUrl.toString(),
        headers,
        onEvent,
      });

      try {
        deviceIdentity = await resolveDeviceIdentity(parseObject(ctx.config));
        await toLog(`[clawclip] [DEBUG] device auth enabled deviceId=${deviceIdentity.deviceId}`);

        await toLog(`[clawclip] [DEBUG] connecting to ${parsedUrl.toString()}`);

        const hello = await client.connect((nonce) => {
          const signedAtMs = Date.now();
          const connectParams: Record<string, unknown> = {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: clientId,
              version: clientVersion,
              platform: process.platform,
              ...(deviceFamily ? { deviceFamily } : {}),
              mode: clientMode,
            },
            role,
            scopes,
            auth:
              authToken || deviceToken
                ? {
                  ...(authToken ? { token: authToken } : {}),
                  ...(deviceToken ? { deviceToken } : {}),
                }
                : undefined,
          };

          if (deviceIdentity) {
            const payload = buildDeviceAuthPayloadV3({
              deviceId: deviceIdentity.deviceId,
              clientId,
              clientMode,
              role,
              scopes,
              signedAtMs,
              token: authToken,
              nonce,
              platform: process.platform,
              deviceFamily,
            });
            connectParams.device = {
              id: deviceIdentity.deviceId,
              publicKey: deviceIdentity.publicKeyRawBase64Url,
              signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
              signedAt: signedAtMs,
              nonce,
            };
          }
          return connectParams;
        }, connectTimeoutMs);

        await toLog(`[clawclip] [DEBUG] connected protocol=${asNumber(asRecord(hello)?.protocol, PROTOCOL_VERSION)}`);

        const releaseLock = await spawningMutex.acquire();
        let companyBaseDir: string;
        try {
          // Dedicated remote agent workspace provisioning and smart instructions synchronization
          const syncResult = await ensureAgentAndSyncInstructions(ctx, client, targetAgentId, sessionKey);
          companyBaseDir = syncResult.companyBaseDir;

          // Perform durable skill sync if needed
          const paperclipSkill = desiredSkills.find(s => s.key === "paperclip" || s.key.endsWith("/paperclip"));
          if (paperclipSkill) {
            if (enableSkillSync) {
              await toLog(`[clawclip] [DEBUG] Paperclip skill detected (key="${paperclipSkill.key}"), starting durable sync...`);
              await syncPaperclipSkills(ctx, client, desiredSkills, sessionKey, targetAgentId);
            } else {
              await toLog(`[clawclip] [DEBUG] Paperclip skill detected (key="${paperclipSkill.key}"), but Skill Sync is disabled by configuration. Skipping sync.`);
            }
          } else {
            await toLog(`[clawclip] [DEBUG] Paperclip skill not in desired list. Keys: ${desiredSkills.map(s => s.key).join(", ")}`);
          }

          // Register session token in BOOTSTRAP.md registry
          if (ctx.authToken) {
            await registerSessionTokenInBootstrap(ctx, client, targetAgentId, ctx.runId, ctx.authToken);
          }
        } finally {
          // 1000ms delay to guarantee OpenClaw completes host-to-sandbox cloning before next spawn
          await new Promise((resolve) => setTimeout(resolve, 1000));
          releaseLock();
        }

        const paperclipEnv = buildPaperclipEnvForWake(ctx, wakePayload, companyBaseDir);
        const message = buildCachingOptimizedPrompt({
          agent: ctx.agent,
          desiredSkills,
          paperclipEnv,
          paperclipWake: ctx.context.paperclipWake,
        });

        const agentParams: Record<string, unknown> = {
          ...payloadTemplate,
          message,
          sessionKey,
          idempotencyKey: ctx.runId,
          agentId: targetAgentId,
        };
        if (ctx.context.wakeReason) {
          agentParams.bootstrapContextRunKind = "heartbeat";
        }
        delete agentParams.text;
        delete agentParams.paperclip;

        if (typeof agentParams.timeout !== "number") {
          agentParams.timeout = timeoutSec; // Correctly pass seconds to OpenClaw RPC
        }

        const redactedAgentParams = redactForLog(agentParams) as Record<string, unknown>;
        if (ctx.authToken && typeof redactedAgentParams.message === "string") {
          redactedAgentParams.message = redactedAgentParams.message.replace(
            ctx.authToken,
            redactSecretForLog(ctx.authToken)
          );
        }

        await toLog(`[clawclip] [DEBUG] outbound payload (redacted): ${JSON.stringify(redactedAgentParams)}`);
        await toLog(`[clawclip] [DEBUG] outbound header keys: ${outboundHeaderKeys.join(", ")}`);

        const acceptedPayload = await client.request<Record<string, unknown>>("agent", agentParams, {
          timeoutMs: connectTimeoutMs,
        });

        latestResultPayload = acceptedPayload;

        const acceptedStatus = nonEmpty(acceptedPayload?.status)?.toLowerCase() ?? "";
        acceptedRunId = nonEmpty(acceptedPayload?.runId) ?? ctx.runId;
        trackedRunIds.add(acceptedRunId);

        await toLog(`[clawclip] [DEBUG] agent accepted runId=${acceptedRunId} status=${acceptedStatus || "unknown"}`);

        if (acceptedStatus === "error") {
          const errorMessage =
            nonEmpty(acceptedPayload?.summary) ?? lifecycleError ?? "OpenClaw gateway agent request failed";
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage,
            errorCode: "clawclip_agent_error",
            resultJson: acceptedPayload,
          };
        }

        if (acceptedStatus !== "ok") {
          let waitAttempt = 0;
          const maxWaitAttempts = process.env.VITEST ? 2 : 10;
          const waitStartTime = Date.now();
          let waitPayload: any = null;

          while (true) {
            if (isCancelled) {
              throw new Error("Run cancelled in Paperclip UI");
            }
            const elapsed = Date.now() - waitStartTime;
            const remainingTimeoutMs = timeoutMs - elapsed;
            if (remainingTimeoutMs <= 0) {
              await toLog("stderr", `[clawclip] Local Timeout: The run timed out after ${timeoutSec}s waiting for the remote OpenClaw gateway.`);
              return {
                exitCode: 1,
                signal: null,
                timedOut: true,
                errorMessage: `OpenClaw gateway run timed out after ${timeoutSec}s (local timeout: elapsed time exceeded timeout limit waiting for gateway)`,
                errorCode: "clawclip_wait_timeout",
                resultJson: latestResultPayload ?? waitPayload,
              };
            }

            try {
              if (!client.isConnected()) {
                await toLog(`[clawclip] [DEBUG] WebSocket disconnected. Reconnecting to gateway (attempt ${waitAttempt + 1})...`);
                await client.close();

                const hello = await client.connect((nonce) => {
                  const signedAtMs = Date.now();
                  const connectParams: Record<string, unknown> = {
                    minProtocol: PROTOCOL_VERSION,
                    maxProtocol: PROTOCOL_VERSION,
                    client: {
                      id: clientId,
                      version: clientVersion,
                      platform: process.platform,
                      ...(deviceFamily ? { deviceFamily } : {}),
                      mode: clientMode,
                    },
                    role,
                    scopes,
                    auth:
                      authToken || deviceToken
                        ? {
                          ...(authToken ? { token: authToken } : {}),
                          ...(deviceToken ? { deviceToken } : {}),
                        }
                        : undefined,
                  };

                  if (deviceIdentity) {
                    const payload = buildDeviceAuthPayloadV3({
                      deviceId: deviceIdentity.deviceId,
                      clientId,
                      clientMode,
                      role,
                      scopes,
                      signedAtMs,
                      token: authToken,
                      nonce,
                      platform: process.platform,
                      deviceFamily,
                    });
                    connectParams.device = {
                      id: deviceIdentity.deviceId,
                      publicKey: deviceIdentity.publicKeyRawBase64Url,
                      signature: signDevicePayload(deviceIdentity.privateKeyPem, payload),
                      signedAt: signedAtMs,
                      nonce,
                    };
                  }
                  return connectParams;
                }, connectTimeoutMs);

                await toLog(`[clawclip] [DEBUG]  Reconnected to gateway successfully.`);
              }

              waitPayload = await client.request<Record<string, unknown>>(
                "agent.wait",
                { runId: acceptedRunId, timeoutMs: remainingTimeoutMs },
                { timeoutMs: remainingTimeoutMs + connectTimeoutMs },
              );

              latestResultPayload = waitPayload;
              break;
            } catch (waitErr) {
              if (isCancelled) {
                throw waitErr;
              }
              const errMsg = waitErr instanceof Error ? waitErr.message : String(waitErr);
              const errLower = errMsg.toLowerCase();
              const isConnectionAborted =
                errLower.includes("econnrefused") ||
                errLower.includes("connection aborted") ||
                errLower.includes("aborted");

              if (isConnectionAborted) {
                throw waitErr;
              }

              waitAttempt++;
              await toLog("stderr", `[clawclip] ERROR: Error waiting for remote agent (attempt ${waitAttempt}): ${errMsg}`);

              if (waitAttempt >= maxWaitAttempts) {
                throw waitErr;
              }

              const backoffMs = Math.min(100 * Math.pow(2, waitAttempt), 5000);
              await toLog(`[clawclip] [DEBUG] Waiting ${backoffMs}ms before retrying reconnect...`);
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
          }

          const waitStatus = nonEmpty(waitPayload?.status)?.toLowerCase() ?? "";
          const waitSummary = nonEmpty(waitPayload?.summary)?.toLowerCase() ?? "";
          const waitError = nonEmpty(waitPayload?.error)?.toLowerCase() ?? "";
          const waitAborted = parseBoolean(waitPayload?.aborted, false) ||
            parseBoolean(asRecord(waitPayload?.result)?.aborted, false);

          const isAborted = runAborted ||
            waitSummary === "aborted" ||
            waitError === "aborted" ||
            waitAborted;

          if (waitStatus === "timeout") {
            if (isAborted) {
              await toLog("stderr", `[clawclip] Run aborted from OpenClaw side.`);
              return {
                exitCode: 1,
                signal: null,
                timedOut: false,
                errorMessage: `OpenClaw gateway run was aborted/cancelled from the gateway side`,
                errorCode: "clawclip_connection_aborted",
                errorFamily: "transient_upstream",
                resultJson: waitPayload,
              };
            }
            await toLog("stderr", `[clawclip] Remote Timeout: The OpenClaw gateway reported that the agent task timed out after ${timeoutSec}s.`);
            return {
              exitCode: 1,
              signal: null,
              timedOut: true,
              errorMessage: `OpenClaw gateway run timed out after ${timeoutSec}s (remote timeout: openclaw gateway reported timeout status)`,
              errorCode: "clawclip_wait_timeout",
              resultJson: waitPayload,
            };
          }

          if (waitStatus === "error") {
            const isAbortedError = isAborted ||
              waitError === "aborted" ||
              nonEmpty(waitPayload?.message)?.toLowerCase()?.includes("aborted");

            return {
              exitCode: 1,
              signal: null,
              timedOut: false,
              errorMessage:
                nonEmpty(waitPayload?.error) ??
                lifecycleError ??
                "OpenClaw gateway run failed",
              errorCode: isAbortedError ? "clawclip_connection_aborted" : "clawclip_wait_error",
              ...(isAbortedError ? { errorFamily: "transient_upstream" } : {}),
              resultJson: waitPayload,
            };
          }

          if (waitStatus && waitStatus !== "ok") {
            return {
              exitCode: 1,
              signal: null,
              timedOut: false,
              errorMessage: `Unexpected OpenClaw gateway agent.wait status: ${waitStatus}`,
              errorCode: "clawclip_wait_status_unexpected",
              resultJson: waitPayload,
            };
          }
        }

        const summaryFromEvents = assistantSummary.trim();
        const summaryFromPayload =
          extractResultText(asRecord(acceptedPayload?.result)) ??
          extractResultText(acceptedPayload) ??
          extractResultText(asRecord(latestResultPayload)) ??
          null;
        const summary = summaryFromEvents || summaryFromPayload || null;

        // Detect AGENT_ERROR: reported by the remote agent in its response (anchored to start of line to avoid false positives)
        const errorPattern = /^AGENT_ERROR:\s*(.+)/im;
        const errorSource = summaryFromEvents || summaryFromPayload || "";
        const errorMatch = errorSource.match(errorPattern);
        if (errorMatch) {
          const errorDetail = errorMatch[1].trim();
          await toLog("stderr", `[clawclip] Remote agent reported error: ${errorDetail}`);
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: `Remote agent error: ${errorDetail}`,
            errorCode: "remote_agent_error",
            resultJson: asRecord(latestResultPayload),
          };
        }

        const acceptedResult = asRecord(acceptedPayload?.result);
        const latestPayload = asRecord(latestResultPayload);
        const latestResult = asRecord(latestPayload?.result);
        const acceptedMeta = asRecord(acceptedResult?.meta) ?? asRecord(acceptedPayload?.meta);
        const latestMeta = asRecord(latestResult?.meta) ?? asRecord(latestPayload?.meta);
        const mergedMeta = {
          ...(acceptedMeta ?? {}),
          ...(latestMeta ?? {}),
        };
        const agentMeta =
          asRecord(mergedMeta.agentMeta) ??
          asRecord(acceptedMeta?.agentMeta) ??
          asRecord(latestMeta?.agentMeta);
        const usage = parseUsage(agentMeta?.usage ?? mergedMeta.usage);
        const runtimeServices = extractRuntimeServicesFromMeta(agentMeta ?? mergedMeta);
        const provider = nonEmpty(agentMeta?.provider) ?? nonEmpty(mergedMeta.provider) ?? "openclaw";
        const model = nonEmpty(agentMeta?.model) ?? nonEmpty(mergedMeta.model) ?? null;
        const costUsd = asNumber(agentMeta?.costUsd ?? mergedMeta.costUsd, 0);

        await toLog(`[clawclip] [DEBUG] run completed runId=${Array.from(trackedRunIds).join(",")} status=ok`);

        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          provider,
          ...(model ? { model } : {}),
          ...(usage ? { usage } : {}),
          ...(costUsd > 0 ? { costUsd } : {}),
          resultJson: asRecord(latestResultPayload),
          ...(runtimeServices.length > 0 ? { runtimeServices } : {}),
          ...(summary ? { summary } : {}),
        };
      } catch (err) {
        if (isCancelled) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorMessage: "Run cancelled in Paperclip UI",
            errorCode: "cancelled",
            resultJson: asRecord(latestResultPayload),
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        const lower = message.toLowerCase();
        const timedOut = lower.includes("timeout");
        const pairingRequired = lower.includes("pairing required");
        const connectionAborted =
          lower.includes("closed unexpectedly") ||
          lower.includes("econnreset") ||
          lower.includes("econnrefused") ||
          lower.includes("epipe") ||
          lower.includes("connection aborted") ||
          lower.includes("socket hung up") ||
          lower.includes("aborted");

        let detailedMessage = pairingRequired
          ? `${message}. Approve the pending device in OpenClaw (for example: openclaw devices approve --latest) and retry.`
          : message;

        if (timedOut) {
          detailedMessage = `${detailedMessage} (local timeout: network or connection timed out)`;
          await toLog("stderr", `[clawclip] Local Timeout: request timed out - ${detailedMessage}`);
        } else if (connectionAborted) {
          await toLog("stderr", `[clawclip] Connection aborted from OpenClaw side: ${detailedMessage}`);
        } else {
          await toLog("stderr", `[clawclip] request failed: ${detailedMessage}`);
        }

        return {
          exitCode: 1,
          signal: null,
          timedOut: timedOut && !connectionAborted,
          errorMessage: detailedMessage,
          errorCode: timedOut
            ? "clawclip_timeout"
            : connectionAborted
              ? "clawclip_connection_aborted"
              : pairingRequired
                ? "clawclip_pairing_required"
                : "clawclip_request_failed",
          ...(connectionAborted ? { errorFamily: "transient_upstream" } : {}),
          resultJson: asRecord(latestResultPayload),
        };
      } finally {
        if (cancelCheckInterval) {
          clearInterval(cancelCheckInterval);
        }
        if (client) {
          await client.close();
        }
      }
    }
  });
}
