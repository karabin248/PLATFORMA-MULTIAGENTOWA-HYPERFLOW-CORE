import { logger } from "./logger";

export type AuditAction =
  | "agent.created"
  | "agent.updated"
  | "agent.disabled"
  | "agent.enabled"
  | "agent.seeded"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.retried"
  | "run.cancelled"
  | "auth.failed"
  | "auth.denied"
  | "rate_limit.exceeded";

export interface AuditEvent {
  action: AuditAction;
  timestamp: string;
  correlationId?: string;
  actor?: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
}

const auditLogger = logger.child({ component: "audit" });

// ---------------------------------------------------------------------------
// Dedupe / coalescing for noisy actions (O-1)
//
// auth.failed / auth.denied / rate_limit.exceeded can be triggered hundreds
// of times per minute by misconfigured clients (e.g. an operator panel
// polling without a token). Emitting one log line per occurrence drowns
// genuine security signal. We coalesce identical events within a short
// window and emit a single summary line per window.
// ---------------------------------------------------------------------------

const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_ACTIONS: ReadonlySet<AuditAction> = new Set([
  "auth.failed",
  "auth.denied",
  "rate_limit.exceeded",
]);

interface DedupeEntry {
  count: number;
  firstAt: number;
  lastEvent: AuditEvent;
  timer: NodeJS.Timeout;
}

const _dedupeMap = new Map<string, DedupeEntry>();

function dedupeKey(event: AuditEvent): string {
  const d = event.details ?? {};
  const reason = (d as Record<string, unknown>).reason ?? "";
  const url = (d as Record<string, unknown>).url ?? "";
  const method = (d as Record<string, unknown>).method ?? "";
  return `${event.action}|${String(reason)}|${String(method)}|${String(url)}`;
}

function flushDedupeEntry(key: string): void {
  const entry = _dedupeMap.get(key);
  if (!entry) return;
  _dedupeMap.delete(key);
  if (entry.count <= 1) return; // first event already emitted normally
  auditLogger.info(
    {
      ...entry.lastEvent,
      suppressedCount: entry.count - 1,
      windowStartedAt: new Date(entry.firstAt).toISOString(),
    },
    `audit: ${entry.lastEvent.action} (coalesced ${entry.count - 1} duplicates over ${DEDUPE_WINDOW_MS}ms)`,
  );
}

export function emitAuditEvent(event: Omit<AuditEvent, "timestamp">): void {
  const fullEvent: AuditEvent = {
    ...event,
    timestamp: new Date().toISOString(),
  };

  if (DEDUPE_ACTIONS.has(event.action)) {
    const key = dedupeKey(fullEvent);
    const existing = _dedupeMap.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastEvent = fullEvent;
      return; // suppress; flush will summarise on window expiry
    }
    const timer = setTimeout(() => flushDedupeEntry(key), DEDUPE_WINDOW_MS);
    if (typeof timer.unref === "function") timer.unref();
    _dedupeMap.set(key, {
      count: 1,
      firstAt: Date.now(),
      lastEvent: fullEvent,
      timer,
    });
    // first occurrence is logged normally below
  }

  auditLogger.info(fullEvent, `audit: ${event.action}`);
}

// Test helper: drain pending dedupe windows synchronously.
export function _flushAuditDedupeForTests(): void {
  for (const [key, entry] of _dedupeMap.entries()) {
    clearTimeout(entry.timer);
    flushDedupeEntry(key);
  }
}
