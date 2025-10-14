import "dotenv/config";
import express from "express";
import cors, { CorsOptions } from "cors";
import fs from "node:fs";
import path from "node:path";
import { sandboxResolver } from "./middleware/sandbox";

// ---- createApp ----
export function createApp() {
  const app = express();

  // CORS
  const ALLOW_ORIGINS = [
    "https://app.hilliardguardmanager.com",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:3000",
  ];
  const ALLOW_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"];
const ALLOW_HEADERS = [
  "Content-Type",
  "x-api-key",
  "x-rotation-instance",
  "cache-control",        // ← add this
  "pragma",               // (optional, sometimes present with cache busting)
  "accept",               // (safe/common)
  "origin",               // (safe/common)
  "x-requested-with"      // (safe/common)
];
  const corsOptions: CorsOptions = {
    origin: (origin, cb) => {
      if (!origin || ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    },
    methods: ALLOW_METHODS,
    allowedHeaders: ALLOW_HEADERS,
    credentials: false,
    optionsSuccessStatus: 204,
  };

  app.use((_, res, next) => { res.setHeader("Vary", "Origin"); next(); });
  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));

  app.use(express.json({ limit: "1mb" }));
  app.use(sandboxResolver);

  // Probes
  app.get("/", (_req, res) => res.json({ ok: true, service: "hgm-backend", time: new Date().toISOString() }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/__version", (_req, res) => res.json({ build: process.env.BUILD_ID || "dev", ts: new Date().toISOString() }));

  // Diag: list mounted routes
  app.get("/__routes", (_req, res) => {
    type Layer = any;
    const getRoutes = (stack: Layer[], prefix = ""): Array<{ path: string; methods: string[] }> => {
      const out: Array<{ path: string; methods: string[] }> = [];
      for (const layer of stack) {
        if (layer.route) {
          out.push({ path: prefix + layer.route.path, methods: Object.keys(layer.route.methods || {}) });
        } else if (layer.name === "router" && layer.handle?.stack) {
          let mount = "";
          if (layer.regexp?.fast_star) mount = "*";
          else if (layer.regexp?.fast_slash) mount = "/";
          else if (Array.isArray(layer.keys) && layer.keys.length) {
            mount = "/" + layer.keys.map((k: any) => (k?.name ? `:${k.name}` : "")).join("/");
          } else if (typeof layer?.regexp?.toString === "function") {
            const m = layer.regexp.toString().match(/\\\/([^\\^$?()]*)\\\//);
            if (m && m[1]) mount = "/" + m[1];
          }
          out.push(...getRoutes(layer.handle.stack, prefix + mount));
        }
      }
      return out;
    };
    // @ts-ignore
    const stack = (app as any)._router?.stack || [];
    const routes = getRoutes(stack).map(r => ({ path: r.path.replace(/\/+/g, "/"), methods: r.methods.sort() }));
    res.json(routes);
  });

  // Diag: show dist layout so we know the files are there in Lambda
  app.get("/__diag", (_req, res) => {
    const base = __dirname;
    const routesDir = path.join(base, "routes");
    let files: string[] = [];
    try { files = fs.readdirSync(routesDir).sort(); } catch {}
    res.json({ __dirname: base, routesDir, files });
  });

  // Mount compiled routers from dist/routes/*.js
  try {
    // IMPORTANT: these are runtime *dist* paths (keep the .js extensions)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const guardMod    = require("./routes/guard.js");
const rotationMod = require("./routes/rotation.js");
const planMod     = require("./routes/plan.js");
const devMod      = require("./routes/dev.js");

const guardRoutes    = guardMod.default ?? guardMod;
const rotationRoutes = rotationMod.default ?? rotationMod;
const planRoutes     = planMod.default ?? planMod;
const devRoutes      = devMod.default ?? devMod;

app.use("/api/guards", guardRoutes);
app.use("/api/rotations", rotationRoutes);
app.use("/api/plan",     planRoutes);
app.use("/api/dev",      devRoutes);
    console.log("[bootstrap] routers mounted");
  } catch (err) {
    console.error("[bootstrap] FAILED to mount routers:", err);
  }

  // Errors
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Express error:", err);
    const origin = req.headers.origin as string | undefined;
    if (origin && ALLOW_ORIGINS.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", ALLOW_HEADERS.join(","));
      res.setHeader("Access-Control-Allow-Methods", ALLOW_METHODS.join(","));
      res.setHeader("Vary", "Origin");
    }
    res.status(500).json({ error: String(err?.message ?? err) });
  });

  return app;
}

// Local dev
if (process.env.RUN_AS_SERVER === "1") {
  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`->API running on http://localhost:${port}`));
}
