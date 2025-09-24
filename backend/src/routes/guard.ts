import type { Request, Response } from "express";
import { Router } from "express";
import crypto from "node:crypto";
import { PutCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

import { ddb, TABLE } from "../db.ts";
import { GuardCreate } from "../schema.ts";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  const scan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p)",
    ExpressionAttributeValues: { ":p": "GUARD#" }
  }));
  res.json(scan.Items ?? []);
});

router.post("/", async (req: Request, res: Response) => {
  const parsed = GuardCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const id = crypto.randomUUID();
  const item = {
    pk: `GUARD#${id}`,
    sk: "METADATA",
    type: "Guard",
    name: parsed.data.name,
    dob: parsed.data.dob,
    createdAt: new Date().toISOString()
  };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  res.status(201).json({ id, ...item });
});

router.delete("/:id", async (req: Request, res: Response) => {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: `GUARD#${req.params.id}`, sk: "METADATA" }
  }));
  res.json({ ok: true });
});

export default router;
