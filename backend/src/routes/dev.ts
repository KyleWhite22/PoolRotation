/* eslint-disable no-console */
import { Router } from "express";
import {
  ScanCommand,
  PutCommand,
  UpdateCommand,
  type ScanCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../db.js";

const router = Router();

// ---------- helpers ----------
const norm = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const stripId = (v: any) =>
  typeof v === "string" && v.startsWith("GUARD#") ? v.slice(6) : String(v || "");

async function scanAll(params: ScanCommandInput) {
  const items: any[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    if (page.Items?.length) items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function loadGuardMaps() {
  const guards = await scanAll({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p) AND #sk = :sk AND #type = :t",
    ExpressionAttributeValues: { ":p": "GUARD#", ":sk": "METADATA", ":t": "Guard" },
    ExpressionAttributeNames: {
      "#sk": "sk",
      "#type": "type",
      "#name": "name",
    },
    // 👇 Fixed bad alias here; Dynamo requires all #names defined
    ProjectionExpression: "pk, #sk, #type, #name, dob",
    ConsistentRead: true,
  });

  const rows = guards.map((it: any) => ({
    id: typeof it.pk === "string" ? it.pk.replace(/^GUARD#/, "") : it.id,
    name: String(it.name ?? ""),
    dob: it.dob ?? null,
  }));
  const knownIds = new Set(rows.map((g: any) => g.id));
  const byName = new Map<string, string>();
  for (const g of rows) byName.set(norm(g.name || g.id), g.id);
  return { rows, knownIds, byName };
}

function toCanonicalId(raw: any, knownIds: Set<string>, byName: Map<string, string>) {
  if (raw == null) return null;
  const s = stripId(raw).trim();
  if (!s) return null;
  if (knownIds.has(s)) return s;
  const m = byName.get(norm(s));
  return m && knownIds.has(m) ? m : null;
}

// ---------- DIAG: quick snapshot ----------
router.get("/diag", async (req, res) => {
  try {
    const { rows, knownIds, byName } = await loadGuardMaps();
    const date = (req.query?.date as string) || "";

    const out: any = { rosterCount: rows.length, unknownQueue: 0, unknownSlots: 0, samples: [] };

    // Check queues
    const queues = await scanAll({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p) AND #sk = :q",
      ExpressionAttributeValues: { ":p": date ? `ROTATION#${date}` : "ROTATION#", ":q": "QUEUE" },
      ExpressionAttributeNames: { "#sk": "sk" },
      ConsistentRead: true,
    });

    for (const q of queues) {
      for (const row of q.queue ?? []) {
        const canon = toCanonicalId(row.guardId, knownIds, byName);
        if (!canon) {
          out.unknownQueue++;
          if (out.samples.length < 10) out.samples.push({ kind: "queue", pk: q.pk, bad: row.guardId });
        }
      }
    }

    // Check slots
    const frames = await scanAll({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p) AND begins_with(#sk, :slot)",
      ExpressionAttributeValues: { ":p": date ? `ROTATION#${date}` : "ROTATION#", ":slot": "SLOT#" },
      ExpressionAttributeNames: { "#sk": "sk" },
      ConsistentRead: true,
    });

    for (const it of frames) {
      const g = toCanonicalId(it.guardId, knownIds, byName);
      if (it.guardId != null && !g) {
        out.unknownSlots++;
        if (out.samples.length < 10) out.samples.push({ kind: "slot", pk: it.pk, sk: it.sk, bad: it.guardId });
      }
    }

    res.json(out);
  } catch (err: any) {
    console.error("[/api/dev/diag] failed:", err);
    res.status(500).json({ error: "diag failed", detail: err?.message || String(err) });
  }
});

// ---------- FIX: convert names → ids in queues & slots ----------
router.post("/fix-ids", async (req, res) => {
  try {
    const apply = String(req.query.apply || "0") === "1";
    const date = (req.query?.date as string) || "";
    const { knownIds, byName } = await loadGuardMaps();

    let examined = 0,
      changed = 0;
    const changes: any[] = [];

    // Fix QUEUE rows
    const queues = await scanAll({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p) AND #sk = :q",
      ExpressionAttributeValues: { ":p": date ? `ROTATION#${date}` : "ROTATION#", ":q": "QUEUE" },
      ExpressionAttributeNames: { "#sk": "sk" },
      ConsistentRead: true,
    });

    for (const q of queues) {
      examined++;
      const current: any[] = Array.isArray(q.queue) ? q.queue : [];
      let dirty = false;
      const next = current.map((row) => {
        const canon = toCanonicalId(row.guardId, knownIds, byName);
        if (canon && canon !== stripId(row.guardId)) {
          dirty = true;
          changed++;
          changes.push({ kind: "queue", pk: q.pk, from: row.guardId, to: canon });
          return { ...row, guardId: canon };
        }
        return row;
      });
      if (dirty && apply) {
        await ddb.send(
          new PutCommand({
            TableName: TABLE,
            Item: { ...q, queue: next, updatedAt: new Date().toISOString() },
          })
        );
      }
    }

    // Fix RotationSlot.guardId
    const frames = await scanAll({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p) AND begins_with(#sk, :slot)",
      ExpressionAttributeValues: { ":p": date ? `ROTATION#${date}` : "ROTATION#", ":slot": "SLOT#" },
      ExpressionAttributeNames: { "#sk": "sk" },
      ConsistentRead: true,
    });

    for (const it of frames) {
      examined++;
      const canon = toCanonicalId(it.guardId, knownIds, byName);
      if (it.guardId != null && canon && canon !== stripId(it.guardId)) {
        changed++;
        changes.push({ kind: "slot", pk: it.pk, sk: it.sk, from: it.guardId, to: canon });
        if (apply) {
          await ddb.send(
            new UpdateCommand({
              TableName: TABLE,
              Key: { pk: it.pk, sk: it.sk },
              UpdateExpression: "SET guardId = :g, updatedAt = :u",
              ExpressionAttributeValues: { ":g": canon, ":u": new Date().toISOString() },
              ConditionExpression: "attribute_exists(pk)",
            })
          );
        }
      }
    }

    res.json({ examined, changed, applied: apply, samples: changes.slice(0, 20) });
  } catch (err: any) {
    console.error("[/api/dev/fix-ids] failed:", err);
    res.status(500).json({ error: "fix-ids failed", detail: err?.message || String(err) });
  }
});
router.post("/purge-unknown", async (req, res) => {
  try {
    const date = String(req.query?.date || "");
    if (!date) return res.status(400).json({ error: "date required (YYYY-MM-DD)" });

    const { knownIds, byName } = await loadGuardMaps();
    const toCanon = (v:any) => toCanonicalId(v, knownIds, byName);

    let queuesTouched = 0, queueRemoved = 0;
    let slotsTouched  = 0, slotsCleared = 0;

    // 1) Fix queue for this date
    const qItems = await scanAll({
      TableName: TABLE,
      FilterExpression: "pk = :pk AND #sk = :q",
      ExpressionAttributeValues: { ":pk": `ROTATION#${date}`, ":q": "QUEUE" },
      ExpressionAttributeNames: { "#sk": "sk" },
      ConsistentRead: true,
    });

    for (const q of qItems) {
      const cur = Array.isArray(q.queue) ? q.queue : [];
      const next = [];
      for (const row of cur) {
        const canon = toCanon(row.guardId);
        if (canon) next.push({ ...row, guardId: canon });
        else queueRemoved++;
      }
      if (next.length !== cur.length) {
        queuesTouched++;
        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: { ...q, queue: next, updatedAt: new Date().toISOString() },
        }));
      }
    }

    // 2) Clear seat frames for this date
    const frames = await scanAll({
      TableName: TABLE,
      FilterExpression: "pk = :pk AND begins_with(#sk, :slot)",
      ExpressionAttributeValues: { ":pk": `ROTATION#${date}`, ":slot": "SLOT#" },
      ExpressionAttributeNames: { "#sk": "sk" },
      ConsistentRead: true,
    });

    for (const it of frames) {
      if (it.guardId == null) continue;
      const canon = toCanon(it.guardId);
      if (!canon) {
        slotsCleared++;
        slotsTouched++;
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { pk: it.pk, sk: it.sk },
          UpdateExpression: "SET guardId = :g, updatedAt = :u",
          ExpressionAttributeValues: { ":g": null, ":u": new Date().toISOString() },
        }));
      }
    }

    res.json({ date, queuesTouched, queueRemoved, slotsTouched, slotsCleared });
  } catch (err:any) {
    console.error("[/api/dev/purge-unknown] failed:", err);
    res.status(500).json({ error: "purge-unknown failed", detail: err?.message || String(err) });
  }
});

export default router;
