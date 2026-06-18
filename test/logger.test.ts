import { describe, expect, it, beforeEach } from "vitest";
import { initLogger, toLog } from "../src/server/logger.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

describe("logger debug mode", () => {
  let loggedChunks: string[] = [];

  const mockOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    loggedChunks.push(chunk);
  };

  const getDebugMode = async (): Promise<boolean> => {
    let printed = false;
    const tempLog = async (stream: any, chunk: string) => {
      if (chunk.includes("[DEBUG]") || chunk.includes("DEBUG:")) printed = true;
    };
    initLogger(tempLog);
    await toLog("stdout", "[DEBUG] probe");
    return printed;
  };

  beforeEach(() => {
    loggedChunks = [];
  });

  it("should correctly handle debug logs based on debugMode", async () => {
    const isDebugModeEnabled = await getDebugMode();

    if (isDebugModeEnabled) {
      // If debugMode is true, it must always override and output debug logs
      const onLog = Object.assign(mockOnLog, { debug: false }) as AdapterExecutionContext["onLog"];
      initLogger(onLog);
      await toLog("stdout", "[DEBUG] Some debug message");
      expect(loggedChunks).toHaveLength(1);
    } else {
      // If debugMode is false, the AdapterExecutionContext must define the debug mode
      
      // Case A: Context debug is true -> should output debug logs
      const onLogTrue = Object.assign(mockOnLog, { debug: true }) as AdapterExecutionContext["onLog"];
      initLogger(onLogTrue);
      await toLog("stdout", "[DEBUG] Some debug message");
      expect(loggedChunks).toHaveLength(1);

      // Reset
      loggedChunks = [];

      // Case B: Context debug is false -> should NOT output debug logs
      const onLogFalse = Object.assign(mockOnLog, { debug: false }) as AdapterExecutionContext["onLog"];
      initLogger(onLogFalse);
      await toLog("stdout", "[DEBUG] Some debug message");
      expect(loggedChunks).toHaveLength(0);

      // Case C: Context debug is undefined -> should NOT output debug logs
      const onLogUndefined = mockOnLog as AdapterExecutionContext["onLog"];
      initLogger(onLogUndefined);
      await toLog("stdout", "[DEBUG] Some debug message");
      expect(loggedChunks).toHaveLength(0);
    }
  });

  it("should always output non-debug logs", async () => {
    const onLog = mockOnLog as AdapterExecutionContext["onLog"];
    initLogger(onLog);
    await toLog("stdout", "Some standard message");
    expect(loggedChunks).toHaveLength(1);
    expect(loggedChunks[0]).not.toContain("[DEBUG]");
  });
});
