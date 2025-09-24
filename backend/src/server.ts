import "dotenv/config";
import express from "express";
import cors from "cors";

import guardRoutes from "./routes/guard.ts";
import rotationRoutes from "./routes/rotation.ts";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/guards", guardRoutes);
app.use("/api/rotations", rotationRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API running on http://localhost:${port}`));
