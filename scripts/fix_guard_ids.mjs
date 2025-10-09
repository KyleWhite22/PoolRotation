/* Run with: node scripts/fix_guard_ids.mjs --apply
   Without --apply it does a dry run. */
import { ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../src/db.js"; // adjust path if needed

const strip = v => typeof v === "string" && v.startsWith("GUARD#") ? v.slice(6) : String(v || "");
const norm  = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
const APPLY = process.argv.includes("--apply");

async function loadMaps() {
  const scan = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: "begins_with(pk, :p) AND #sk = :sk AND #type = :t",
    ExpressionAttributeValues: { ":p": "GUARD#", ":sk": "METADATA", ":t": "Guard" },
    ExpressionAttributeNames: { "#sk": "sk", "#type": "type" },
    ConsistentRead: true,
  }));
  const guards = (scan.Items ?? []).map(it => ({
    id: typeof it.pk === "string" && it.pk.startsWith("GUARD#") ? it.pk.slice(6) : String(it.id ?? ""),
    name: String(it.name ?? ""),
  }));
  const known = new Set(guards.map(g => g.id));
  const byName = new Map(guards.map(g => [norm(g.name || g.id), g.id]));
  return { known, byName };
}
function toId(raw, known, byName) {
  if (raw == null) return null;
  const s = strip(raw).trim();
  if (!s) return null;
  if (known.has(s)) return s;
  const m = byName.get(norm(s));
  return m && known.has(m) ? m : null;
}

async function* scanAllRotations() {
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p)",
      ExpressionAttributeValues: { ":p": "ROTATION#" },
      ExclusiveStartKey,
      ConsistentRead: true,
    }));
    for (const it of (page.Items ?? [])) yield it;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

const { known, byName } = await loadMaps();
let changed = 0, examined = 0;

for await (const it of scanAllRotations()) {
  examined++;
  const { pk, sk, type } = it;
  if (type === "Queue") {
    const queue = Array.isArray(it.queue) ? it.queue : [];
    let dirty = false;
    const next = [];
    const seen = new Set();
    for (const q of queue) {
      const gid = toId(q?.guardId, known, byName);
      const sec = String(q?.returnTo || "");
      const tick = (typeof q?.enteredTick === "number" && Number.isFinite(q.enteredTick))
        ? Math.trunc(q.enteredTick) : 0;
      if (!gid || seen.has(gid)) { dirty = true; continue; }
      seen.add(gid);
      if (gid !== q.guardId) dirty = true;
      next.push({ guardId: gid, returnTo: sec, enteredTick: tick });
    }
    if (dirty && APPLY) {
      await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...it, queue: next }}));
      changed++;
      console.log("[fix] Queue", pk, sk, "entries:", next.length);
    } else if (dirty) {
      console.log("[dryrun] Queue would update", pk, sk);
    }
  }
  if (type === "RotationSlot") {
    const canon = toId(it.guardId, known, byName);
    if (canon !== it.guardId) {
      if (APPLY) {
        await ddb.send(new PutCommand({ TableName: TABLE, Item: { ...it, guardId: canon }}));
        changed++;
        console.log("[fix] Slot", pk, sk, "→", canon);
      } else {
        console.log("[dryrun] Slot would update", pk, sk, "→", canon);
      }
    }
  }
}

console.log({ examined, changed, applied: APPLY });
