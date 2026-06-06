/**
 * Client Consultant Revert Agent  (v2)
 * ------------------------------------
 * Undoes the "Sync Client Consultant from Contact Owner to Deals" workflow.
 *
 * WHAT IT DOES (per your instructions):
 *   - Cutoff = 12:00 PM PKT on June 6 (= 07:00 UTC). "After 12pm."
 *   - For any deal where the WORKFLOW wrote to client_consultant AFTER the cutoff,
 *     restore the value that was there JUST BEFORE the cutoff
 *     (blank -> blank, as in the example deal; name -> that name).
 *
 * SAFETY GUARDS:
 *   - If a PERSON (CRM_UI) made the last change, leave the deal alone
 *     (you've already handled it by hand).
 *   - If the value we'd need to restore was set by a person, the API returns
 *     unreadable junk -> we DO NOT write; we flag it NEEDS_MANUAL.
 *   - Modes: dry_run (no writes), test (first 10), full (everything).
 */

const fs = require("fs");

// ---------- Config ----------
const TOKEN = process.env.HUBSPOT_TOKEN;
const MODE = (process.env.MODE || "dry_run").toLowerCase();
const REVIEWED = (process.env.REVIEWED || "no").toLowerCase();
// 12:00 PM Pakistan time, June 6 = 07:00 UTC.
const CUTOFF_ISO = process.env.WORKFLOW_START_ISO || "2026-06-06T07:00:00Z";
const WORKFLOW_SOURCE_TYPES = ["AUTOMATION_PLATFORM"]; // your workflow shows up as this
const PROP = "client_consultant";
const TEST_LIMIT = 10;
// When a person set the value, the API hands back this description text instead
// of the real value. We treat anything containing this as UNREADABLE.
const UNREADABLE_HINT = "stores an actual user";

const BASE = "https://api.hubapi.com";
const cutoffMs = Date.parse(CUTOFF_ISO);

if (!TOKEN) { console.error("ERROR: HUBSPOT_TOKEN secret is missing."); process.exit(1); }
if (!["dry_run", "test", "full"].includes(MODE)) {
  console.error(`ERROR: MODE must be dry_run, test, or full (got "${MODE}").`); process.exit(1);
}
if (MODE === "full" && REVIEWED !== "yes") {
  console.error('SAFETY STOP: MODE=full needs the "reviewed" input set to "yes". Run dry_run, check the CSV, then come back.');
  process.exit(1);
}

// ---------- Helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, attempt = 1) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt <= 6) {
    const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
    console.log(`  (status ${res.status}, retrying in ${wait}ms...)`);
    await sleep(wait);
    return api(method, path, body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

const norm = (v) => (v === null || v === undefined ? "" : String(v).trim());
const blank = (v) => norm(v) === "";
const isUnreadable = (v) => norm(v).toLowerCase().includes(UNREADABLE_HINT);
const isWorkflow = (st) => WORKFLOW_SOURCE_TYPES.includes(st);

function chunk(arr, n) { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; }
function csvCell(s) { const v = s == null ? "" : String(s); return `"${v.replace(/"/g, '""')}"`; }

async function loadOwners() {
  const map = {}; let after = null;
  try {
    do {
      const q = after ? `&after=${after}` : "";
      const data = await api("GET", `/crm/v3/owners?limit=100${q}`);
      for (const o of data.results || []) {
        const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
        map[String(o.id)] = name ? `${name} (${o.email || ""})` : (o.email || String(o.id));
      }
      after = data.paging?.next?.after || null;
    } while (after);
  } catch (e) { console.log("  (could not load owner names, will show raw IDs)"); }
  return map;
}
function label(v, owners) {
  if (blank(v)) return "(blank)";
  if (isUnreadable(v)) return "(unreadable - set by a person)";
  return owners[norm(v)] || `user ${norm(v)}`;
}

async function findCandidates() {
  const ids = []; const names = {}; let after = null; let total = null;
  do {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: PROP, operator: "HAS_PROPERTY" },
        { propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(cutoffMs) },
      ]}],
      properties: ["dealname"],
      limit: 200,
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
    };
    if (after) body.after = after;
    const data = await api("POST", "/crm/v3/objects/deals/search", body);
    if (total === null) total = data.total;
    for (const r of data.results || []) { ids.push(r.id); names[r.id] = r.properties?.dealname || ""; }
    after = data.paging?.next?.after || null;
    await sleep(150);
  } while (after && ids.length < 10000);
  if (total > 10000) console.log(`  WARNING: ${total} match but search caps at 10,000. Tell me if it's really this many.`);
  return { ids, names, total };
}

