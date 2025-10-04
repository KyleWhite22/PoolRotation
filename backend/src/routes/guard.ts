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

// ------- list guards -------
router.get("/", async (_req: Request, res: Response) => {
  try {
    // Only METADATA rows of type Guard; ignore any other rows with the same pk
    const items = await scanAll({
      TableName: TABLE,
      FilterExpression:
        "begins_with(pk, :p) AND #sk = :sk AND #type = :t",
      ExpressionAttributeValues: {
        ":p": "GUARD#",
        ":sk": "METADATA",
        ":t": "Guard",
      },
      ExpressionAttributeNames: {
        "#sk": "sk",
        "#type": "type",
        "#pk": "pk",
        "#name": "name",
        "#dob": "dob",
        "#phone": "phone",
      },
      ProjectionExpression: "#pk, #sk, #type, #name, #dob, #phone",
      ConsistentRead: true,
    });

    const guards = items
      .map((it: any) => ({
        id:
          typeof it.pk === "string" && it.pk.startsWith("GUARD#")
            ? it.pk.slice(6)
            : String(it.id ?? ""),
        name: String(it.name ?? ""),
        dob: it.dob ?? null,
        phone: it.phone ?? null,
      }))
      .filter((g) => g.id);

    res.set("Cache-Control", "no-store");
    res.json(guards);
  } catch (err) {
    console.error("GET /api/guards error:", err);
    res.status(500).json({ error: "Failed to list guards" });
  }
});

// ------- create guard -------
router.post("/", async (req: Request, res: Response) => {
  try {
    const parsed = GuardCreate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const id = crypto.randomUUID();
    const item = {
      pk: `GUARD#${id}`,
      sk: "METADATA",
      type: "Guard",
      id, // convenience mirror
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

    res.status(201).json({ id, name: item.name, dob: item.dob, phone: item.phone });
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(409).json({ error: "guard id already exists" });
    }
    console.error("POST /api/guards error:", err);
    res
      .status(500)
      .json({ error: "Failed to create guard", detail: err?.message || String(err) });
  }
});

// ------- update guard -------
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
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

    if (typeof name !== "undefined") setAttr("name", name);
    if (typeof dob !== "undefined") {
      if (dob === null) removeAttr("dob");
      else setAttr("dob", dob);
    }
    if (typeof phone !== "undefined") {
      if (phone === null) removeAttr("phone");
      else setAttr("phone", phone);
    }

    if (sets.length === 0 && removes.length === 0) {
      return res.status(400).json({ error: "No changes provided" });
    }

    const parts = [];
    if (sets.length) parts.push("SET " + sets.join(", "));
    if (removes.length) parts.push("REMOVE " + removes.join(", "));
    const UpdateExpression = parts.join(" ");

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

    res.json({ id, ...result.Attributes });
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(404).json({ error: "Guard not found" });
    }
    console.error("PUT /api/guards/:id error:", err);
    res.status(500).json({ error: "Failed to update guard" });
  }
});

// ------- delete guard -------
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { pk: `GUARD#${req.params.id}`, sk: "METADATA" },
      })
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/guards/:id error:", err);
    res.status(500).json({ error: "Failed to delete guard" });
  }
});

export default router;
