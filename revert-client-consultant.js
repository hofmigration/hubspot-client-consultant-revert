/**
 * Client Consultant Revert Agent  (v3)
 * ------------------------------------
 * Undoes the "Sync Client Consultant from Contact Owner to Deals" workflow,
 * which re-fired across June 2 / 4 / 6 and stamped wrong owners into the field.
 *
 * SCOPE (env SCOPE):
 *   first_touch (default, RECOMMENDED):
 *       For each deal, find the FIRST time the workflow ever wrote this field,
 *       and restore whatever was there immediately before that.
 *       (Your example deal -> blank, because nothing was there before.)
 *   after_cutoff:
 *       Only revert deals the workflow wrote AFTER the WORKFLOW_START_ISO time.
 *
 * SAFETY GUARDS (both scopes):
 *   - If a PERSON (CRM_UI) made the LAST change, leave the deal alone.
 *   - If the value we'd restore was set by a person, the API returns unreadable
 *     junk -> we DO NOT write; flag it NEEDS_MANUAL.
 *   - Modes: dry_run (no writes), test (first 10), full (everything).
 *
 * Always prints a day-by-day timeline of workflow changes so you can SEE the damage.
 */

const fs = require("fs");

const TOKEN = process.env.HUBSPOT_TOKEN;
const MODE = (process.env.MODE || "dry_run").toLowerCase();
const REVIEWED = (process.env.REVIEWED || "no").toLowerCase();
const SCOPE = (process.env.SCOPE || "first_touch").toLowerCase();
const CUTOFF_ISO = process.env.WORKFLOW_START_ISO || "2026-06-06T07:00:00Z"; // only used by after_cutoff
const WORKFLOW_SOURCE_TYPES = ["AUTOMATION_PLATFORM"];
const PROP = "client_consultant";
const TEST_LIMIT = 10;
const UNREADABLE_HINT = "stores an actual user";

const BASE = "https://api.hubapi.com";
const cutoffMs = Date.parse(CUTOFF_ISO);

