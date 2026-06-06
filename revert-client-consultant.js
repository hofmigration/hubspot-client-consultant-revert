/**
 * Client Consultant Revert Agent
 * --------------------------------
 * Undoes the damage from the "Sync Client Consultant from Contact Owner to Deals"
 * workflow, which misfired and stamped the wrong (or any) person into the
 * `client_consultant` deal property starting ~1:00 PM PKT on June 6, 2026.
 *
 * For every deal the workflow touched, this restores the EXACT value that was
 * in the field just before the workflow ran:
 *    - was blank  -> set back to blank
 *    - had a name -> set back to that name
 *
 * SAFETY:
 *   - If a HUMAN edited the field AFTER the workflow, we LEAVE IT ALONE.
 *   - If the field already matches its pre-workflow value, we skip it.
 *   - Three modes, controlled by the MODE env var:
 *        dry_run -> writes NOTHING. Produces a full plan (CSV + log).
 *        test    -> actually writes to the FIRST 10 deals only.
 *        full    -> writes to all affected deals.
 *
 * This reads the property CHANGE HISTORY, which is only possible with your
 * private app token (this is why it runs here and not in the chat connector).
 */

const fs = require("fs");

// ---------- Config (all overridable via GitHub Action inputs / env) ----------
const TOKEN = process.env.HUBSPOT_TOKEN;
const MODE = (process.env.MODE || "dry_run").toLowerCase();
const REVIEWED = (process.env.REVIEWED || "no").toLowerCase();
// 1:00 PM Pakistan time on June 6 = 08:00 UTC (PKT is UTC+5, no DST).
const WORKFLOW_START_ISO = process.env.WORKFLOW_START_ISO || "2026-06-06T08:00:00Z";
// Optional: if you later learn the exact workflow's source id, paste it here
// and only changes from THAT workflow will be treated as the culprit.
const WORKFLOW_SOURCE_ID = (process.env.WORKFLOW_SOURCE_ID || "").trim();
// HubSpot reports workflow-made changes with this source type.
const WORKFLOW_SOURCE_TYPES = ["AUTOMATION_PLATFORM"];
const PROP = "client_consultant";
const TEST_LIMIT = 10;

const BASE = "https://api.hubapi.com";
const cutoffMs = Date.parse(WORKFLOW_START_ISO);

if (!TOKEN) {
  console.error("ERROR: HUBSPOT_TOKEN secret is missing.");
  process.exit(1);
}
if (!["dry_run", "test", "full"].includes(MODE)) {
  console.error(`ERROR: MODE must be dry_run, test, or full (got "${MODE}").`);
  process.exit(1);
}
if (MODE === "full" && REVIEWED !== "yes") {
  console.error(
    'SAFETY STOP: MODE=full requires the "I reviewed the dry run" input to be set to "yes". ' +
      "Run dry_run first, check the CSV, then come back."
  );
  process.exit(1);
}

// ---------- Small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, attempt = 1) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt <= 6) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.log(`  (rate/limit ${res.status}, retrying in ${wait}ms...)`);
      await sleep(wait);
      return api(method, path, body, attempt + 1);
    }
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

function norm(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}
const blank = (v) => norm(v) === "";

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function csvCell(s) {
  const v = s === null || s === undefined ? "" : String(s);
  return `"${v.replace(/"/g, '""')}"`;
}

// ---------- Step 1: map owner ids -> readable names ----------
async function loadOwners() {
  const map = {};
  let after = null;
  try {
    do {
      const q = after ? `&after=${after}` : "";
      const data = await api("GET", `/crm/v3/owners?limit=100${q}`);
      for (const o of data.results || []) {
        const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim();
        map[String(o.id)] = name ? `${name} (${o.email || ""})` : o.email || String(o.id);
      }
      after = data.paging?.next?.after || null;
    } while (after);
  } catch (e) {
    console.log("  (could not load owner names, will show raw IDs)");
  }
  return map;
}
function label(id, owners) {
  if (blank(id)) return "(blank)";
  return owners[norm(id)] || `user ${norm(id)}`;
}

