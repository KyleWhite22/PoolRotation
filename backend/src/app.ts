// src/app.ts
import "dotenv/config";
import express from "express";
import cors from "cors";

const load = (m: any) => m?.default ?? m;

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: [
        "https://app.hilliardguardmanager.com",
        "http://localhost:5173",
        "http://localhost:5174",
      ],
      credentials: true,
    })
  );
  app.use(express.json({ limit: "1mb" }));

  // probes
  app.get("/", (_req, res) =>
    res.json({ ok: true, service: "hgm-backend", time: new Date().toISOString() })
  );
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // route index (handy in prod)
  app.get("/__routes", (_req, res) => {
    // @ts-ignore
    const stack = (app._router?.stack || [])
      .map((l: any) =>
        l?.route
          ? { path: l.route.path, methods: Object.keys(l.route.methods || {}) }
          : null
      )
      .filter(Boolean);
    res.json(stack);
  });

  // routers — make /api/rotate exist
  try {
    const guard = load(require("./routes/guard"));
    const rotation = load(require("./routes/rotation"));
    const plan = load(require("./routes/plan"));
    const dev = load(require("./routes/dev"));

    app.use("/api/guards", guard);
    app.use("/api/rotations", rotation);
    app.use("/api", plan); // <-- /api/rotate, /api/queue, /api/_ping
    app.use("/api", dev);  // /api/diag, /api/fix-ids, etc.
  } catch (e: any) {
    console.error("[bootstrap.routes] failed to load routes:", e?.stack || e);
  }

  // global error
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error("Express error:", err);
    res.status(500).json({ error: String(err?.message ?? err) });
  });

  return app;
}
