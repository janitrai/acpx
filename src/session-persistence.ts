import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionHistoryEntry, SessionRecord } from "./types.js";

export const DEFAULT_HISTORY_LIMIT = 20;

type FindSessionOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  includeClosed?: boolean;
};

type FindSessionByDirectoryWalkOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  boundary?: string;
};

function sessionFilePath(id: string): string {
  const safeId = encodeURIComponent(id);
  return path.join(sessionBaseDir(), `${safeId}.json`);
}

function sessionBaseDir(): string {
  return path.join(os.homedir(), ".acpx", "sessions");
}

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true });
}

function parseHistoryEntries(raw: unknown): SessionHistoryEntry[] | undefined | null {
  if (raw == null) {
    return undefined;
  }

  if (!Array.isArray(raw)) {
    return null;
  }

  const entries: SessionHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return null;
    }

    const role = (item as { role?: unknown }).role;
    const timestamp = (item as { timestamp?: unknown }).timestamp;
    const textPreview = (item as { textPreview?: unknown }).textPreview;

    if (
      (role !== "user" && role !== "assistant") ||
      typeof timestamp !== "string" ||
      typeof textPreview !== "string"
    ) {
      return null;
    }

    entries.push({
      role,
      timestamp,
      textPreview,
    });
  }

  return entries;
}

function parseSessionRecord(raw: unknown): SessionRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Partial<SessionRecord>;
  const name =
    record.name == null
      ? undefined
      : typeof record.name === "string" && record.name.trim().length > 0
        ? record.name.trim()
        : null;
  const pid =
    record.pid == null
      ? undefined
      : Number.isInteger(record.pid) && record.pid > 0
        ? record.pid
        : null;
  const closed =
    record.closed == null
      ? false
      : typeof record.closed === "boolean"
        ? record.closed
        : null;
  const closedAt =
    record.closedAt == null
      ? undefined
      : typeof record.closedAt === "string"
        ? record.closedAt
        : null;
  const agentStartedAt =
    record.agentStartedAt == null
      ? undefined
      : typeof record.agentStartedAt === "string"
        ? record.agentStartedAt
        : null;
  const lastPromptAt =
    record.lastPromptAt == null
      ? undefined
      : typeof record.lastPromptAt === "string"
        ? record.lastPromptAt
        : null;
  const rawLastAgentExitCode = (record as { lastAgentExitCode?: unknown })
    .lastAgentExitCode;
  const lastAgentExitCode =
    rawLastAgentExitCode === undefined
      ? undefined
      : rawLastAgentExitCode === null
        ? null
        : Number.isInteger(rawLastAgentExitCode)
          ? (rawLastAgentExitCode as number)
          : Symbol("invalid");
  const rawLastAgentExitSignal = (record as { lastAgentExitSignal?: unknown })
    .lastAgentExitSignal;
  const lastAgentExitSignal =
    rawLastAgentExitSignal === undefined
      ? undefined
      : rawLastAgentExitSignal === null
        ? null
        : typeof rawLastAgentExitSignal === "string"
          ? rawLastAgentExitSignal
          : Symbol("invalid");
  const lastAgentExitAt =
    record.lastAgentExitAt == null
      ? undefined
      : typeof record.lastAgentExitAt === "string"
        ? record.lastAgentExitAt
        : null;
  const lastAgentDisconnectReason =
    record.lastAgentDisconnectReason == null
      ? undefined
      : typeof record.lastAgentDisconnectReason === "string"
        ? record.lastAgentDisconnectReason
        : null;
  const turnHistory = parseHistoryEntries(
    (record as { turnHistory?: unknown }).turnHistory,
  );

  if (
    typeof record.id !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.agentCommand !== "string" ||
    typeof record.cwd !== "string" ||
    name === null ||
    typeof record.createdAt !== "string" ||
    typeof record.lastUsedAt !== "string" ||
    pid === null ||
    closed === null ||
    closedAt === null ||
    agentStartedAt === null ||
    lastPromptAt === null ||
    typeof lastAgentExitCode === "symbol" ||
    typeof lastAgentExitSignal === "symbol" ||
    lastAgentExitAt === null ||
    lastAgentDisconnectReason === null ||
    turnHistory === null
  ) {
    return null;
  }

  return {
    ...record,
    id: record.id,
    sessionId: record.sessionId,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    closed,
    closedAt,
    pid,
    agentStartedAt,
    lastPromptAt,
    lastAgentExitCode,
    lastAgentExitSignal:
      lastAgentExitSignal == null
        ? lastAgentExitSignal
        : (lastAgentExitSignal as NodeJS.Signals),
    lastAgentExitAt,
    lastAgentDisconnectReason,
    turnHistory,
  };
}

