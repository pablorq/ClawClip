import type { SkillEntry } from "./skill-compat.js";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

export type WakePayload = {
  runId: string;
  agentId: string;
  companyId: string;
  taskId: string | null;
  issueId: string | null;
  wakeReason: string | null;
  wakeCommentId: string | null;
  approvalId: string | null;
  approvalStatus: string | null;
  issueIds: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Migration of listPrompt string generator.
 */
export function buildSkillSyncListPrompt(targetBaseDir: string, skillDirs: string): string {
  return [
    `[PROTOCOL:SKILL_SYNC]`,
    `ACTION: GET_MULTIPLE_HASHES`,
    `INSTRUCTION:`,
    `1. Calculate the aggregate SHA-256 hash of specific skill directories in "${targetBaseDir}".`,
    `2. Run this exact bash script:`,
    `for dir in ${skillDirs}; do`,
    `  target=$(eval echo "${targetBaseDir}/$dir")`,
    `  [ -d "$target" ] && (cd "$target" && find . -type f ! -name ".checksum" -exec sha256sum {} + | LC_ALL=C sort | sha256sum | awk -v d="$dir" '{print "HASH_RESULT:" $1 ":" d}') || echo "HASH_RESULT:MISSING:$dir"`,
    `done`,
    `3. Respond ONLY with the output from the bash script, followed by [DONE:HASHES] on a new line.`,
  ].join("\n");
}

/**
 * Migration of syncPrompt string generator.
 */
export function buildSkillSyncZipPrompt(
  targetBaseDir: string,
  zipPath: string,
  zipName: string,
  deleteCommands: string,
): string {
  return [
    `[PROTOCOL:SKILL_SYNC]`,
    `ACTION: SYNC_ZIP`,
    `ZIP_PATH: ${zipPath}`,
    `INSTRUCTION:`,
    `1. Move attached '${zipName}.bin' to '${zipPath}'.`,
    `2. Remove old directories: ${deleteCommands}`,
    `3. Unzip '${zipPath}' into '${targetBaseDir}/'.`,
    `4. Delete '${zipPath}'.`,
    `Respond ONLY with "OK: MULTI_SYNC".`,
  ].join("\n");
}

export type WakePromptType = "heartbeat" | "wake" | "resume";

export function stringifyWakePayload(value: unknown): string | null {
  const parsed = parseObject(value);
  if (Object.keys(parsed).length === 0) return null;
  return JSON.stringify(parsed);
}

/**
 * Dynamically determines if the turn is a "heartbeat", "wake" (Cold Start), or a "resume" (Session Resume).
 */
export function determineWakePromptType(context: Record<string, any> | undefined): WakePromptType {
  const parsed = parseObject(context);
  if (Object.keys(parsed).length === 0) {
    return "heartbeat";
  }

  const liveness = parsed.livenessContinuation as Record<string, any> | undefined;
  if (liveness && (liveness.attempt > 1 || liveness.state)) {
    return "resume";
  }

  const executionStage = parsed.executionStage as Record<string, any> | undefined;
  if (executionStage && executionStage.lastDecisionOutcome) {
    return "resume";
  }

  if (parsed.checkedOutByHarness === true) {
    return "resume";
  }

  const continuationSummary = parsed.continuationSummary as Record<string, any> | undefined;
  if (continuationSummary && continuationSummary.body) {
    return "resume";
  }

  return "wake";
}

/**
 * Constructs the high-performance, caching-optimized prompt for Heartbeat, Wake, and Resume modes.
 */
export function buildCachingOptimizedPrompt(params: {
  agent: { id: string; name: string };
  desiredSkills: SkillEntry[];
  paperclipEnv: Record<string, string>;
  paperclipWake: any;
}): string {
  const { agent, desiredSkills, paperclipEnv, paperclipWake } = params;

  // Filter out the 'paperclip' skill from the auxiliary skills list, as it's the main driver
  const auxiliarySkills = desiredSkills.filter((s) => s.runtimeName !== "paperclip");
  const auxiliarySkillsText = auxiliarySkills.length > 0
    ? auxiliarySkills.map((s) => `- ${s.runtimeName}`).join("\n")
    : "- (No auxiliary skills available)";

  const wakeType = determineWakePromptType(paperclipWake);
  const parsed = parseObject(paperclipWake);

  // 1. Compile Static Instructions (Cached Prefix)
  const errorLoopGuardrail = [
    `## Resilience Guardrails:`,
    `- **Error Loop Guardrail**: If you experience any error (e.g., API 401, 403, 500, network loss, or tool failures) for a 3rd consecutive time, STOP immediately and report on its own line: \`AGENT_ERROR: <last_error_message>\`.`,
    ``,
    `## Environment & PAPERCLIP_API_KEY Lifecycle:`,
    `- **Initial Extraction**: Run this command once at the start of your session to get the literal token:`,
    `  \`grep \$PAPERCLIP_RUN_ID BOOTSTRAP.md | cut -d' ' -f3\``,
    `- **Continuous Injection**: Inject the extracted literal token in the \`env\` block of all subsequent \`exec\` calls requiring authentication (other env variables can vary as needed).`,
    `  - **Example Structure**:`,
    `    \`\`\`json`,
    `    { "command": "<cmd>", "env": { "PAPERCLIP_API_KEY": "<literal_token>", ... } }`,
    `    \`\`\``,
    `- **Anti-Patterns**: DO NOT use shell \`export\` or prepend \`grep\` / \`cut\` extraction scripts to every \`exec\` call.`,
    `- **Direct Value Fallback**: If any variable is empty or missing from your shell context, read and copy its literal value directly from the JSON block at the bottom of this prompt into your command or code.`,
  ].join("\n");

  const commonGuidelines = [
    `- Start actionable work in this heartbeat; do not stop at a plan unless the issue asks for planning.`,
    `- Leave durable progress in comments, documents, or work products with a clear next action.`,
    `- Prefer the smallest verification that proves the change; do not default to full workspace typecheck/build/test on every heartbeat unless the task scope warrants it.`,
    `- Use child issues for parallel or long delegated work instead of polling agents, sessions, or processes.`,
    `- Respect budget, pause/cancel, approval gates, and company boundaries.`,
  ];

  let contractAndGuidelines = "";
  if (wakeType === "heartbeat") {
    contractAndGuidelines = [
      `## Execution Contract & Guidelines:`,
      ...commonGuidelines,
    ].join("\n");
  } else if (wakeType === "wake") {
    contractAndGuidelines = [
      `## Execution Contract & Guidelines:`,
      `- Treat this wake payload as the highest-priority change for the current heartbeat.`,
      `- This heartbeat is scoped to the active task. Do not switch tasks until this wake is handled.`,
      `- Acknowledge the latest comment and explain how it changes your next action before generic repository exploration.`,
      `- Use this inline wake data first before refetching the issue thread. Fetch the thread API only if fallbackFetchNeeded is true or broader history is needed.`,
      ...commonGuidelines,
    ].join("\n");
  } else {
    contractAndGuidelines = [
      `## Execution Contract & Guidelines:`,
      `- You are resuming an existing Paperclip session. Focus strictly on the new resume delta details and proceed without restating the run boilerplate.`,
      `- This heartbeat is scoped to the active task. Do not switch tasks until this wake is handled.`,
      `- Use this inline wake data first before refetching the issue thread. Fetch the thread API only if fallbackFetchNeeded is true or broader history is needed.`,
      ...commonGuidelines,
    ].join("\n");
  }

  const collaborativeWorkspaceInstruction = [
    `## Collaborative Main Workspace Instruction:`,
    `- **Main Company Workspace**: For all codebase modifications, document reading, and collaborative task execution, a company-wide workspace is located at:`,
    `  \`${paperclipEnv.PAPERCLIP_MAIN_WORKSPACE_DIR || ""}\``,
    `- **Execution Boundary**: You MUST operate strictly within this designated company "main/" directory. Do NOT read, copy, modify, write, or list any files or folders outside of this directory path under any circumstances. Accessing or copying data from parent, sibling, or other company directories is strictly prohibited and violates security boundaries.`,
    `- **Execution Procedure**: For all tasks, you MUST perform your operations (such as running git commands, building projects, or reading files) directly in the "main/" directory. Use absolute paths or shell execution (e.g. running scripts or commands targeting the "main/" directory).`,
  ].join("\n");

  const staticInstructions = [
    `# Persona & Rules (Static System Instructions)`,
    ``,
    `You are agent ${agent.id} (${agent.name}). Continue your Paperclip work.`,
    ``,
    `Your core execution is governed by the 'paperclip' skill. You must prioritize the heartbeat procedure in 'paperclip/SKILL.md'. Use auxiliary skills strictly for task-specific operations:`,
    auxiliarySkillsText,
    ``,
    contractAndGuidelines,
    ``,
    collaborativeWorkspaceInstruction,
    ``,
    errorLoopGuardrail,
  ].join("\n");

  // 2. Active Event Payload Dynamic Context
  let dynamicInstructions = "";
  let environmentJson: Record<string, string> = {};

  if (wakeType === "heartbeat") {
    dynamicInstructions = [
      `## Parsed Event Type: HEARTBEAT (Background Maintenance)`,
      `You are running on a scheduled or manual background maintenance heartbeat. Check for outstanding todo issues or background operations.`,
      ``,
      `The following are the environment variable definitions. These variables are provided as text for you to inject manually; they are **not** automatically present in your shell environment.`,
    ].join("\n");

    environmentJson = {
      PAPERCLIP_AGENT_ID: paperclipEnv.PAPERCLIP_AGENT_ID || "",
      PAPERCLIP_COMPANY_ID: paperclipEnv.PAPERCLIP_COMPANY_ID || "",
      PAPERCLIP_API_URL: (paperclipEnv.PAPERCLIP_API_URL || "").replace(/\/$/, ""),
      PAPERCLIP_RUN_ID: paperclipEnv.PAPERCLIP_RUN_ID || "",
      PAPERCLIP_TASK_ID: paperclipEnv.PAPERCLIP_TASK_ID || "",
      PAPERCLIP_MAIN_WORKSPACE_DIR: paperclipEnv.PAPERCLIP_MAIN_WORKSPACE_DIR || "",
    };
  } else {
    const isWake = wakeType === "wake";
    const headerTitle = isWake ? "WAKE_PAYLOAD (Cold Start)" : "Paperclip Resume Delta";

    const reason = nonEmpty(parsed.reason) ?? nonEmpty(parsed.wakeReason) ?? "unknown";
    const issue = asRecord(parsed.issue);
    const issueIdentifier = nonEmpty(issue?.identifier) ?? nonEmpty(issue?.id) ?? "unknown";
    const issueTitle = nonEmpty(issue?.title) ?? "unknown";
    const issueStatus = nonEmpty(issue?.status) ?? "unknown";
    const issuePriority = nonEmpty(issue?.priority) ?? "unknown";
    const latestCommentId = nonEmpty(parsed.latestCommentId) ?? "unknown";
    const fallbackFetchNeeded = parsed.fallbackFetchNeeded !== undefined ? String(parsed.fallbackFetchNeeded) : "false";
    const checkedOutByHarness = parsed.checkedOutByHarness !== undefined ? String(parsed.checkedOutByHarness) : "false";
    const continuationSummary = nonEmpty((parsed.continuationSummary as Record<string, any>)?.body) ?? "- (No continuation summary available)";

    let childIssueSummariesText = "- (No child issues spawned)";
    if (Array.isArray(parsed.childIssueSummaries) && parsed.childIssueSummaries.length > 0) {
      childIssueSummariesText = parsed.childIssueSummaries.map((s: any) => {
        if (typeof s === "string") return `- ${s}`;
        if (s && typeof s === "object") {
          const parts = [];
          if (s.identifier) parts.push(s.identifier);
          if (s.title) parts.push(s.title);
          if (s.status) parts.push(`(${s.status})`);
          return `- ${parts.join(" ")}`;
        }
        return `- ${JSON.stringify(s)}`;
      }).join("\n");
    } else if (typeof parsed.childIssueSummaries === "string" && parsed.childIssueSummaries.trim()) {
      childIssueSummariesText = parsed.childIssueSummaries.trim();
    }

    dynamicInstructions = [
      `## Parsed Event Type: ${headerTitle}`,
      `- reason: ${reason}`,
      `- issue: ${issueIdentifier} ${issueTitle}`,
      `- latest comment id: ${latestCommentId}`,
      `- fallback fetch needed: ${fallbackFetchNeeded}`,
      `- issue status: ${issueStatus}`,
      `- issue priority: ${issuePriority}`,
      `- checkout: ${checkedOutByHarness}`,
      ``,
      `## Issue Continuation Summary:`,
      continuationSummary,
      ``,
      `## Direct Child Issue Summaries:`,
      childIssueSummariesText,
    ].join("\n");

    if (isWake) {
      dynamicInstructions += "\n\n" + `The harness already checked out this issue for the current run. Do not call \`/api/issues/{id}/checkout\` again unless you intentionally switch to a different task.`;
    }

    environmentJson = {
      PAPERCLIP_AGENT_ID: paperclipEnv.PAPERCLIP_AGENT_ID || "",
      PAPERCLIP_COMPANY_ID: paperclipEnv.PAPERCLIP_COMPANY_ID || "",
      PAPERCLIP_API_URL: (paperclipEnv.PAPERCLIP_API_URL || "").replace(/\/$/, ""),
      PAPERCLIP_RUN_ID: paperclipEnv.PAPERCLIP_RUN_ID || "",
      PAPERCLIP_TASK_ID: paperclipEnv.PAPERCLIP_TASK_ID || "",
      PAPERCLIP_MAIN_WORKSPACE_DIR: paperclipEnv.PAPERCLIP_MAIN_WORKSPACE_DIR || "",
      PAPERCLIP_WAKE_REASON: paperclipEnv.PAPERCLIP_WAKE_REASON || "",
      PAPERCLIP_WAKE_COMMENT_ID: paperclipEnv.PAPERCLIP_WAKE_COMMENT_ID || "",
      PAPERCLIP_APPROVAL_ID: paperclipEnv.PAPERCLIP_APPROVAL_ID || "",
      PAPERCLIP_APPROVAL_STATUS: paperclipEnv.PAPERCLIP_APPROVAL_STATUS || "",
      PAPERCLIP_LINKED_ISSUE_IDS: paperclipEnv.PAPERCLIP_LINKED_ISSUE_IDS || "",
      PAPERCLIP_WAKE_PAYLOAD_JSON: stringifyWakePayload(paperclipWake) || "{}",
    };
  }

  // 3. Structured JSON Context Suffix
  const contextJson = JSON.stringify(environmentJson, null, 2);

  const dynamicSuffix = [
    `# Dynamic Context (Active Event Payload)`,
    dynamicInstructions,
    ``,
    `\`\`\`json`,
    contextJson,
    `\`\`\``,
  ].join("\n");

  return [staticInstructions, ``, dynamicSuffix].join("\n");
}