async function buildPlan(ids, dealNames, owners) {
  const plan = []; const batches = chunk(ids, 50); let done = 0;
  for (const batch of batches) {
    const data = await api("POST", "/crm/v3/objects/deals/batch/read", {
      propertiesWithHistory: [PROP],
      inputs: batch.map((id) => ({ id })),
    });
    for (const r of data.results || []) {
      const id = r.id;
      let versions = ((r.propertiesWithHistory && r.propertiesWithHistory[PROP]) || [])
        .map((v) => ({ ...v, ts: Date.parse(v.timestamp) }))
        .sort((a, b) => b.ts - a.ts); // newest first

      const current = versions[0] || { value: "", sourceType: "NONE", ts: 0 };
      const priorVersion = versions.find((v) => v.ts < cutoffMs);
      const restoreValue = priorVersion ? norm(priorVersion.value) : "";
      const restoreSource = priorVersion ? priorVersion.sourceType : "(none - was blank)";
      const restoreTime = priorVersion ? new Date(priorVersion.ts).toISOString() : "";
      const workflowTouchedInWindow = versions.some((v) => v.ts >= cutoffMs && isWorkflow(v.sourceType));

      let action, reason;
      if (!workflowTouchedInWindow) {
        action = "SKIP_NOT_IN_WINDOW";
        reason = "Workflow did not write to this field after 12pm June 6.";
      } else if (!isWorkflow(current.sourceType)) {
        action = "SKIP_HUMAN_EDITED";
        reason = `Last change was ${current.sourceType} - already handled by a person, leaving alone.`;
      } else if (isUnreadable(restoreValue)) {
        action = "NEEDS_MANUAL";
        reason = "The value to restore was set by a person and can't be read back safely - fix by hand.";
      } else if (norm(current.value) === restoreValue) {
        action = "SKIP_ALREADY_CORRECT";
        reason = "Field already equals its pre-noon value.";
      } else {
        action = blank(restoreValue) ? "REVERT_TO_BLANK" : "REVERT_TO_NAME";
        reason = `Workflow changed it after 12pm June 6; restoring value from ${restoreTime || "before the workflow ever touched it (blank)"}.`;
      }

      plan.push({
        id, name: dealNames[id] || "",
        currentLabel: label(current.value, owners),
        currentSource: current.sourceType,
        currentTime: current.ts ? new Date(current.ts).toISOString() : "",
        restoreValue,
        restoreLabel: label(restoreValue, owners),
        restoreSource, restoreTime,
        action, reason,
        url: `https://app.hubspot.com/contacts/23735726/record/0-3/${id}`,
      });
    }
    done += batch.length;
    process.stdout.write(`\r  read history: ${done}/${ids.length}`);
    await sleep(200);
  }
  process.stdout.write("\n");
  return plan;
}

