import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

const MAX_CORRELATION_ID_LENGTH = 128;
const CORRELATION_ID_PATTERN = /^[\w\-.]+$/;

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  let correlationId =
    (req.headers["x-correlation-id"] as string) ||
    (req.headers["x-request-id"] as string) ||
    "";

  if (
    !correlationId ||
    correlationId.length > MAX_CORRELATION_ID_LENGTH ||
    !CORRELATION_ID_PATTERN.test(correlationId)
  ) {
    correlationId = randomUUID();
  }

  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);

  next();
}
