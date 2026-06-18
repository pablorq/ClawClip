import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { toLog } from "./logger.js";

/**
 * Resolves the Paperclip API base URL.
 */
function resolvePaperclipApiUrl(ctx: AdapterExecutionContext): string | null {
  const configUrl = ctx.config.paperclipApiUrl;
  if (typeof configUrl === "string" && configUrl.trim()) {
    return configUrl.trim();
  }
  const envUrl = process.env.PAPERCLIP_API_URL || process.env.PAPERCLIP_RUNTIME_API_URL;
  if (typeof envUrl === "string" && envUrl.trim()) {
    return envUrl.trim();
  }
  return null;
}

/**
 * Best-effort helper to fetch the company name from Paperclip REST API.
 * Falls back to "Company <companyId>" if fetch fails or is unauthorized.
 */
export async function getCompanyName(ctx: AdapterExecutionContext): Promise<string> {
  const companyId = ctx.agent.companyId;
  const authToken = ctx.authToken;
  const apiBase = resolvePaperclipApiUrl(ctx);

  if (!authToken || !apiBase) {
    return `Company ${companyId}`;
  }

  try {
    const cleanUrl = `${apiBase.replace(/\/$/, "")}/api/companies/${companyId}`;
    const res = await fetch(cleanUrl, {
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    });
    if (res.ok) {
      const data = await res.json() as any;
      if (data && typeof data.name === "string" && data.name.trim()) {
        return data.name.trim();
      }
    }
  } catch {
    // Graceful fallback
  }
  return `Company ${companyId}`;
}

/**
 * Provisions a dedicated agent workspace on remote OpenClaw container runtime if needed,
 * and synchronizes instruction files (AGENTS.md) using a high-efficiency 3-Way Reconciliation.
 */
const ALLOWED_FILE_NAMES = new Set<string>([
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
]);

const BLACKLIST = new Set(["MEMORY.md"]);

