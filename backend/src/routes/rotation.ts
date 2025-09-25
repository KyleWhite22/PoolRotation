//backend/src/routes/rotation.ts
import { Router } from "express";
import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";
import { RotationSlot } from "../schema.js";

const router = Router();

router.get("/day/:date", async (req, res) => {
  const date = req.params.date;
const q = await ddb.send(new QueryCommand({
  TableName: TABLE,
  KeyConditionExpression: "pk = :pk",
  ExpressionAttributeValues: { ":pk": `ROTATION#${date}` },
  ConsistentRead: true,
}));
 
const slots = (q.Items ?? []).filter(it => it.type === "RotationSlot");

// latest group by updatedAt
let latestTickISO: string | null = null;
for (const it of slots) {
  const u = String(it.updatedAt ?? "");
  if (u && (!latestTickISO || u > latestTickISO)) latestTickISO = u;
}

const rows = (latestTickISO ? slots.filter(it => String(it.updatedAt ?? "") === latestTickISO) : slots)
  .map(it => ({
    stationId: it.stationId,
    guardId: (typeof it.guardId === "string" && it.guardId.startsWith("GUARD#"))
      ? it.guardId.slice(6)
      : it.guardId ?? null,
    time: it.time,
    updatedAt: it.updatedAt,
  }));

res.json(rows);
});

router.post("/slot", async (req, res) => {
  const { date, time, stationId } = req.body;
  let { guardId } = req.body;
  if (!date || !time || !stationId) return res.status(400).json({ error: "date,time,stationId required" });

  // normalize: store plain UUIDs (no "GUARD#" prefix)
  if (typeof guardId === "string" && guardId.startsWith("GUARD#")) {
    guardId = guardId.slice("GUARD#".length);
  }

  const nowISO = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: `ROTATION#${date}`,
      sk: `SLOT#${time}#${stationId}`,
      type: "RotationSlot",
      stationId, guardId: guardId ?? null, time, date,
      notes: req.body?.notes ?? "",
      updatedAt: nowISO,
    },
  }));

  res.json({ ok: true });
});

export default router;
