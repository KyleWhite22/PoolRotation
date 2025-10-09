// backend/src/routes/guard.ts
import type { Request, Response } from "express";
import { Router } from "express";
import {
  PutCommand,
  DeleteCommand,
  ScanCommand,
  UpdateCommand,
  type ScanCommandInput,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import crypto from "node:crypto";
import { ddb, TABLE } from "../db.js";
import { GuardCreate, GuardUpdate } from "../schema.js";

const router = Router();

type GuardItem = {
  pk: string;               // "GUARD#<id>"
  sk: "METADATA";
  type: "Guard";
  id?: string;              // convenience mirror (optional)
  name?: string;
  dob?: string | null;
  phone?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type GuardOut = {
  id: string;
  name: string;
  dob: string | null;
  phone: string | null;
};

const norm = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const idFromPk = (pk?: string | null): string | null =>
  typeof pk === "string" && pk.startsWith("GUARD#") ? pk.slice(6) : null;

const toOut = (it: Partial<GuardItem>): GuardOut | null => {
  const id = idFromPk(it.pk ?? null) || (typeof it.id === "string" ? it.id : "");
  if (!id) return null;
  return {
    id,
    name: String(it.name ?? ""),
    dob: (it.dob ?? null) as string | null,
    phone: (it.phone ?? null) as string | null,
  };
};

/** Scan all pages helper (DynamoDB Scan is limited to 1MB per call). */
async function scanAll(params: ScanCommandInput): Promise<any[]> {
  const items: any[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined = undefined;
  do {
    const page: ScanCommandOutput = await ddb.send(
      new ScanCommand({ ...params, ExclusiveStartKey })
    );
    if (page.Items?.length) items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/* ----------------------- LIST (all) ----------------------- */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const items = await scanAll({
      TableName: TABLE,
      FilterExpression: "begins_with(#pk, :p) AND #sk = :sk AND #type = :t",
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#sk": "sk",
        "#type": "type",
        "#name": "name",
        "#dob": "dob",
        "#phone": "phone",
        "#id": "id",
      },
      ExpressionAttributeValues: {
        ":p": "GUARD#",
        ":sk": "METADATA",
        ":t": "Guard",
      },
      ProjectionExpression: "#pk, #sk, #type, #id, #name, #dob, #phone",
      ConsistentRead: true,
    });

    const guards = items.map(toOut).filter(Boolean) as GuardOut[];
    res.set("Cache-Control", "no-store");
    res.json(guards);
  } catch (err) {
    console.error("GET /api/guards error:", err);
    res.status(500).json({ error: "Failed to list guards" });
  }
});

/* -------- OPTIONAL: name/id maps for canonicalization ------- */
router.get("/map", async (_req: Request, res: Response) => {
  try {
    const items = await scanAll({
      TableName: TABLE,
      FilterExpression: "begins_with(#pk, :p) AND #sk = :sk AND #type = :t",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#type": "type", "#name": "name", "#id": "id" },
      ExpressionAttributeValues: { ":p": "GUARD#", ":sk": "METADATA", ":t": "Guard" },
      ProjectionExpression: "#pk, #sk, #type, #id, #name",
      ConsistentRead: true,
    });

    const idToName: Record<string, string> = {};
    const nameToId: Record<string, string> = {};
    for (const it of items) {
      const id = idFromPk(it.pk) || it.id;
      if (!id) continue;
      const name = String(it.name ?? "");
      idToName[id] = name;
      if (name) nameToId[norm(name)] = id;
    }
    res.set("Cache-Control", "no-store");
    res.json({ idToName, nameToId });
  } catch (err) {
    console.error("GET /api/guards/map error:", err);
    res.status(500).json({ error: "Failed to build map" });
  }
});

/* ----------------------- CREATE ----------------------- */
router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = GuardCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const id = crypto.randomUUID(); // canonical identity
    const item: GuardItem = {
      pk: `GUARD#${id}`,
      sk: "METADATA",
      type: "Guard",
      id, // mirror for convenience
      name: parsed.data.name.trim(),
      dob: parsed.data.dob ?? null,
      phone: parsed.data.phone ?? null,
      createdAt: new Date().toISOString(),
    };

    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)", // no silent overwrite
      })
    );

    res.status(201).json(toOut(item));
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(409).json({ error: "guard id already exists" });
    }
    console.error("POST /api/guards error:", err);
    res.status(500).json({ error: "Failed to create guard", detail: err?.message || String(err) });
  }
});

/* ----------------------- READ (single) ----------------------- */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id.trim();
    const items = await scanAll({
      TableName: TABLE,
      FilterExpression: "#pk = :pk AND #sk = :sk AND #type = :t",
      ExpressionAttributeNames: {
        "#pk": "pk",
        "#sk": "sk",
        "#type": "type",
        "#name": "name",
        "#dob": "dob",
        "#phone": "phone",
        "#id": "id",
      },
      ExpressionAttributeValues: {
        ":pk": `GUARD#${id}`,
        ":sk": "METADATA",
        ":t": "Guard",
      },
      ProjectionExpression: "#pk, #sk, #type, #id, #name, #dob, #phone",
      ConsistentRead: true,
    });

    const out = items.map(toOut).find(Boolean);
    if (!out) return res.status(404).json({ error: "Guard not found" });
    res.set("Cache-Control", "no-store");
    res.json(out);
  } catch (err) {
    console.error("GET /api/guards/:id error:", err);
    res.status(500).json({ error: "Failed to read guard" });
  }
});

/* ----------------------- UPDATE ----------------------- */
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id.trim();
    const parsed = GuardUpdate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const { name, dob, phone } = parsed.data;

    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, any> = {};

    const setAttr = (attr: string, val: any) => {
      const n = `#${attr}`;
      const v = `:${attr}`;
      names[n] = attr;
      values[v] = val;
      sets.push(`${n} = ${v}`);
    };
    const removeAttr = (attr: string) => {
      const n = `#${attr}`;
      names[n] = attr;
      removes.push(n);
    };

    if (typeof name !== "undefined") setAttr("name", String(name).trim());
    if (typeof dob !== "undefined") (dob === null ? removeAttr("dob") : setAttr("dob", dob));
    if (typeof phone !== "undefined") (phone === null ? removeAttr("phone") : setAttr("phone", phone));
    setAttr("updatedAt", new Date().toISOString());

    if (!sets.length && !removes.length) {
      return res.status(400).json({ error: "No changes provided" });
    }

    const UpdateExpression =
      (sets.length ? "SET " + sets.join(", ") : "") +
      (removes.length ? (sets.length ? " " : "") + "REMOVE " + removes.join(", ") : "");

    const result = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `GUARD#${id}`, sk: "METADATA" },
        UpdateExpression,
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
        ConditionExpression: "attribute_exists(pk)",
        ReturnValues: "ALL_NEW",
      })
    );

    const out = toOut(result.Attributes as GuardItem);
    if (!out) return res.status(500).json({ error: "Corrupt guard row" });
    res.json(out);
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(404).json({ error: "Guard not found" });
    }
    console.error("PUT /api/guards/:id error:", err);
    res.status(500).json({ error: "Failed to update guard" });
  }
});

/* ----------------------- DELETE ----------------------- */
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { pk: `GUARD#${req.params.id.trim()}`, sk: "METADATA" },
        ConditionExpression: "attribute_exists(pk)",
      })
    );
    res.json({ ok: true });
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(404).json({ error: "Guard not found" });
    }
    console.error("DELETE /api/guards/:id error:", err);
    res.status(500).json({ error: "Failed to delete guard" });
  }
});

export default router;
