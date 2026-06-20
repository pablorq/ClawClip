import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { AsyncLocalStorage } from "node:async_hooks";

export const logContextStorage = new AsyncLocalStorage<AdapterExecutionContext["onLog"]>();

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
  const activeLogger = logContextStorage.getStore() || activeOnLog;
  if (activeLogger && typeof (activeLogger as any).debug !== "undefined") {
    return !!(activeLogger as any).debug;
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
  const formatted = ts + " " + msg + "\n";

  const activeLogger = logContextStorage.getStore() || activeOnLog;
  if (activeLogger) {
    await activeLogger(stream, formatted);
  } else {
    if (stream === "stderr") {
      console.error(formatted);
    } else {
      console.log(formatted);
    }
  }
}