// ---------- Step 2: find candidate deals (modified since cutoff, has the field) ----------
async function findCandidates() {
  const ids = [];
  const names = {};
  let after = null;
  let total = null;
  do {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: PROP, operator: "HAS_PROPERTY" },
            { propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(cutoffMs) },
          ],
        },
      ],
      properties: ["dealname"],
      limit: 200,
      sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
    };
    if (after) body.after = after;
    const data = await api("POST", "/crm/v3/objects/deals/search", body);
    if (total === null) total = data.total;
    for (const r of data.results || []) {
      ids.push(r.id);
      names[r.id] = r.properties?.dealname || "";
    }
    after = data.paging?.next?.after || null;
    await sleep(150);
  } while (after && ids.length < 10000);

  if (total > 10000) {
    console.log(
      `  WARNING: ${total} deals match the window but search only returns the first 10,000. ` +
        "Tell me if the real number is this high and I'll add date-slicing."
    );
  }
  return { ids, names, total };
}

// ---------- Step 3: read property history & decide per deal ----------
function isWorkflowChange(version) {
  if (!WORKFLOW_SOURCE_TYPES.includes(version.sourceType)) return false;
  if (WORKFLOW_SOURCE_ID && norm(version.sourceId) !== WORKFLOW_SOURCE_ID) return false;
  return true;
}

async function buildPlan(ids, dealNames, owners) {
  const plan = [];
  const seenSourceIds = new Set();
  const batches = chunk(ids, 50);
  let done = 0;
  for (const batch of batches) {
    const data = await api("POST", "/crm/v3/objects/deals/batch/read", {
      propertiesWithHistory: [PROP],
      inputs: batch.map((id) => ({ id })),
    });
    for (const r of data.results || []) {
      const id = r.id;
      let versions = (r.propertiesWithHistory && r.propertiesWithHistory[PROP]) || [];
      // newest first
      versions = versions
        .map((v) => ({ ...v, ts: Date.parse(v.timestamp) }))
        .sort((a, b) => b.ts - a.ts);

      const current = versions[0] || { value: "", sourceType: "NONE", ts: 0 };
      // value as it stood just BEFORE the workflow window
      const priorVersion = versions.find((v) => v.ts < cutoffMs);
      const priorValue = priorVersion ? norm(priorVersion.value) : "";

      versions.forEach((v) => v.sourceId && seenSourceIds.add(`${v.sourceType}:${v.sourceId}`));

      let action, reason;
      if (norm(current.value) === priorValue) {
        action = "SKIP_ALREADY_CORRECT";
        reason = "Field already equals its pre-workflow value.";
      } else if (isWorkflowChange(current) && current.ts >= cutoffMs) {
        action = blank(priorValue) ? "REVERT_TO_BLANK" : "REVERT_TO_NAME";
        reason = "Last change was the workflow; restoring pre-workflow value.";
      } else {
        action = "SKIP_HUMAN_EDITED";
        reason = `Last change was ${current.sourceType} after the workflow - leaving it for manual review.`;
      }

      plan.push({
        id,
        name: dealNames[id] || "",
        currentValue: norm(current.value),
        currentLabel: label(current.value, owners),
        currentSource: current.sourceType,
        currentTime: current.ts ? new Date(current.ts).toISOString() : "",
        priorValue,
        priorLabel: label(priorValue, owners),
        action,
        reason,
        url: `https://app.hubspot.com/contacts/23735726/record/0-3/${id}`,
      });
    }
    done += batch.length;
    process.stdout.write(`\r  read history: ${done}/${ids.length}`);
    await sleep(200);
  }
  process.stdout.write("\n");
  return { plan, seenSourceIds: [...seenSourceIds] };
}

