// src/handlers/app.ts
import serverless from "serverless-http";
import { createApp } from "../app";

const app = createApp();

// Export the Lambda handler expected by serverless.yml
export const handler = serverless(app, {
  requestId: "x-request-id", // optional
});
