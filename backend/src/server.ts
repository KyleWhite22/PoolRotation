// server.ts
import "dotenv/config";
import express from "express";
import cors from "cors";

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

  // Simple probes
  app.get("/", (_req, res) =>
    res.json({ ok: true, service: "hgm-backend", time: new Date().toISOString() })
  );
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Debug: list mounted routes (only top-level paths)
// put this inside createApp(), after /health and before the error handler
app.get("/__routes", (_req, res) => {
  type Layer = any;

  const getRoutes = (stack: Layer[], prefix = ""): Array<{ path: string; methods: string[] }> => {
    const out: Array<{ path: string; methods: string[] }> = [];
    for (const layer of stack) {
      // Direct route on the app (has .route)
      if (layer.route) {
        const methods = Object.keys(layer.route.methods || {});
        out.push({ path: prefix + layer.route.path, methods });
        continue;
      }
      // Mounted router (has .handle.stack)
      if (layer.name === "router" && layer.handle?.stack) {
        // Extract the mount path segment if present
        let mount = "";
        if (layer.regexp && layer.regexp.fast_star) {
          mount = "*";
        } else if (layer.regexp && layer.regexp.fast_slash) {
          mount = "/";
        } else if (Array.isArray(layer.keys) && layer.keys.length) {
          // parametric mount (e.g., /api/:v)
          mount = "/" + layer.keys.map((k: any) => (k?.name ? `:${k.name}` : "")).join("/");
        } else if (typeof layer?.regexp?.toString === "function") {
          // best-effort stringify for static mounts
          const m = layer.regexp.toString().match(/\\\/([^\\^$?()]*)\\\//);
          if (m && m[1]) mount = "/" + m[1];
        }
        out.push(...getRoutes(layer.handle.stack, prefix + mount));
      }
    }
    return out;
  };

  // @ts-ignore
  const stack = app._router?.stack || [];
  const routes = getRoutes(stack).map(r => ({
    path: r.path.replace(/\/+/g, "/"),
    methods: r.methods.sort(),
  }));
  res.json(routes);
});


  // Lazy-load routers so a bad import won't kill the whole Lambda
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const guardMod = require("./routes/guard");
    console.log("[bootstrap] guard loaded keys:", Object.keys(guardMod));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rotationMod = require("./routes/rotation");
    console.log("[bootstrap] rotation loaded keys:", Object.keys(rotationMod));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const planMod = require("./routes/plan");
    console.log("[bootstrap] plan loaded keys:", Object.keys(planMod));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const devMod = require("./routes/dev");
    console.log("[bootstrap] dev loaded keys:", Object.keys(devMod));

    const guardRoutes = guardMod.default ?? guardMod;
    const rotationRoutes = rotationMod.default ?? rotationMod;
    const planRoutes = planMod.default ?? planMod;
    const devRouter = devMod.default ?? devMod;

console.log("[bootstrap] mounting routers...");
app.use("/api/guards", guardRoutes);
app.use("/api/rotations", rotationRoutes);
app.use("/api/plan", planRoutes);
app.use("/api/dev", devRouter);
console.log("[bootstrap] routers mounted");

    console.log("[bootstrap] routers mounted");
  } catch (err: any) {
    console.error("[bootstrap.routes] failed to load routes:", err?.stack || err);
  }

  // Global error handler (keeps JSON errors consistent)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Express error:", err);
    res.status(500).json({ error: String(err?.message ?? err) });
  });

  return app;
}

if (process.env.RUN_AS_SERVER === "1") {
  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`->API running on http://localhost:${port}`));
}
