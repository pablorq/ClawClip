import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

let activeOnLog: AdapterExecutionContext["onLog"] | null = null;
let debugMode = false;

// export function initLogger(onLog: AdapterExecutionContext["onLog"], debug = false) {
export function initLogger(onLog: AdapterExecutionContext["onLog"]) {
  activeOnLog = onLog;
  // debugVariable = debug;
}

function isDebugEnabled(): boolean {
  if (debugMode) {
    return true;
  }
  if (activeOnLog && typeof (activeOnLog as any).debug !== "undefined") {
    return !!(activeOnLog as any).debug;
  }
  return false;
}

function getTimestamp(): string {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${YYYY}${MM}${DD}-${hh}${mm}${ss}`;
}

function formatLogMessage(
  msg: string,
  debugEnabled = false
): string {
  const ts = getTimestamp();
  const hasDebugTag = msg.includes("[DEBUG]") || msg.includes("DEBUG:") || msg.includes(" [DEBUG] ");
  const source = msg.includes("[openclaw]") ? "openclaw" : "bridge";

  const cleanMsg = msg
    .replace(/\[\d{8}-\d{6}\]\s*/g, "")
    .replace(/\d{8}-\d{6}\s*-\s*/g, "")
    .replace(/\[DEBUG\]\s*/g, "")
    .replace(/DEBUG:\s*/g, "")
    .replace(/\[openclaw[-_]bridge\]\s*/g, "")
    .replace(/\[bridge\]\s*/g, "")
    .replace(/\[openclaw\]\s*/g, "")
    .trim();

  if (hasDebugTag && debugEnabled) {
    return `[${ts}] [DEBUG] [${source}] ${cleanMsg}\n`;
  }
  return `[${ts}] [${source}] ${cleanMsg}\n`;
}

export async function toLog(
  streamOrMessage: "stdout" | "stderr" | string | null | undefined,
  message?: string
): Promise<void> {
  let stream: "stdout" | "stderr" = "stdout";
  let msg = "";

  if (message === undefined) {
    msg = typeof streamOrMessage === "string" ? streamOrMessage : "";
  } else {
    stream = streamOrMessage === "stderr" ? "stderr" : "stdout";
    msg = message;
  }

  const isDebug = isDebugEnabled();
  const isDebugLog = msg.includes("[DEBUG]") || msg.includes("DEBUG:") || msg.includes(" [DEBUG] ");

  if (isDebugLog && !isDebug) {
    return;
  }

  const ts = getTimestamp();
  // const formatted = formatLogMessage(msg, isDebug);
  const formatted = ts + " " + msg + "\n";

  if (activeOnLog) {
    await activeOnLog(stream, formatted);
  } else {
    if (stream === "stderr") {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }
}
