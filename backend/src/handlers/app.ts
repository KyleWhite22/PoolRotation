// src/handlers/app.ts
import serverless from "serverless-http";
import { createApp } from "../server";   // ⬅️ change this import

const app = createApp();

export const handler = serverless(app);  // no special options needed