async function applyReverts(toFix) {
  let ok = 0, fail = 0;
  for (const group of chunk(toFix, 100)) {
    try {
      await api("POST", "/crm/v3/objects/deals/batch/update", {
        inputs: group.map((d) => ({ id: d.id, properties: { [PROP]: d.restoreValue } })), // "" clears it
      });
      group.forEach((d) => (d.result = "WRITTEN"));
      ok += group.length;
    } catch (e) {
      group.forEach((d) => (d.result = "ERROR: " + e.message.slice(0, 120)));
      fail += group.length;
      console.log("  batch write error:", e.message.slice(0, 200));
    }
    process.stdout.write(`\r  written: ${ok}, failed: ${fail}`);
    await sleep(300);
  }
  process.stdout.write("\n");
  return { ok, fail };
}

function writeCsv(plan) {
  const header = ["deal_id","deal_name","action","current_value_now","current_source","current_change_time",
    "will_be_set_to","restore_value_source","restore_value_time","reason","result","deal_url"];
  const rows = plan.map((d) => [
    d.id, d.name, d.action, d.currentLabel, d.currentSource, d.currentTime,
    d.action.startsWith("REVERT") ? d.restoreLabel : "(no change)",
    d.action.startsWith("REVERT") ? d.restoreSource : "",
    d.action.startsWith("REVERT") ? d.restoreTime : "",
    d.reason, d.result || (d.action.startsWith("REVERT") ? "PLANNED" : "n/a"), d.url,
  ].map(csvCell).join(","));
  fs.writeFileSync("revert-plan.csv", [header.join(","), ...rows].join("\n"));
}

function summarize(plan, counts, writeStats) {
  const L = [];
  L.push(`# Client Consultant Revert — ${MODE.toUpperCase()}`, "");
  L.push(`- Cutoff (workflow writes AFTER this get reverted): **${CUTOFF_ISO}** = 12:00 PM PKT, June 6`);
  L.push(`- Candidate deals scanned: **${plan.length}**`);
  L.push(`- Revert to BLANK: **${counts.REVERT_TO_BLANK || 0}**`);
  L.push(`- Revert to a NAME (review these): **${counts.REVERT_TO_NAME || 0}**`);
  L.push(`- Needs manual fix (old value unreadable): **${counts.NEEDS_MANUAL || 0}**`);
  L.push(`- Skipped, person edited after: **${counts.SKIP_HUMAN_EDITED || 0}**`);
  L.push(`- Skipped, not changed in window: **${counts.SKIP_NOT_IN_WINDOW || 0}**`);
  L.push(`- Skipped, already correct: **${counts.SKIP_ALREADY_CORRECT || 0}**`);
  if (writeStats) L.push("", `- **Actually written this run: ${writeStats.ok}** (failed: ${writeStats.fail})`);
  const text = L.join("\n");
  console.log("\n" + text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}

(async () => {
  console.log(`MODE = ${MODE}`);
  console.log(`Cutoff = ${CUTOFF_ISO} (${cutoffMs})  [revert deals the workflow changed AFTER this]`);
  console.log("Loading owner names...");
  const owners = await loadOwners();
  console.log("Finding deals modified since the cutoff...");
  const { ids, names, total } = await findCandidates();
  console.log(`  found ${ids.length} candidate deals (search total: ${total}).`);
  console.log("Reading change history for each deal...");
  const plan = await buildPlan(ids, names, owners);

  const counts = {};
  plan.forEach((d) => (counts[d.action] = (counts[d.action] || 0) + 1));

  let toFix = plan.filter((d) => d.action.startsWith("REVERT"));
  let writeStats = null;
  if (MODE === "dry_run") {
    console.log(`\nDRY RUN — nothing written. ${toFix.length} deals would be reverted.`);
  } else if (MODE === "test") {
    toFix = toFix.slice(0, TEST_LIMIT);
    console.log(`\nTEST — writing first ${toFix.length} deals only...`);
    writeStats = await applyReverts(toFix);
  } else {
    console.log(`\nFULL — writing all ${toFix.length} deals...`);
    writeStats = await applyReverts(toFix);
  }

  writeCsv(plan);
  summarize(plan, counts, writeStats);
  console.log("Wrote revert-plan.csv");
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
