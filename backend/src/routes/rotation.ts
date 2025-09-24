import { Router } from "express";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

import { ddb, TABLE } from "../db.ts";
import { RotationSlot } from "../schema.ts";

const router = Router();

router.get("/day/:date", async (req, res) => {
  const date = req.params.date;
  const data = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "pk = :pk",
    ExpressionAttributeValues: { ":pk": `ROTATION#${date}` }
  }));
  res.json(data.Items ?? []);
});

router.post("/slot", async (req, res) => {
  const parsed = RotationSlot.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());
  const { date, time, stationId, guardId, notes } = parsed.data;

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `ROTATION#${date}`,
      sk: `SLOT#${time}#${stationId}`,
      type: "RotationSlot",
      stationId, guardId, time, date, notes,
      gsi1pk: `GUARD#${guardId}`,
      gsi1sk: `${date}T${time}`,
      updatedAt: new Date().toISOString()
    }
  }));

  res.json({ ok: true });
});

export default router;