// ---------- Step 4: write reverts (test or full) ----------
async function applyReverts(toFix) {
  let ok = 0;
  let fail = 0;
  for (const group of chunk(toFix, 100)) {
    try {
      await api("POST", "/crm/v3/objects/deals/batch/update", {
        inputs: group.map((d) => ({
          id: d.id,
          properties: { [PROP]: d.priorValue }, // "" clears the field
        })),
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

// ---------- CSV + summary ----------
function writeCsv(plan) {
  const header = [
    "deal_id",
    "deal_name",
    "action",
    "current_value_now",
    "will_be_set_to",
    "current_source",
    "current_change_time",
    "reason",
    "result",
    "deal_url",
  ];
  const rows = plan.map((d) =>
    [
      d.id,
      d.name,
      d.action,
      d.currentLabel,
      d.action.startsWith("REVERT") ? d.priorLabel : "(no change)",
      d.currentSource,
      d.currentTime,
      d.reason,
      d.result || (d.action.startsWith("REVERT") ? "PLANNED" : "n/a"),
      d.url,
    ]
      .map(csvCell)
      .join(",")
  );
  fs.writeFileSync("revert-plan.csv", [header.join(","), ...rows].join("\n"));
}

function summarize(plan, counts, seenSourceIds, writeStats) {
  const lines = [];
  lines.push(`# Client Consultant Revert — ${MODE.toUpperCase()}`);
  lines.push("");
  lines.push(`- Workflow window starts: **${WORKFLOW_START_ISO}** (1:00 PM PKT, June 6)`);
  lines.push(`- Candidate deals scanned: **${plan.length}**`);
  lines.push(`- Would revert to BLANK: **${counts.REVERT_TO_BLANK || 0}**`);
  lines.push(`- Would revert to a NAME: **${counts.REVERT_TO_NAME || 0}**`);
  lines.push(`- Skipped (already correct): **${counts.SKIP_ALREADY_CORRECT || 0}**`);
  lines.push(`- Skipped (human edited after): **${counts.SKIP_HUMAN_EDITED || 0}**`);
  if (writeStats) {
    lines.push("");
    lines.push(`- **Actually written this run: ${writeStats.ok}** (failed: ${writeStats.fail})`);
  }
  lines.push("");
  lines.push("### Automation source IDs seen in history");
  lines.push("If you see more than one here, tell me which is the bad workflow and I'll lock onto just that one.");
  lines.push("");
  seenSourceIds.slice(0, 25).forEach((s) => lines.push(`- \`${s}\``));
  const text = lines.join("\n");
  console.log("\n" + text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  }
}

// ---------- Main ----------
(async () => {
  console.log(`MODE = ${MODE}`);
  console.log(`Workflow window start = ${WORKFLOW_START_ISO} (${cutoffMs})`);
  console.log("Loading owner names...");
  const owners = await loadOwners();

  console.log("Finding deals modified since the workflow window...");
  const { ids, names, total } = await findCandidates();
  console.log(`  found ${ids.length} candidate deals (search total: ${total}).`);

  console.log("Reading change history for each deal...");
  const { plan, seenSourceIds } = await buildPlan(ids, names, owners);

  const counts = {};
  plan.forEach((d) => (counts[d.action] = (counts[d.action] || 0) + 1));

  let toFix = plan.filter((d) => d.action.startsWith("REVERT"));
  let writeStats = null;

  if (MODE === "dry_run") {
    console.log(`\nDRY RUN — nothing was written. ${toFix.length} deals would be reverted.`);
  } else if (MODE === "test") {
    toFix = toFix.slice(0, TEST_LIMIT);
    console.log(`\nTEST — writing the first ${toFix.length} deals only...`);
    writeStats = await applyReverts(toFix);
  } else if (MODE === "full") {
    console.log(`\nFULL — writing all ${toFix.length} deals...`);
    writeStats = await applyReverts(toFix);
  }

  writeCsv(plan);
  summarize(plan, counts, seenSourceIds, writeStats);
  console.log("Wrote revert-plan.csv");
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
