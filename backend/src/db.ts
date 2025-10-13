// backend/src/db.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const TABLE =
  process.env.TABLE ||
  process.env.TABLE_NAME ||
  "PoolRotation"; // fallback for local

const REGION = process.env.DDB_REGION || process.env.AWS_REGION || "us-east-2";
console.log(`[DDB] Using region=${REGION}, table=${TABLE}`);

const client = new DynamoDBClient({
  region: REGION,
  endpoint: process.env.DDB_ENDPOINT || undefined, // e.g. http://localhost:8000 for DynamoDB Local
  credentials: process.env.DDB_ENDPOINT
    ? { accessKeyId: "local", secretAccessKey: "local" }
    : undefined,
});

export const ddb = DynamoDBDocumentClient.from(client);
