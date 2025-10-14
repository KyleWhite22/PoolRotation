// src/rotation/store.ts
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { rotationKey } from "./rotationKey";

export type Assigned = Record<string, string | null>;
export type QueueEntry = { guardId: string; returnTo: string; enteredTick: number };
export type RotationState = {
  assigned: Assigned;
  queue: QueueEntry[];
  breaks?: Record<string, string>;
  conflicts?: Array<{ stationId: string; guardId: string; reason: string }>;
  rev: number;
  tick: number;
  updatedAt?: Record<string, string>; // per seat (ISO)
  ttl?: number; // ONLY on sandbox items
};

export async function getState(
  ddb: DynamoDBDocumentClient,
  table: string,
  date: string,
  instanceId?: string
): Promise<RotationState> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: table,
    Key: rotationKey(date, instanceId),
    ConsistentRead: true,
  }));
  return (Item as RotationState) ?? {
    assigned: {},
    queue: [],
    rev: 0,
    tick: 0,
    updatedAt: {},
  };
}

export async function putState(
  ddb: DynamoDBDocumentClient,
  table: string,
  date: string,
  instanceId: string | undefined,
  next: RotationState,
  opts?: { ttlSeconds?: number; expectedRev?: number | null } // set expectedRev to enable optimistic write
) {
  const ttl = instanceId && opts?.ttlSeconds
    ? Math.floor(Date.now() / 1000) + opts.ttlSeconds
    : undefined;

  const names: Record<string, string> = {
    "#assigned": "assigned",
    "#queue": "queue",
    "#breaks": "breaks",
    "#conflicts": "conflicts",
    "#rev": "rev",
    "#tick": "tick",
    "#updatedAt": "updatedAt",
  };
  if (ttl) names["#ttl"] = "ttl";

  const expr = [
    "SET #assigned = :a",
    "#queue = :q",
    "#breaks = :b",
    "#conflicts = :c",
    "#rev = :r",
    "#tick = :t",
    "#updatedAt = :u",
    ...(ttl ? ["#ttl = :ttl"] : []),
  ].join(", ");

  const values: Record<string, any> = {
    ":a": next.assigned ?? {},
    ":q": next.queue ?? [],
    ":b": next.breaks ?? {},
    ":c": next.conflicts ?? [],
    ":r": typeof next.rev === "number" ? next.rev : 0,
    ":t": typeof next.tick === "number" ? next.tick : 0,
    ":u": next.updatedAt ?? {},
  };
  if (ttl) values[":ttl"] = ttl;

  const params: any = {
    TableName: table,
    Key: rotationKey(date, instanceId),
    UpdateExpression: expr,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  };

  if (opts?.expectedRev != null) {
    params.ConditionExpression = "#rev = :expected";
    params.ExpressionAttributeValues[":expected"] = opts.expectedRev;
  }

  const out = await ddb.send(new UpdateCommand(params));
  return out.Attributes as RotationState;
}