async function walkInstructionsDir(
  dir: string,
  relPath = ""
): Promise<{ name: string; fullPath: string }[]> {
  let results: { name: string; fullPath: string }[] = [];
  let entries: any[] = [];
  try {
    entries = await fs.readdir(path.join(dir, relPath), { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const currentRel = relPath ? path.join(relPath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      const subResults = await walkInstructionsDir(dir, currentRel);
      results = results.concat(subResults);
    } else if (entry.isFile()) {
      results.push({
        name: currentRel,
        fullPath: path.join(dir, currentRel),
      });
    }
  }
  return results;
}

/**
 * Resolves the unified company-scoped remote workspace root directory.
 * Path format: <remoteWorkspaceRoot>/workspace-paperclip/<companyId>
 */
export function getCompanyWorkspaceBaseDir(
  ctx: AdapterExecutionContext,
  defaultAgentWorkspace?: string | null
): string {
  let remoteWorkspaceRoot: string;

  if (typeof ctx.config.remoteWorkspaceRoot === "string" && ctx.config.remoteWorkspaceRoot.trim()) {
    remoteWorkspaceRoot = ctx.config.remoteWorkspaceRoot.trim();
  } else if (defaultAgentWorkspace && defaultAgentWorkspace.trim()) {
    // remoteWorkspaceRoot is parent directory of the default workspace
    remoteWorkspaceRoot = path.posix.dirname(defaultAgentWorkspace.trim());
  } else {
    // Graceful default fallback
    remoteWorkspaceRoot = "/home/node/.openclaw";
  }

  // Ensure POSIX paths (using '/') on the remote agent container side
  return path.posix.join(
    remoteWorkspaceRoot,
    "workspace-paperclip",
    ctx.agent.companyId
  );
}

/**
 * Provisions a dedicated agent workspace on remote OpenClaw container runtime if needed,
 * and synchronizes instruction files using a high-efficiency multi-file 3-Way Reconciliation.
 */
export async function ensureAgentAndSyncInstructions(
  ctx: AdapterExecutionContext,
  client: any,
  targetAgentId: string,
  sessionKey?: string
): Promise<void> {
  // 1. Dedicated Remote Agent Provisioning via JSON-RPC
  let agentsListResult: any = null;
  try {
    agentsListResult = await client.request("agents.list", {});
  } catch (err) {
    await toLog("stderr", `[clawclip] ERROR: Failed to retrieve remote agent list via JSON-RPC: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  const agents = Array.isArray(agentsListResult)
    ? agentsListResult
    : (agentsListResult?.agents || []);

  const exists = Array.isArray(agents) && agents.some((a) => a && (a.id === targetAgentId || a.agentId === targetAgentId));

  // DEBUG: Log the agents list and exists
  await toLog(`[clawclip] [DEBUG] agents: ${JSON.stringify(agents)}`);
  await toLog(`[clawclip] [DEBUG] exists: ${JSON.stringify(exists)}`);

  const defaultAgent = Array.isArray(agents) && (
    agents.find((a) => a && (a.id === "default" || a.agentId === "default" || a.id === "main" || a.agentId === "main")) ||
    agents[0]
  );

  // Resolve the company base directory and dedicate workspace path nested under it
  const companyBaseDir = getCompanyWorkspaceBaseDir(ctx, defaultAgent?.workspace);
  const dedicatedWorkspaceDir = path.posix.join(companyBaseDir, "agents", ctx.agent.id);

  const companyName = await getCompanyName(ctx);
  const expectedName = `${companyName} - ${ctx.agent.name}`;
  const remoteAgent = Array.isArray(agents) && agents.find((a) => a && (a.id === targetAgentId || a.agentId === targetAgentId));

  // DEBUG: Log the company name, expected name, and remote agent
  await toLog(`[clawclip] [DEBUG] companyName: ${JSON.stringify(companyName)}`);
  await toLog(`[clawclip] [DEBUG] expectedName: ${JSON.stringify(expectedName)}`);
  await toLog(`[clawclip] [DEBUG] remoteAgent: ${JSON.stringify(remoteAgent)}`);

  if (!exists) {
    await toLog(`[clawclip] Dedicated remote agent not found. Provisioning workspace...`);

    await client.request("agents.create", {
      name: targetAgentId,
      workspace: dedicatedWorkspaceDir,
    });

    await toLog(`[clawclip] Dedicated remote agent ${targetAgentId} successfully provisioned.`);
  }

  // Dynamic update check: update only if remote and local names differ
  const currentName = remoteAgent?.name || remoteAgent?.identity?.name;
  if (currentName !== expectedName) {
    await toLog(`[clawclip] [DEBUG] Remote agent name ("${currentName}") differs from local ("${expectedName}"). Updating...`);
    try {
      // Clear IDENTITY.md before update to prevent stale identity data
      await toLog(`[clawclip] [DEBUG] Clearing remote IDENTITY.md before agent name update...`);
      await client.request("agents.files.set", {
        agentId: targetAgentId,
        name: "IDENTITY.md",
        content: "",
      });
      await client.request("agents.update", {
        agentId: targetAgentId,
        name: expectedName,
        emoji: "📎",
      });
    } catch (err) {
      await toLog("stderr", `[clawclip] WARNING: Best-effort agent update failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    await toLog(`[clawclip] Remote agent name ("${currentName}") matches expected name. Skipping update.`);
  }

  // 2. Smart 3-Way Instructions Reconciliation
  const instructionsFilePath = (ctx.config as any).instructionsFilePath;
  if (!instructionsFilePath) {
    await toLog(`[clawclip] No instructionsFilePath configured. Skipping instruction sync.`);
    return;
  }

  await toLog(`[clawclip] Initializing 3-way reconciliation for instruction files...`);

  const localDir = path.dirname(instructionsFilePath);
  const localFiles = await walkInstructionsDir(localDir);
  const allowedLocalFiles = localFiles.filter((f) => ALLOWED_FILE_NAMES.has(f.name));

  // Read all local instruction file contents
  const localFileContents = new Map<string, string>();
  for (const file of allowedLocalFiles) {
    try {
      const content = await fs.readFile(file.fullPath, "utf8");
      localFileContents.set(file.name, content);
    } catch {
      // Ignore
    }
  }

  // Fallback to the main instructionsFilePath if it wasn't scanned but is readable
  const mainFilename = path.basename(instructionsFilePath);
  if (ALLOWED_FILE_NAMES.has(mainFilename) && !localFileContents.has(mainFilename)) {
    try {
      const content = await fs.readFile(instructionsFilePath, "utf8");
      localFileContents.set(mainFilename, content);
    } catch {
      // Ignore
    }
  }

  if (localFileContents.size === 0) {
    await toLog(`[clawclip] No readable instruction files found. Skipping instructions sync.`);
    return;
  }

  // 3. Instruction Injection Loop (up to 3 times)
  let attempts = 0;
  const maxAttempts = 3;
  let converged = false;

  while (attempts < maxAttempts && !converged) {
    attempts++;

    // A. Fetch remote files list
    let remoteFiles: any = [];
    try {
      remoteFiles = await client.request("agents.files.list", { agentId: targetAgentId });
    } catch (err) {
      await toLog("stderr", `[clawclip] WARNING: Failed to fetch remote agent files list on attempt ${attempts}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const remoteFilesList = Array.isArray(remoteFiles) ? remoteFiles : (remoteFiles?.files || []);

    let operationsPerformed = 0;

    // Case a) Update remote: Local file not matching remote file -> update remote file. Exception: MEMORY.md
    for (const [name, content] of localFileContents.entries()) {
      if (name === "MEMORY.md" || BLACKLIST.has(name)) {
        continue;
      }
      const remoteFile = remoteFilesList.find((rf: any) => rf && rf.name === name);
      const localByteLength = Buffer.byteLength(content, "utf8");
      const matches = remoteFile && !remoteFile.missing && remoteFile.size === localByteLength;
      if (!matches) {
        const remoteSize = remoteFile?.size ?? "N/A";
        await toLog(`[clawclip] Loop ${attempts}/${maxAttempts}: Case A (Update remote) for ${name} (local: ${localByteLength} bytes, remote: ${remoteSize} bytes)...`);
        try {
          await client.request("agents.files.set", {
            agentId: targetAgentId,
            name,
            content,
          });
          operationsPerformed++;
        } catch (err) {
          await toLog("stderr", `[clawclip] ERROR: Failed to update remote file ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Case b) Empty remote: Remote file not present in local -> update remote file with empty file. Exception: IDENTITY.md
    for (const remoteFile of remoteFilesList) {
      if (remoteFile && !remoteFile.missing && remoteFile.size > 0 && ALLOWED_FILE_NAMES.has(remoteFile.name)) {
        if (remoteFile.name === "IDENTITY.md" || remoteFile.name === "BOOTSTRAP.md") {
          continue; // Exception: IDENTITY.md, BOOTSTRAP.md
        }
        if (!localFileContents.has(remoteFile.name) && !BLACKLIST.has(remoteFile.name)) {
          await toLog(`[clawclip] Loop ${attempts}/${maxAttempts}: Case B (Empty remote) for ${remoteFile.name}...`);
          try {
            await client.request("agents.files.set", {
              agentId: targetAgentId,
              name: remoteFile.name,
              content: "",
            });
            operationsPerformed++;
          } catch (err) {
            await toLog("stderr", `[clawclip] ERROR: Failed to empty remote file ${remoteFile.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    // Case c) Nothing to do: all matching and extra are empty
    if (operationsPerformed === 0) {
      converged = true;
      await toLog(`[clawclip] Instruction files are perfectly in sync. Exiting loop.`);
      break;
    }
  }

  if (!converged) {
    await toLog(`[clawclip] WARNING: Instruction files injection loop could not get the "Nothing to do" scenario after ${maxAttempts} attempts.`);
  }

  // 4. Force remote setup completion if not already marked, by invoking agents.update with workspace.
  // This will run ensureAgentWorkspace on the remote side, delete the template BOOTSTRAP.md, 
  // and mark setupCompletedAt before we inject our custom BOOTSTRAP.md token registry.
  try {
    await toLog(`[clawclip] Triggering remote workspace setup completion check...`);
    await client.request("agents.update", {
      agentId: targetAgentId,
      workspace: dedicatedWorkspaceDir,
    });
  } catch (err) {
    await toLog("stderr", `[clawclip] WARNING: Failed to trigger workspace setup completion check: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Programmatically registers the runId -> token mapping in the remote agent's BOOTSTRAP.md registry,
 * while keeping only the last 100 mappings to prevent uncontrolled file growth.
 */
export async function registerSessionTokenInBootstrap(
  ctx: AdapterExecutionContext,
  client: any,
  targetAgentId: string,
  runId: string,
  token: string
): Promise<void> {
  const maxAttempts = 3;
  const initialDelayMs = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await toLog(`[clawclip] Registering session token for runId=${runId} in BOOTSTRAP.md (Attempt ${attempt}/${maxAttempts})...`);

    let existingContent = "";
    try {
      const response = await client.request("agents.files.get", {
        agentId: targetAgentId,
        name: "BOOTSTRAP.md",
      });
      if (response?.file && !response.file.missing) {
        existingContent = response.file.content || "";
      }
    } catch (err) {
      await toLog(`[clawclip] BOOTSTRAP.md not found or unreadable on read phase, creating a new registry...`);
    }

    // Parse lines or build a new list
    let lines = existingContent.split("\n");
    const headerIndex = lines.findIndex(l => l.trim().startsWith("# Session Registry"));

    const mappingLine = `- ${runId}: ${token}`;

    if (headerIndex === -1) {
      // If header doesn't exist, create it at the top
      lines = [
        "# Session Registry",
        "This registry maps session run IDs to authentication tokens.",
        mappingLine,
        ...lines.filter(l => l.trim().length > 0 && !l.trim().startsWith("#")),
      ];
    } else {
      // Check if runId already exists in lines
      const runIdIndex = lines.findIndex(l => l.trim().startsWith(`- ${runId}:`));
      if (runIdIndex !== -1) {
        lines[runIdIndex] = mappingLine;
      } else {
        // Find the last list item under the header to append it
        let insertIndex = headerIndex + 1;
        while (
          insertIndex < lines.length &&
          (lines[insertIndex].trim() === "" ||
            lines[insertIndex].trim().startsWith("This registry") ||
            lines[insertIndex].trim().startsWith("- "))
        ) {
          insertIndex++;
        }
        lines.splice(insertIndex, 0, mappingLine);
      }
    }

    // Prune older mapping entries to avoid growing infinitely (e.g. keep max 20 mappings)
    const nonMappingLines = lines.filter(l => !l.trim().startsWith("- "));
    let mappingLines = lines.filter(l => l.trim().startsWith("- "));
    if (mappingLines.length > 20) {
      mappingLines = mappingLines.slice(-20);
    }

    const finalContent = [
      ...nonMappingLines.slice(0, 2),
      ...mappingLines,
      ...nonMappingLines.slice(2)
    ].join("\n");

    try {
      await client.request("agents.files.set", {
        agentId: targetAgentId,
        name: "BOOTSTRAP.md",
        content: finalContent,
      });
      await toLog(`[clawclip] BOOTSTRAP.md set command executed successfully. Verifying...`);
    } catch (err) {
      await toLog("stderr", `[clawclip] ERROR: agents.files.set failed during attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Insert sync delay for remote filesystem / server database write propagation
    const syncDelay = process.env.NODE_ENV === "test" ? 0 : initialDelayMs * attempt;
    await new Promise((resolve) => setTimeout(resolve, syncDelay));

    // Verify remote file contains the current token
    try {
      const verifyResponse = await client.request("agents.files.get", {
        agentId: targetAgentId,
        name: "BOOTSTRAP.md",
      });
      const verifyContent = verifyResponse?.file?.content || "";
      if (verifyContent.includes(token)) {
        await toLog(`[clawclip] Session token successfully registered and verified in BOOTSTRAP.md.`);
        return; // Verification succeeded! Exit function.
      } else {
        await toLog("stderr", `[clawclip] WARNING: Verification failed. BOOTSTRAP.md exists but does not contain the current session token.`);
      }
    } catch (err) {
      await toLog("stderr", `[clawclip] WARNING: Failed to retrieve BOOTSTRAP.md for verification: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (attempt < maxAttempts) {
      const waitTime = process.env.NODE_ENV === "test" ? 0 : initialDelayMs * attempt;
      await toLog(`[clawclip] Retrying injection in ${waitTime}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  // Raise standard terminal error if all attempts fail
  throw new Error(
    `Critical Error: Failed to inject and verify BOOTSTRAP.md token registry after ${maxAttempts} attempts.`
  );
}