if (!TOKEN) { console.error("ERROR: HUBSPOT_TOKEN secret is missing."); process.exit(1); }
if (!["dry_run", "test", "full", "diagnose"].includes(MODE)) { console.error(`ERROR: bad MODE "${MODE}".`); process.exit(1); }
if (!["first_touch", "after_cutoff"].includes(SCOPE)) { console.error(`ERROR: bad SCOPE "${SCOPE}".`); process.exit(1); }
if (MODE === "full" && REVIEWED !== "yes") {
  console.error('SAFETY STOP: MODE=full needs "reviewed" = "yes". Run dry_run, check the CSV, then come back.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, path, body, attempt = 1) {
  const res = await fetch(BASE + path, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt <= 6) {
    const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
    console.log(`  (status ${res.status}, retry in ${wait}ms)`); await sleep(wait);
    return api(method, path, body, attempt + 1);
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}
const norm = (v) => (v === null || v === undefined ? "" : String(v).trim());
const blank = (v) => norm(v) === "";
const isUnreadable = (v) => norm(v).toLowerCase().includes(UNREADABLE_HINT);
const isWf = (st) => WORKFLOW_SOURCE_TYPES.includes(st);
const day = (ts) => new Date(ts).toISOString().slice(0, 10);
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function csvCell(s) { const v = s == null ? "" : String(s); return `"${v.replace(/"/g, '""')}"`; }

async function loadOwners() {
  const map = {}; let after = null;
  try {
    do {
      const q = after ? `&after=${after}` : "";
      const d = await api("GET", `/crm/v3/owners?limit=100${q}`);
      for (const o of d.results || []) {
        const n = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
        map[String(o.id)] = n ? `${n} (${o.email || ""})` : (o.email || String(o.id));
      }
      after = d.paging?.next?.after || null;
    } while (after);
  } catch (e) { console.log("  (owner names unavailable, showing IDs)"); }
  return map;
}
function label(v, owners) {
  if (blank(v)) return "(blank)";
  if (isUnreadable(v)) return "(unreadable - set by a person)";
  return owners[norm(v)] || `user ${norm(v)}`;
}

// Enumerate EVERY deal in the portal via the list endpoint (no 10,000 cap, unlike search).
// We must check every deal because the contact-side workflows wrote client_consultant onto
// associated deals all across the CRM, so no date/value filter is safe.
async function enumerateAllDeals() {
  const ids = []; const names = {}; let after = null; let pages = 0;
  do {
    const q = after ? `&after=${after}` : "";
    const d = await api("GET", `/crm/v3/objects/deals?limit=100&properties=dealname${q}`);
    for (const r of d.results || []) { ids.push(r.id); names[r.id] = r.properties?.dealname || ""; }
    after = d.paging?.next?.after || null;
    pages++;
    if (pages % 25 === 0) process.stdout.write(`\r  listing deals: ${ids.length}`);
    await sleep(120);
  } while (after);
  process.stdout.write(`\r  listing deals: ${ids.length}\n`);
  return { ids, names, total: ids.length };
}

async function buildPlan(ids, dealNames, owners) {
  const plan = [];
  const wfChangesByDay = {};   // every workflow write, by day
  const firstTouchByDay = {};  // each deal's FIRST workflow write, by day
  const batches = chunk(ids, 50); let done = 0;

  for (const batch of batches) {
    const d = await api("POST", "/crm/v3/objects/deals/batch/read", {
      propertiesWithHistory: [PROP], inputs: batch.map((id) => ({ id })),
    });
    for (const r of d.results || []) {
      const id = r.id;
      let versions = ((r.propertiesWithHistory && r.propertiesWithHistory[PROP]) || [])
        .map((v) => ({ ...v, ts: Date.parse(v.timestamp) }))
        .sort((a, b) => b.ts - a.ts); // newest first

      const current = versions[0] || { value: "", sourceType: "NONE", ts: 0 };
      const wfVersions = versions.filter((v) => isWf(v.sourceType));
      wfVersions.forEach((v) => (wfChangesByDay[day(v.ts)] = (wfChangesByDay[day(v.ts)] || 0) + 1));

      let touched, boundaryTs;
      if (SCOPE === "after_cutoff") {
        touched = wfVersions.some((v) => v.ts >= cutoffMs); boundaryTs = cutoffMs;
      } else {
        touched = wfVersions.length > 0;
        boundaryTs = wfVersions.length ? Math.min(...wfVersions.map((v) => v.ts)) : null;
      }
      if (wfVersions.length) firstTouchByDay[day(Math.min(...wfVersions.map((v) => v.ts)))] =
        (firstTouchByDay[day(Math.min(...wfVersions.map((v) => v.ts)))] || 0) + 1;

      let action, reason, restoreValue = "", restoreSource = "", restoreTime = "";
      if (!touched) {
        action = "SKIP_NO_WORKFLOW"; reason = "Workflow never wrote this field (in scope).";
      } else {
        const restoreVersion = versions.find((v) => v.ts < boundaryTs);
        restoreValue = restoreVersion ? norm(restoreVersion.value) : "";
        restoreSource = restoreVersion ? restoreVersion.sourceType : "(none - was blank)";
        restoreTime = restoreVersion ? new Date(restoreVersion.ts).toISOString() : "";

        if (!isWf(current.sourceType)) {
          action = "SKIP_HUMAN_EDITED"; reason = `Last change was ${current.sourceType} - already handled by a person.`;
        } else if (isUnreadable(restoreValue)) {
          action = "NEEDS_MANUAL"; reason = "Pre-workflow value was set by a person and can't be read back safely.";
        } else if (norm(current.value) === restoreValue) {
          action = "SKIP_ALREADY_CORRECT"; reason = "Field already equals its pre-workflow value.";
        } else {
          action = blank(restoreValue) ? "REVERT_TO_BLANK" : "REVERT_TO_NAME";
          reason = `Restoring value from ${restoreTime || "before the workflow ever touched it (blank)"}.`;
        }
      }

      plan.push({
        id, name: dealNames[id] || "",
        currentLabel: label(current.value, owners), currentSource: current.sourceType,
        currentTime: current.ts ? new Date(current.ts).toISOString() : "",
        restoreValue, restoreLabel: label(restoreValue, owners), restoreSource, restoreTime,
        action, reason, url: `https://app.hubspot.com/contacts/23735726/record/0-3/${id}`,
      });
    }
    done += batch.length;
    process.stdout.write(`\r  read history: ${done}/${ids.length}`);
    await sleep(200);
  }
  process.stdout.write("\n");
  return { plan, wfChangesByDay, firstTouchByDay };
}

async function applyReverts(toFix) {
  let ok = 0, fail = 0;
  for (const g of chunk(toFix, 100)) {
    try {
      await api("POST", "/crm/v3/objects/deals/batch/update", {
        inputs: g.map((d) => ({ id: d.id, properties: { [PROP]: d.restoreValue } })),
      });
      g.forEach((d) => (d.result = "WRITTEN")); ok += g.length;
    } catch (e) {
      g.forEach((d) => (d.result = "ERROR: " + e.message.slice(0, 120))); fail += g.length;
      console.log("  batch write error:", e.message.slice(0, 200));
    }
    process.stdout.write(`\r  written: ${ok}, failed: ${fail}`); await sleep(300);
  }
  process.stdout.write("\n"); return { ok, fail };
}

function writeCsv(plan) {
  const order = { REVERT_TO_BLANK: 0, REVERT_TO_NAME: 1, NEEDS_MANUAL: 2, SKIP_HUMAN_EDITED: 3, SKIP_ALREADY_CORRECT: 4, SKIP_NO_WORKFLOW: 5 };
  const sorted = [...plan].sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9));
  const header = ["deal_id","deal_name","action","current_value_now","current_source","current_change_time",
    "will_be_set_to","restore_value_source","restore_value_time","reason","result","deal_url"];
  const rows = sorted.map((d) => [
    d.id, d.name, d.action, d.currentLabel, d.currentSource, d.currentTime,
    d.action.startsWith("REVERT") ? d.restoreLabel : "(no change)",
    d.action.startsWith("REVERT") ? d.restoreSource : "",
    d.action.startsWith("REVERT") ? d.restoreTime : "",
    d.reason, d.result || (d.action.startsWith("REVERT") ? "PLANNED" : "n/a"), d.url,
  ].map(csvCell).join(","));
  fs.writeFileSync("revert-plan.csv", [header.join(","), ...rows].join("\n"));
}

