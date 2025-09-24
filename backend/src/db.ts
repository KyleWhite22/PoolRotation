// backend/src/db.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const TABLE = process.env.TABLE_NAME || "PoolRotation";

// Resolve region from envs used by AWS SDK v3
const REGION =
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION ||
  "us-east-2";

console.log(`[DDB] Using region=${REGION}, table=${TABLE}`);

const client = new DynamoDBClient({
  region: REGION,
  // Optional: support DynamoDB Local via env
  endpoint: process.env.DDB_ENDPOINT || undefined,
  credentials: process.env.DDB_ENDPOINT
    ? { accessKeyId: "local", secretAccessKey: "local" }
    : undefined,
});

export const ddb = DynamoDBDocumentClient.from(client);
