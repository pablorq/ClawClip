import { describe, expect, it, beforeEach } from "vitest";
import { initLogger, toLog, logContextStorage } from "../src/server/logger.js";
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

  it("should isolate logs in concurrent execution contexts using AsyncLocalStorage", async () => {
    const logA: string[] = [];
    const logB: string[] = [];

    const onLogA = async (stream: string, chunk: string) => {
      logA.push(chunk);
    };
    const onLogB = async (stream: string, chunk: string) => {
      logB.push(chunk);
    };

    const promiseA = logContextStorage.run({ onLog: onLogA, debug: false }, async () => {
      await toLog("stdout", "message A1");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await toLog("stdout", "message A2");
    });

    const promiseB = logContextStorage.run({ onLog: onLogB, debug: false }, async () => {
      await toLog("stdout", "message B1");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await toLog("stdout", "message B2");
    });

    await Promise.all([promiseA, promiseB]);

    expect(logA.join("")).toContain("message A1");
    expect(logA.join("")).toContain("message A2");
    expect(logA.join("")).not.toContain("message B1");
    expect(logA.join("")).not.toContain("message B2");

    expect(logB.join("")).toContain("message B1");
    expect(logB.join("")).toContain("message B2");
    expect(logB.join("")).not.toContain("message A1");
    expect(logB.join("")).not.toContain("message A2");
  });

  it("should respect debug value set on current logContextStorage context", async () => {
    const logs: string[] = [];
    const onLog = async (stream: string, chunk: string) => {
      logs.push(chunk);
    };

    // Case A: Context debug is true
    await logContextStorage.run({ onLog, debug: true }, async () => {
      await toLog("stdout", "[DEBUG] Dynamic debug message");
    });
    expect(logs.join("")).toContain("[DEBUG] Dynamic debug message");

    // Reset
    logs.length = 0;

    // Case B: Context debug is false
    await logContextStorage.run({ onLog, debug: false }, async () => {
      await toLog("stdout", "[DEBUG] Dynamic debug message");
    });
    expect(logs.join("")).not.toContain("[DEBUG] Dynamic debug message");
  });

  it("should only add timestamps to debug messages", async () => {
    const onLog = Object.assign(mockOnLog, { debug: true }) as AdapterExecutionContext["onLog"];
    initLogger(onLog);
    
    await toLog("stdout", "[DEBUG] Debug message");
    await toLog("stdout", "Standard message");

    expect(loggedChunks).toHaveLength(2);
    expect(loggedChunks[0]).toMatch(/^\d{8}-\d{6}\s+\[DEBUG\] Debug message\n$/);
    expect(loggedChunks[1]).toBe("Standard message\n");
  });
});