export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await ensureSessionDir();
  const file = sessionFilePath(record.id);
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(record, null, 2);
  await fs.writeFile(tempFile, `${payload}\n`, "utf8");
  await fs.rename(tempFile, file);
}

export async function resolveSessionRecord(sessionId: string): Promise<SessionRecord> {
  await ensureSessionDir();

  const directPath = sessionFilePath(sessionId);
  try {
    const directPayload = await fs.readFile(directPath, "utf8");
    const directRecord = parseSessionRecord(JSON.parse(directPayload));
    if (directRecord) {
      return directRecord;
    }
  } catch {
    // fallback to search
  }

  const sessions = await listSessions();

  const exact = sessions.filter(
    (session) => session.id === sessionId || session.sessionId === sessionId,
  );
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw new Error(`Multiple sessions match id: ${sessionId}`);
  }

  const suffixMatches = sessions.filter(
    (session) =>
      session.id.endsWith(sessionId) || session.sessionId.endsWith(sessionId),
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0];
  }
  if (suffixMatches.length > 1) {
    throw new Error(`Session id is ambiguous: ${sessionId}`);
  }

  throw new Error(`Session not found: ${sessionId}`);
}

function hasGitDirectory(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  try {
    return statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

function isWithinBoundary(boundary: string, target: string): boolean {
  const relative = path.relative(boundary, target);
  return (
    relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function absolutePath(value: string): string {
  return path.resolve(value);
}

export function findGitRepositoryRoot(startDir: string): string | undefined {
  let current = absolutePath(startDir);
  const root = path.parse(current).root;

  for (;;) {
    if (hasGitDirectory(current)) {
      return current;
    }

    if (current === root) {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function normalizeName(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureSessionDir();

  const entries = await fs.readdir(sessionBaseDir(), { withFileTypes: true });
  const records: SessionRecord[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const fullPath = path.join(sessionBaseDir(), entry.name);
    try {
      const payload = await fs.readFile(fullPath, "utf8");
      const parsed = parseSessionRecord(JSON.parse(payload));
      if (parsed) {
        records.push(parsed);
      }
    } catch {
      // ignore corrupt session files
    }
  }

  records.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return records;
}

export async function listSessionsForAgent(
  agentCommand: string,
): Promise<SessionRecord[]> {
  const sessions = await listSessions();
  return sessions.filter((session) => session.agentCommand === agentCommand);
}

export async function findSession(
  options: FindSessionOptions,
): Promise<SessionRecord | undefined> {
  const normalizedCwd = absolutePath(options.cwd);
  const normalizedName = normalizeName(options.name);
  const sessions = await listSessionsForAgent(options.agentCommand);

  return sessions.find((session) => {
    if (session.cwd !== normalizedCwd) {
      return false;
    }

    if (!options.includeClosed && session.closed) {
      return false;
    }

    if (normalizedName == null) {
      return session.name == null;
    }

    return session.name === normalizedName;
  });
}

export async function findSessionByDirectoryWalk(
  options: FindSessionByDirectoryWalkOptions,
): Promise<SessionRecord | undefined> {
  const normalizedName = normalizeName(options.name);
  const normalizedStart = absolutePath(options.cwd);
  const normalizedBoundary = absolutePath(options.boundary ?? normalizedStart);
  const walkBoundary = isWithinBoundary(normalizedBoundary, normalizedStart)
    ? normalizedBoundary
    : normalizedStart;
  const sessions = await listSessionsForAgent(options.agentCommand);

  const matchesScope = (session: SessionRecord, dir: string): boolean => {
    if (session.cwd !== dir) {
      return false;
    }

    if (session.closed) {
      return false;
    }

    if (normalizedName == null) {
      return session.name == null;
    }

    return session.name === normalizedName;
  };

  let dir = normalizedStart;

  for (;;) {
    const match = sessions.find((session) => matchesScope(session, dir));
    if (match) {
      return match;
    }

    if (dir === walkBoundary) {
      return undefined;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
