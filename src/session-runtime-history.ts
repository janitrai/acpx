import type { ContentBlock, SessionNotification } from "@agentclientprotocol/sdk";
import { isoNow } from "./session-persistence.js";
import type { SessionHistoryEntry } from "./types.js";

const SESSION_HISTORY_MAX_ENTRIES = 500;
const SESSION_HISTORY_PREVIEW_CHARS = 220;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function toPreviewText(value: string): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= SESSION_HISTORY_PREVIEW_CHARS) {
    return collapsed;
  }
  if (SESSION_HISTORY_PREVIEW_CHARS <= 3) {
    return collapsed.slice(0, SESSION_HISTORY_PREVIEW_CHARS);
  }
  return `${collapsed.slice(0, SESSION_HISTORY_PREVIEW_CHARS - 3)}...`;
}

function textFromContent(content: ContentBlock): string | undefined {
  if (content.type === "text") {
    return content.text;
  }
  if (content.type === "resource_link") {
    return content.title ?? content.name ?? content.uri;
  }
  if (content.type === "resource") {
    if ("text" in content.resource && typeof content.resource.text === "string") {
      return content.resource.text;
    }
    return content.resource.uri;
  }
  return undefined;
}

export function toHistoryEntryFromUpdate(
  notification: SessionNotification,
): SessionHistoryEntry | undefined {
  const update = notification.update;
  if (
    update.sessionUpdate !== "user_message_chunk" &&
    update.sessionUpdate !== "agent_message_chunk"
  ) {
    return undefined;
  }

  const text = textFromContent(update.content);
  if (!text) {
    return undefined;
  }

  const textPreview = toPreviewText(text);
  if (!textPreview) {
    return undefined;
  }

  return {
    role: update.sessionUpdate === "user_message_chunk" ? "user" : "assistant",
    timestamp: isoNow(),
    textPreview,
  };
}

export function appendHistoryEntries(
  current: SessionHistoryEntry[] | undefined,
  entries: SessionHistoryEntry[],
): SessionHistoryEntry[] {
  const base = current ? [...current] : [];
  for (const entry of entries) {
    if (!entry.textPreview.trim()) {
      continue;
    }
    base.push(entry);
  }

  if (base.length <= SESSION_HISTORY_MAX_ENTRIES) {
    return base;
  }

  return base.slice(base.length - SESSION_HISTORY_MAX_ENTRIES);
}
