// src/middleware/sandbox.ts
import type { Request, Response, NextFunction } from "express";

export function sandboxResolver(req: Request, _res: Response, next: NextFunction) {
  const raw = String(req.header("X-Rotation-Instance") || "");
  (req as any).sandboxInstanceId =
    /^[A-Za-z0-9-]{8,}$/.test(raw) ? raw : undefined;
  next();
}
