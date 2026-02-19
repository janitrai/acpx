import assert from "node:assert/strict";
import test from "node:test";
import { createOutputFormatter } from "../src/output.js";

class CaptureWriter {
  public readonly chunks: string[] = [];
  public isTTY = false;

  write(chunk: string): void {
    this.chunks.push(chunk);
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function messageChunk(text: string): unknown {
  return {
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  };
}

function thoughtChunk(text: string): unknown {
  return {
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    },
  };
}

test("text formatter batches thought tokens", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onSessionUpdate(thoughtChunk("Investigating ") as never);
  formatter.onSessionUpdate(thoughtChunk("the issue") as never);
  formatter.onSessionUpdate(messageChunk("Done.") as never);
  formatter.onDone("end_turn");

  const output = writer.toString();
  assert.equal((output.match(/\[thinking\]/g) ?? []).length, 1);
  assert.match(output, /\[thinking\] Investigating the issue/);
});

test("text formatter renders tool calls with input and output", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onSessionUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "run_command",
      status: "in_progress",
      rawInput: { command: "npm", args: ["test"] },
    },
  } as never);

  formatter.onSessionUpdate({
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "run_command",
      status: "completed",
      rawInput: { command: "npm", args: ["test"] },
      rawOutput: { stdout: "All tests passing" },
    },
  } as never);

  const output = writer.toString();
  assert.match(output, /\[tool\] run_command/);
  assert.match(output, /input: npm test/);
  assert.match(output, /output:/);
  assert.match(output, /All tests passing/);
});

test("json formatter emits valid NDJSON", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", { stdout: writer });

  formatter.onSessionUpdate(messageChunk("Hello") as never);
  formatter.onSessionUpdate(thoughtChunk("Thinking") as never);
  formatter.onDone("end_turn");

  const lines = writer
    .toString()
    .trim()
    .split("\n")
    .filter((line) => line.length > 0);
  const parsed = lines.map((line) => JSON.parse(line));

  assert.equal(parsed[0]?.type, "text");
  assert.equal(parsed[1]?.type, "thought");
  assert.equal(parsed[2]?.type, "done");
});

test("text formatter renders client operation updates", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("text", { stdout: writer });

  formatter.onClientOperation({
    method: "fs/read_text_file",
    status: "completed",
    summary: "read_text_file: /tmp/demo.txt",
    details: "line=1, limit=20",
    timestamp: new Date().toISOString(),
  });

  const output = writer.toString();
  assert.match(output, /\[client\] read_text_file: \/tmp\/demo.txt \(completed\)/);
  assert.match(output, /line=1, limit=20/);
});

test("json formatter emits client operation NDJSON events", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("json", { stdout: writer });

  formatter.onClientOperation({
    method: "terminal/create",
    status: "running",
    summary: "terminal/create: node -e \"console.log('hi')\"",
    timestamp: new Date().toISOString(),
  });

  const line = writer.toString().trim();
  const parsed = JSON.parse(line) as { type: string; method: string; status: string };
  assert.equal(parsed.type, "client_operation");
  assert.equal(parsed.method, "terminal/create");
  assert.equal(parsed.status, "running");
});

test("quiet formatter suppresses non-text output", () => {
  const writer = new CaptureWriter();
  const formatter = createOutputFormatter("quiet", { stdout: writer });

  formatter.onSessionUpdate(thoughtChunk("private") as never);
  formatter.onSessionUpdate({
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-2",
      title: "read_file",
      status: "completed",
    },
  } as never);
  formatter.onSessionUpdate(messageChunk("Hello ") as never);
  formatter.onSessionUpdate(messageChunk("world") as never);
  formatter.onDone("end_turn");

  assert.equal(writer.toString(), "Hello world\n");
});
