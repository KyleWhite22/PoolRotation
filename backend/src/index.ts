// backend/src/index.ts
import "dotenv/config";
import express from "express";
import cors from "cors";

import guardRoutes from "./routes/guard.js";
import rotationRoutes from "./routes/rotation.js";
import planRoutes from "./routes/plan.js";
import devRouter from "./routes/dev.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/guards", guardRoutes);
app.use("/api/rotations", rotationRoutes);
app.use("/api/plan", planRoutes);
app.use("/api/dev", devRouter);

const port = process.env.PORT || 3000;
app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(port, () => console.log(`API running on http://localhost:${port}`));
