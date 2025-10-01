// backend/src/routes/guard.ts
import type { Request, Response } from "express";
import { Router } from "express";
import { PutCommand, DeleteCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "node:crypto";
import { ddb, TABLE } from "../db.js";
import { GuardCreate, GuardUpdate } from "../schema.js";

const router = Router();

// ------- list guards -------
router.get("/", async (_req: Request, res: Response) => {
  try {
    const scan = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p)",
      ExpressionAttributeValues: { ":p": "GUARD#" },
    }));
    res.json(scan.Items ?? []);
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
      name: parsed.data.name,
      // store empty strings as undefined? Up to you. Here we pass through.
      dob: parsed.data.dob ?? null,
      phone: parsed.data.phone ?? null,
      createdAt: new Date().toISOString(),
    };

    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
    res.status(201).json({ id, ...item });
  } catch (err: any) {
    console.error("POST /api/guards error:", err);
    res
      .status(500)
      .json({ error: "Failed to create guard", detail: err?.name || err?.message || String(err) });
  }
});

// ------- update guard (PUT) -------
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const parsed = GuardUpdate.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());
    const { name, dob, phone } = parsed.data;

    // Build a dynamic UpdateExpression
    const sets: string[] = [];
    const removes: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, any> = {};

    // helper to SET
    const setAttr = (attr: string, val: any) => {
      const n = `#${attr}`;
      const v = `:${attr}`;
      names[n] = attr;
      values[v] = val;
      sets.push(`${n} = ${v}`);
    };

    // helper to REMOVE
    const removeAttr = (attr: string) => {
      const n = `#${attr}`;
      names[n] = attr;
      removes.push(n);
    };

    // Name: undefined -> do nothing; null not allowed for name (just omit)
    if (typeof name !== "undefined") setAttr("name", name);

    // dob: undefined -> do nothing; null -> REMOVE; string -> SET
    if (typeof dob !== "undefined") {
      if (dob === null) removeAttr("dob");
      else setAttr("dob", dob);
    }

    // phone: undefined -> do nothing; null -> REMOVE; string -> SET
    if (typeof phone !== "undefined") {
      if (phone === null) removeAttr("phone");
      else setAttr("phone", phone);
    }

    if (sets.length === 0 && removes.length === 0) {
      return res.status(400).json({ error: "No changes provided" });
    }

    const updateParts: string[] = [];
    if (sets.length) updateParts.push("SET " + sets.join(", "));
    if (removes.length) updateParts.push("REMOVE " + removes.join(", "));
    const UpdateExpression = updateParts.join(" ");

    const result = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `GUARD#${id}`, sk: "METADATA" },
      UpdateExpression,
      ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
      ConditionExpression: "attribute_exists(pk)",  // guard must exist
      ReturnValues: "ALL_NEW",
    }));

    res.json({ id, ...result.Attributes });
  } catch (err: any) {
    // ConditionalCheckFailedException if the guard doesn't exist
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
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { pk: `GUARD#${req.params.id}`, sk: "METADATA" },
    }));
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/guards/:id error:", err);
    res.status(500).json({ error: "Failed to delete guard" });
  }
});

export default router;
