import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function normalizeClawClipStreamLine(rawLine: string): {
  stream: "stdout" | "stderr" | null;
  line: string;
} {
  const trimmed = rawLine.trim();
  if (!trimmed) return { stream: null, line: "" };

  const prefixed = trimmed.match(/^(stdout|stderr)\s*[:=]?\s*(.*)$/i);
  if (!prefixed) {
    return { stream: null, line: trimmed };
  }

  const stream = prefixed[1]?.toLowerCase() === "stderr" ? "stderr" : "stdout";
  const line = (prefixed[2] ?? "").trim();
  return { stream, line };
}

// ui-parser 260629-0918
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

let debugMode = false;
if (debugMode) {
  console.log("[clawclip:ui-parser] Evaluating ui-parser.js inside worker bootstrap");
}

let parseCallCount = 0;
let initLogEmitted = false;

function parseAgentEventLine(line: string, ts: string): TranscriptEntry[] {
  const match = line.match(/^\[clawclip:event\]\s+run=([^\s]+)\s+stream=([^\s]+)\s+data=(.*)$/s);
  if (!match) return [{ kind: "stdout", ts, text: line }];

  const stream = asString(match[2]).toLowerCase();
  const rawData = asString(match[3]).trim();
  const parsed = safeJsonParse(rawData);
  const data = asRecord(parsed);

  if (!data && rawData) {
    console.warn(`[clawclip:ui-parser] Failed to parse JSON event payload: "${rawData}"`);
  }

  if (stream === "assistant") {
    const delta = asString(data?.delta);
    if (delta.length > 0) return [{ kind: "assistant", ts, text: delta, delta: true }];
    const text = asString(data?.text);
    if (text.length > 0) return [{ kind: "assistant", ts, text }];
    return [];
  }

  if (stream === "error") {
    const message = asString(data?.error) || asString(data?.message);
    return message ? [{ kind: "stderr", ts, text: message }] : [];
  }

  if (stream === "lifecycle") {
    const phase = asString(data?.phase).toLowerCase();
    const message = asString(data?.error) || asString(data?.message);
    if (phase === "start") {
      return [{ kind: "system", ts, text: "🚀 Remote agent started" }];
    }
    if ((phase === "error" || phase === "failed" || phase === "cancelled") && message) {
      return [{ kind: "stderr", ts, text: message }];
    }
  }

  if (stream === "item") {
    const kind = asString(data?.kind);
    const phase = asString(data?.phase).toLowerCase();
    const name = asString(data?.name);
    const toolCallId = asString(data?.toolCallId) || asString(data?.itemId);

    if (kind === "tool") {
      if (phase === "start") {
        const title = asString(data?.title);
        const meta = asString(data?.meta);
        let input: unknown = meta || title || {};
        const parsedMeta = safeJsonParse(meta);
        if (parsedMeta && typeof parsedMeta === "object") {
          input = parsedMeta;
        }
        if (name === "exec") {
          const commandText = typeof input === "string" ? input : (meta || title || "");
          input = { command: commandText };
        }
        return [{
          kind: "tool_call",
          ts,
          name: name === "exec" ? "command_execution" : name,
          input,
          toolUseId: toolCallId,
        }];
      }
      if (phase === "end") {
        if (name === "exec") {
          // Ignore tool end for exec, wait for command end to get full output
          return [];
        }
        const status = asString(data?.status).toLowerCase();
        const summary = asString(data?.summary);
        return [{
          kind: "tool_result",
          ts,
          toolUseId: toolCallId,
          content: summary || asString(data?.status) || "Completed",
          isError: status === "failed",
        }];
      }
    }

    if (kind === "command") {
      if (phase === "end" && name === "exec") {
        const status = asString(data?.status).toLowerCase();
        const output = asString(data?.output);
        const summary = asString(data?.summary);
        return [{
          kind: "tool_result",
          ts,
          toolUseId: toolCallId,
          content: output || summary || asString(data?.status) || "Completed",
          isError: status === "failed",
        }];
      }
    }
  }

  if (stream === "command_output") {
    const phase = asString(data?.phase).toLowerCase();
    const output = asString(data?.output);
    if (phase === "delta" && output.length > 0) {
      return [{ kind: "stdout", ts, text: output }];
    }
  }

  return [];
}

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const normalized = normalizeClawClipStreamLine(line);
  if (normalized.stream !== "stderr") {
    const trimmed = normalized.line.trim();
    if (!trimmed) return [];
  }

  parseCallCount++;

  const diagnostics: TranscriptEntry[] = [];
  const isTestEnv = typeof process !== "undefined";
  if (!initLogEmitted && !isTestEnv) {
    initLogEmitted = true;
    diagnostics.push({
      kind: "system",
      ts,
      text: `[clawclip:ui-parser] Worker initialized successfully (Call count: ${parseCallCount})`,
    });
  }

  if (debugMode) {
    console.log(`[clawclip:ui-parser] parseStdoutLine called #${parseCallCount} (debugMode=${debugMode}): "${line.slice(0, 100)}"`);
  }

  try {
    if (normalized.stream === "stderr") {
      return [...diagnostics, { kind: "stderr", ts, text: normalized.line }];
    }

    const trimmed = normalized.line.trim();

    if (trimmed === "[clawclip:debug] enable") {
      debugMode = true;
      console.log("[clawclip:ui-parser] Debug mode enabled");
      return diagnostics;
    }

    if (trimmed === "[clawclip:debug] disable") {
      debugMode = false;
      console.log("[clawclip:ui-parser] Debug mode disabled");
      return diagnostics;
    }

    if (debugMode) {
      console.log(`[clawclip:ui-parser] Processing line: "${trimmed}"`);
    }

    if (trimmed.startsWith("[clawclip:event]")) {
      const result = parseAgentEventLine(trimmed, ts);
      if (debugMode) {
        console.log(`[clawclip:ui-parser] Parsed event result:`, JSON.stringify(result));
      }
      return [...diagnostics, ...result];
    }

    if (trimmed.startsWith("[clawclip]")) {
      return [...diagnostics, { kind: "system", ts, text: trimmed.replace(/^\[clawclip\]\s*/, "") }];
    }

    return [...diagnostics, { kind: "stdout", ts, text: normalized.line }];
  } catch (err: any) {
    console.error("[clawclip:ui-parser] Runtime error in parseStdoutLine:", err?.message || err, err?.stack);
    return [
      ...diagnostics,
      {
        kind: "system",
        ts,
        text: `[clawclip:ui-parser] ERROR in parseStdoutLine: ${err?.message || String(err)}`,
      },
    ];
  }
}
