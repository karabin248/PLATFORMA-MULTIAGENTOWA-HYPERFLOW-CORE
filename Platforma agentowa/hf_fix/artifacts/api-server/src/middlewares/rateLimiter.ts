import type { Request, Response, NextFunction } from "express";
import { getConfig } from "../lib/config";
import { logger } from "../lib/logger";
import { emitAuditEvent } from "../lib/auditLog";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, RateLimitEntry>();

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

const cleanupTimer = setInterval(cleanExpired, 60_000);
cleanupTimer.unref?.();

function getClientKey(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return ip;
}

function checkLimit(
  key: string,
  windowMs: number,
  maxRequests: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: maxRequests - 1, resetAt };
  }

  entry.count += 1;
  if (entry.count > maxRequests) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  return { allowed: true, remaining: maxRequests - entry.count, resetAt: entry.resetAt };
}

export function rateLimiter(tier: "default" | "run" = "default") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const config = getConfig();
    const clientKey = getClientKey(req);
    const bucketKey = `${tier}:${clientKey}`;

    const maxRequests =
      tier === "run" ? config.rateLimitRunMaxRequests : config.rateLimitMaxRequests;

    const result = checkLimit(bucketKey, config.rateLimitWindowMs, maxRequests);

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, result.remaining));
    res.setHeader("X-RateLimit-Reset", Math.ceil(result.resetAt / 1000));

    if (!result.allowed) {
      logger.warn(
        {
          clientKey,
          tier,
          url: req.url,
          correlationId: req.correlationId,
        },
        "Rate limit exceeded",
      );
      emitAuditEvent({ action: "rate_limit.exceeded", correlationId: req.correlationId, details: { tier, url: req.url, clientKey } });
      res.status(429).json({
        error: "Too many requests",
        code: "RATE_LIMITED",
        retryAfterMs: result.resetAt - Date.now(),
      });
      return;
    }

    next();
  };
}

/**
 * @deprecated M-04 fix: bodyLimitGuard checked only the Content-Length request
 * header, which a client can forge or omit. Body-size enforcement has been moved
 * to express.json({ limit: config.bodyLimitBytes }) in app.ts, which operates
 * at the stream level and cannot be bypassed via header manipulation. This
 * export is retained for backwards compatibility but is no longer mounted in
 * the middleware chain.
 */
export function bodyLimitGuard(req: Request, res: Response, next: NextFunction): void {
  next();
}