function summarize(plan, counts, wfByDay, firstByDay, writeStats) {
  const L = [];
  L.push(`# Client Consultant Revert — ${MODE.toUpperCase()} — scope: ${SCOPE}`, "");
  L.push("### When the workflow actually changed this field");
  L.push("Each deal's FIRST workflow touch, by day (this is when damage happened):");
  Object.keys(firstByDay).sort().forEach((k) => L.push(`- ${k}: **${firstByDay[k]}** deals`));
  L.push("");
  L.push("All workflow writes, by day (includes re-fires):");
  Object.keys(wfByDay).sort().forEach((k) => L.push(`- ${k}: ${wfByDay[k]} writes`));
  L.push("");
  L.push("### Plan");
  L.push(`- Deals scanned: **${plan.length}**`);
  L.push(`- Revert to BLANK: **${counts.REVERT_TO_BLANK || 0}**`);
  L.push(`- Revert to a NAME (review): **${counts.REVERT_TO_NAME || 0}**`);
  L.push(`- Needs manual fix (unreadable old value): **${counts.NEEDS_MANUAL || 0}**`);
  L.push(`- Skipped, person edited after: **${counts.SKIP_HUMAN_EDITED || 0}**`);
  L.push(`- Skipped, already correct: **${counts.SKIP_ALREADY_CORRECT || 0}**`);
  L.push(`- Skipped, workflow never touched: **${counts.SKIP_NO_WORKFLOW || 0}**`);
  if (writeStats) L.push("", `- **Written this run: ${writeStats.ok}** (failed: ${writeStats.fail})`);
  const text = L.join("\n");
  console.log("\n" + text + "\n");
  fs.writeFileSync("summary.txt", text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}

// A few sample deals to inspect by default (mix of June 2/4 stamped + June 6 / human edited).
const DEFAULT_DIAG_IDS = ["45941926666", "60902004358", "39110421316", "60918600260", "58474796362"];

async function fetchHistorySingle(id) {
  return api("GET", `/crm/v3/objects/deals/${id}?propertiesWithHistory=${PROP}&properties=dealname`);
}
async function fetchHistoryBatch(ids) {
  return api("POST", "/crm/v3/objects/deals/batch/read", { propertiesWithHistory: [PROP], inputs: ids.map((id) => ({ id })) });
}

// DIAGNOSTIC: dump the FULL change log for a few deals, single-GET vs bulk, so we can SEE
// whether the bulk call is dropping older versions (which would make every revert unsafe).
async function diagnose(owners) {
  const raw = (process.env.DIAGNOSE_IDS || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const ids = raw.length ? raw : DEFAULT_DIAG_IDS;
  const L = [];
  L.push(`# History diagnostic — ${ids.length} deals`, "");

  let batchMap = {};
  try {
    const b = await fetchHistoryBatch(ids);
    for (const r of b.results || []) batchMap[String(r.id)] = ((r.propertiesWithHistory && r.propertiesWithHistory[PROP]) || []);
  } catch (e) { L.push("bulk batch-read error: " + e.message, ""); }

  for (const id of ids) {
    L.push(`## Deal ${id}`);
    let single = [];
    try {
      const s = await fetchHistorySingle(id);
      single = (s.propertiesWithHistory && s.propertiesWithHistory[PROP]) || [];
      L.push(`name: ${s.properties?.dealname || ""}`);
    } catch (e) { L.push("single-GET error: " + e.message); }
    const batchN = (batchMap[String(id)] || []).length;
    L.push(`>> single-GET returned ${single.length} versions  |  bulk batch-read returned ${batchN} versions`);
    if (single.length > batchN) L.push(">> MISMATCH: the bulk call is dropping history. This is the bug.");
    L.push("Full change log (single-GET, newest first):");
    single.map((v) => ({ ...v, ts: Date.parse(v.timestamp) })).sort((a, b) => b.ts - a.ts)
      .forEach((v, i) => L.push(`  ${i}: [${v.sourceType}] ${new Date(v.ts).toISOString()}  value="${norm(v.value)}"  -> ${label(v.value, owners)}`));
    L.push("");
    await sleep(200);
  }
  const text = L.join("\n");
  console.log("\n" + text + "\n");
  fs.writeFileSync("summary.txt", text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}

(async () => {
  console.log(`MODE=${MODE}  SCOPE=${SCOPE}`);
  if (SCOPE === "after_cutoff") console.log(`Cutoff = ${CUTOFF_ISO}`);
  console.log("Loading owner names...");
  const owners = await loadOwners();
  if (MODE === "diagnose") { await diagnose(owners); console.log("Wrote summary.txt"); return; }
  console.log("Listing every deal in the portal (the quick part)...");
  const { ids, names, total } = await enumerateAllDeals();
  console.log(`  ${ids.length} deals to inspect.`);
  console.log("Reading change history for every deal (this is the slow part, 20-40 min)...");
  const { plan, wfChangesByDay, firstTouchByDay } = await buildPlan(ids, names, owners);

  const counts = {};
  plan.forEach((d) => (counts[d.action] = (counts[d.action] || 0) + 1));

  let toFix = plan.filter((d) => d.action.startsWith("REVERT"));
  let writeStats = null;
  if (MODE === "dry_run") console.log(`\nDRY RUN — nothing written. ${toFix.length} deals would be reverted.`);
  else if (MODE === "test") { toFix = toFix.slice(0, TEST_LIMIT); console.log(`\nTEST — writing first ${toFix.length}...`); writeStats = await applyReverts(toFix); }
  else { console.log(`\nFULL — writing all ${toFix.length}...`); writeStats = await applyReverts(toFix); }

  writeCsv(plan);
  summarize(plan, counts, wfChangesByDay, firstTouchByDay, writeStats);
  console.log("Wrote revert-plan.csv");
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
