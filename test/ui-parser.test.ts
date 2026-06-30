import { describe, expect, it } from "vitest";
import { parseStdoutLine } from "../src/ui-parser.js";

describe("ClawClip UI Parser", () => {
  const ts = "2026-06-28T09:26:00.000Z";

  it("should ignore empty lines", () => {
    expect(parseStdoutLine("", ts)).toEqual([]);
  });

  it("should pass normal stdout lines through", () => {
    expect(parseStdoutLine("Hello world", ts)).toEqual([
      { kind: "stdout", ts, text: "Hello world" }
    ]);
  });

  it("should parse standard system message prefixed with [clawclip]", () => {
    expect(parseStdoutLine("[clawclip] Hello system", ts)).toEqual([
      { kind: "system", ts, text: "Hello system" }
    ]);
  });

  it("should parse lifecycle start events", () => {
    const line = `[clawclip:event] run=run-123 stream=lifecycle data={"phase":"start","startedAt":123}`;
    expect(parseStdoutLine(line, ts)).toEqual([
      { kind: "system", ts, text: "🚀 Remote agent started" }
    ]);
  });

  it("should parse lifecycle error/failed events", () => {
    const line = `[clawclip:event] run=run-123 stream=lifecycle data={"phase":"failed","error":"fatal error"}`;
    expect(parseStdoutLine(line, ts)).toEqual([
      { kind: "stderr", ts, text: "fatal error" }
    ]);
  });

  it("should parse assistant delta events", () => {
    const line = `[clawclip:event] run=run-123 stream=assistant data={"delta":"thinking delta"}`;
    expect(parseStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "thinking delta", delta: true }
    ]);
  });

  it("should parse assistant final text events", () => {
    const line = `[clawclip:event] run=run-123 stream=assistant data={"text":"final answer"}`;
    expect(parseStdoutLine(line, ts)).toEqual([
      { kind: "assistant", ts, text: "final answer" }
    ]);
  });

  it("should parse tool start events", () => {
    const line = `[clawclip:event] run=run-123 stream=item data={"itemId":"tool:1","phase":"start","kind":"tool","name":"exec","meta":"ls","toolCallId":"123"}`;
    expect(parseStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_call",
        ts,
        name: "command_execution",
        input: { command: "ls" },
        toolUseId: "123"
      }
    ]);
  });

  it("should ignore tool end events for exec since they are resolved by command end events", () => {
    const line = `[clawclip:event] run=run-123 stream=item data={"itemId":"tool:1","phase":"end","kind":"tool","name":"exec","status":"completed","toolCallId":"123","summary":"done ls"}`;
    expect(parseStdoutLine(line, ts)).toEqual([]);
  });

  it("should ignore command start items to prevent duplicates", () => {
    const line = `[clawclip:event] run=run-123 stream=item data={"itemId":"command:1","phase":"start","kind":"command","name":"exec","toolCallId":"123"}`;
    expect(parseStdoutLine(line, ts)).toEqual([]);
  });

  it("should parse command end events for exec to capture the full command output", () => {
    const line = `[clawclip:event] run=run-123 stream=item data={"itemId":"command:1","phase":"end","kind":"command","name":"exec","status":"completed","toolCallId":"123","output":"done ls"}`;
    expect(parseStdoutLine(line, ts)).toEqual([
      {
        kind: "tool_result",
        ts,
        toolUseId: "123",
        content: "done ls",
        isError: false
      }
    ]);
  });

  it("should parse command output delta events", () => {
    const line = `[clawclip:event] run=run-123 stream=command_output data={"phase":"delta","output":"partial stdout"}`;
    expect(parseStdoutLine(line, ts)).toEqual([
      { kind: "stdout", ts, text: "partial stdout" }
    ]);
  });

  it("should ignore command output end events to prevent duplicate leaks", () => {
    const line = `[clawclip:event] run=run-123 stream=command_output data={"phase":"end","output":"final output"}`;
    expect(parseStdoutLine(line, ts)).toEqual([]);
  });

  it("should parse generic error events", () => {
    const line = `[clawclip:event] run=run-123 stream=error data={"error":"network failure"}`;
    expect(parseStdoutLine(line, ts)).toEqual([
      { kind: "stderr", ts, text: "network failure" }
    ]);
  });
});
