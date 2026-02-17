import type {
  SessionNotification,
  StopReason,
  ToolCallStatus,
} from "@agentclientprotocol/sdk";
import type { OutputEvent, OutputFormat, OutputFormatter } from "./types.js";

type WritableLike = {
  write(chunk: string): void;
};

type OutputFormatterOptions = {
  stdout?: WritableLike;
};

function nowIso(): string {
  return new Date().toISOString();
}

function asStatus(status: ToolCallStatus | null | undefined): string {
  return status ?? "unknown";
}

class TextOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;

  constructor(stdout: WritableLike) {
    this.stdout = stdout;
  }

  onSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.stdout.write(update.content.text);
        }
        return;
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          this.stdout.write(`\n[thought] ${update.content.text}\n`);
        }
        return;
      }
      case "tool_call": {
        this.stdout.write(`\n[tool] ${update.title} (${asStatus(update.status)})\n`);
        return;
      }
      case "tool_call_update": {
        const title = update.title ?? update.toolCallId;
        this.stdout.write(`\n[tool] ${title} (${asStatus(update.status)})\n`);
        return;
      }
      case "plan": {
        this.stdout.write("\n[plan]\n");
        for (const entry of update.entries) {
          this.stdout.write(`- (${entry.status}) ${entry.content}\n`);
        }
        return;
      }
      default:
        return;
    }
  }

  onDone(stopReason: StopReason): void {
    this.stdout.write(`\n[done] ${stopReason}\n`);
  }

  flush(): void {
    // no-op for streaming output
  }
}

class JsonOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;

  constructor(stdout: WritableLike) {
    this.stdout = stdout;
  }

  onSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    const timestamp = nowIso();

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.emit({
            type: "text",
            content: update.content.text,
            timestamp,
          });
        }
        return;
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          this.emit({
            type: "thought",
            content: update.content.text,
            timestamp,
          });
        }
        return;
      }
      case "tool_call": {
        this.emit({
          type: "tool_call",
          title: update.title,
          toolCallId: update.toolCallId,
          status: update.status,
          timestamp,
        });
        return;
      }
      case "tool_call_update": {
        this.emit({
          type: "tool_call",
          title: update.title ?? undefined,
          toolCallId: update.toolCallId,
          status: update.status ?? undefined,
          timestamp,
        });
        return;
      }
      case "plan": {
        this.emit({
          type: "plan",
          entries: update.entries.map((entry) => ({
            content: entry.content,
            status: entry.status,
            priority: entry.priority,
          })),
          timestamp,
        });
        return;
      }
      default: {
        this.emit({
          type: "update",
          update: update.sessionUpdate,
          timestamp,
        });
      }
    }
  }

  onDone(stopReason: StopReason): void {
    this.emit({
      type: "done",
      stopReason,
      timestamp: nowIso(),
    });
  }

  flush(): void {
    // no-op for streaming output
  }

  private emit(event: OutputEvent): void {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

class QuietOutputFormatter implements OutputFormatter {
  private readonly stdout: WritableLike;
  private chunks: string[] = [];

  constructor(stdout: WritableLike) {
    this.stdout = stdout;
  }

  onSessionUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate !== "agent_message_chunk") {
      return;
    }
    if (update.content.type !== "text") {
      return;
    }
    this.chunks.push(update.content.text);
  }

  onDone(_stopReason: StopReason): void {
    const text = this.chunks.join("");
    this.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  flush(): void {
    // no-op for streaming output
  }
}

export function createOutputFormatter(
  format: OutputFormat,
  options: OutputFormatterOptions = {},
): OutputFormatter {
  const stdout = options.stdout ?? process.stdout;

  switch (format) {
    case "text":
      return new TextOutputFormatter(stdout);
    case "json":
      return new JsonOutputFormatter(stdout);
    case "quiet":
      return new QuietOutputFormatter(stdout);
    default: {
      const exhaustive: never = format;
      throw new Error(`Unsupported output format: ${exhaustive}`);
    }
  }
}
