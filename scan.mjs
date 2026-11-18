// Pulse Check — hourly world status scan.
// Node 20+, zero dependencies (uses built-in fetch).
//
// Env:
//   ANTHROPIC_API_KEY   required (unless --fixture)
//   NTFY_TOPIC          private ntfy topic name
//   PAGE_URL            link included in push text
//   MODEL               default claude-sonnet-5-5
//   MAX_SEARCHES        default 6 (web searches per run)
//   DAILY_SPEND_CAP_USD default 8
//   WEB_SEARCH_TOOL_TYPE default web_search_20250305 (change if the API rejects it)
//   DATA_DIR            default ./data
//   NTFY_DRY=1          print pushes instead of sending
// Flags:
//   --fixture <file>    skip API, use this JSON as the AI response (testing)

import fs from "node:fs";
import path from "node:path";

const ENV = process.env;
const DATA_DIR = ENV.DATA_DIR || "./data";
const MODEL = ENV.MODEL || "claude-sonnet-5-5";
const MAX_SEARCHES = Number(ENV.MAX_SEARCHES || 6);
const DAILY_CAP = Number(ENV.DAILY_SPEND_CAP_USD || 8);
const SEARCH_TOOL = ENV.WEB_SEARCH_TOOL_TYPE || "web_search_20250305";
// $ per million tokens / per search (Sonnet 5.5 list prices, Nov 2026)
const PRICE_IN = Number(ENV.PRICE_IN_PER_MTOK || 2);
const PRICE_OUT = Number(ENV.PRICE_OUT_PER_MTOK || 10);
const PRICE_SEARCH = Number(ENV.PRICE_PER_SEARCH || 0.01);

const RANK = { green: 0, yellow: 1, orange: 2, red: 3 };
const LEVELS = Object.keys(RANK);
const CRITICAL = ["aviation", "banking", "cloud", "power", "cisa", "payments"];

const args = process.argv.slice(2);
const fixtureArg = args.includes("--fixture") ? args[args.indexOf("--fixture") + 1] : null;

const file = (n) => path.join(DATA_DIR, n);
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
};
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
};
const today = () => new Date().toISOString().slice(0, 10);

// ---------- free official feeds (cheap cross-check; failures tolerated) ----------
const FEEDS = [
  { name: "Cloudflare status", url: "https://www.cloudflarestatus.com/api/v2/summary.json" },
  { name: "Google Cloud incidents", url: "https://status.cloud.google.com/incidents.json" },
  { name: "AWS Health (RSS)", url: "https://status.aws.amazon.com/rss/all.rss" },
  { name: "CISA advisories (RSS)", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml" },
  { name: "FAA NAS status", url: "https://nasstatus.faa.gov/api/airport-status-information" },
  { name: "Azure status (RSS)", url: "https://azure.status.microsoft/en-us/status/feed/" },
];

async function pullFeeds() {
  const health = [];
  const parts = [];
  await Promise.all(FEEDS.map(async (f) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(f.url, { signal: ctl.signal, headers: { "user-agent": "pulse-check/1.0" } });
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const text = (await r.text()).replace(/\s+/g, " ").slice(0, 3500);
      parts.push(`### ${f.name}\n${text}`);
      health.push({ name: f.name, ok: true });
    } catch (e) {
      health.push({ name: f.name, ok: false, error: String(e.message || e).slice(0, 80) });
    }
  }));
  return { digest: parts.join("\n\n"), health };
}

// ---------- prompt ----------
const SYSTEM = `You are the analyst behind "Pulse Check", a scheduled (every 2 hours) early-awareness status board. You summarize PUBLIC reporting about infrastructure outages, cyber incidents, financial-system glitches and other unusual signals, and judge whether they look related.

SCOPE (check every run): 1 tech/cloud outages; 2 aviation (FAA ground stops, NOTAM/air-traffic system failures); 3 banking/payments; 4 markets & crypto (halts, exchange glitches, large moves, ALWAYS checked against real price data); 5 telecom/internet (carriers, undersea cable, DNS/BGP); 6 power/utilities/pipelines; 7 government cyber advisories (CISA emergency directives, active exploitation); 8 physical/geopolitical escalations that could affect the above.
Look back 72 hours. Use the previous run's JSON to tell NEW from ONGOING events and keep stable event ids across runs.

SOURCES: official status pages and agencies (CISA, FBI/IC3, FCC, FAA, Fed/Treasury, SEC/NYSE/Nasdaq halts), wire services (AP, Reuters, BBC), cyber trade press (BleepingComputer, The Record, Krebs). Ignore celebrity, politics, opinion, outrage and clickbait.

CONFIRMATION RULE: an event is confirmed=true ONLY if at least 2 independent credible sources OR 1 official source report it. Single-source or social-media-only items are confirmed=false. Viral social claims (e.g. "crypto and stocks crashing") are unconfirmed leads: check against real price data, official status pages and wire services before listing them as anything else.

LEVELS: green = nothing unusual; yellow = several incidents, no link found; orange = incidents plausibly connected or a major system affected; red = credible evidence of coordinated attack or widespread systemic failure. Outages are common (base rates): do NOT raise the level just because several happened in one week. Raise it for common cause, official attack attribution, simultaneous failures across unrelated sectors, or critical systems down at the same time. Orange or red REQUIRE at least one confirmed event.

CORRELATION TEST for each pair of events: shared vendor/dependency? same time window? official statement of common cause? same failure signature? If none, call them independent.

HONESTY RULES: never state "this is not a cyber attack" as fact; say "no official source reports a cyber attack and the stated causes are X". Separate confirmed facts from inference. Give a confidence level. If sources conflict, say so and summarize both sides. If you cannot verify, say "unknown". Calm, practical tone. No panic language.

OUTPUT RULES: ONE JSON object only, no markdown fences, no prose before or after, no citation markup. Inside JSON strings NEVER use double quotes (use single quotes) and never use line breaks; keep every string under 300 characters; list at most 12 events (most important first). Exactly this shape:
{"generated_at":"ISO timestamp","level":"green|yellow|orange|red","level_changed_from_last_run":false,"summary":"3-5 plain sentences","events":[{"id":"stable-kebab-id","category":"cloud|aviation|banking|payments|markets|telecom|power|cisa|geopolitical|other","title":"","started_at":"ISO","status":"ongoing|resolved","impact":"","stated_cause":"","confirmed":true,"sources":[{"name":"","url":"https://..."}]}],"connection_assessment":{"verdict":"unrelated|possibly_related|likely_related|unknown","confidence":"low|medium|high","reasoning":"","would_change_my_mind":""},"alert":{"send":false,"headline":"","reason":""},"prep_note":""}
prep_note: calm practical steps, ONLY when level is yellow or above, else empty string. Every event needs at least one source with a real URL you actually saw. Quiet day = green with an empty or short events list.`;

// ---------- Anthropic call ----------
async function askClaude(prev, feedDigest) {
  const userMsg = `Current time (UTC): ${new Date().toISOString()}

PREVIOUS RUN JSON (for new-vs-ongoing context):
${prev ? JSON.stringify({ level: prev.level, summary: prev.summary, events: prev.events }).slice(0, 12000) : "none (first run)"}

DIRECT FEED SNAPSHOT (pulled by script just now; some feeds may be missing; treat as one input, not the whole picture):
${feedDigest || "no feeds reachable"}

Do the scan now. Use web search for anything the feeds do not cover, especially markets/crypto price checks, wire services and cyber press. Return the JSON only.`;

  const body = {
    model: MODEL,
    max_tokens: 10000,
    system: SYSTEM,
    messages: [{ role: "user", content: userMsg }],
    tools: [{ type: SEARCH_TOOL, name: "web_search", max_uses: MAX_SEARCHES }],
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 240000);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: ctl.signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": ENV.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  clearTimeout(t);
  const j = await r.json();
  if (!r.ok) throw new Error("API " + r.status + ": " + JSON.stringify(j).slice(0, 300));
  return { text: finalText(j.content || []), usage: usageOf(j) };
}

// Use only the text AFTER the last search step (the model's final answer), joined with no separator.
function finalText(content) {
  let last = -1;
  content.forEach((b, i) => { if (b.type === "server_tool_use" || b.type === "web_search_tool_result") last = i; });
  const tail = content.slice(last + 1).filter((b) => b.type === "text").map((b) => b.text);
  const all = content.filter((b) => b.type === "text").map((b) => b.text);
  return (tail.length ? tail : all).join("");
}

function usageOf(j) {
  const searches = j.usage?.server_tool_use?.web_search_requests ?? 0;
  const cost = ((j.usage?.input_tokens || 0) * PRICE_IN + (j.usage?.output_tokens || 0) * PRICE_OUT) / 1e6 + searches * PRICE_SEARCH;
  return { input: j.usage?.input_tokens || 0, output: j.usage?.output_tokens || 0, searches, cost_usd: Number(cost.toFixed(4)) };
}

// One cheap no-tools call that repairs malformed JSON (unescaped quotes, stray text, trailing commas).
async function repairJson(badText) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ENV.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: "You repair malformed JSON. Output ONE valid JSON object only: no markdown, no commentary. Keep all content; escape or replace inner double quotes with single quotes; remove trailing commas; close any unclosed strings, arrays or objects.",
      messages: [{ role: "user", content: badText.slice(0, 40000) }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("repair API " + r.status);
  return { text: finalText(j.content || []), usage: usageOf(j) };
}

function addUsage(a, b) {
  return { input: a.input + b.input, output: a.output + b.output, searches: a.searches + b.searches, cost_usd: Number((a.cost_usd + b.cost_usd).toFixed(4)) };
}

function extractJson(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("no JSON in model output");
  return JSON.parse(text.slice(s, e + 1));
}

// ---------- validation + guardrails ----------
const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

export function validate(raw) {
  if (!raw || typeof raw !== "object") throw new Error("not an object");
  if (!LEVELS.includes(raw.level)) throw new Error("bad level");
  if (typeof raw.summary !== "string" || !raw.summary) throw new Error("missing summary");
  const out = {
    generated_at: new Date().toISOString(), // trust our clock, not the model's
    level: raw.level,
    level_changed_from_last_run: false,
    summary: raw.summary,
    events: [],
    connection_assessment: {
      verdict: raw.connection_assessment?.verdict || "unknown",
      confidence: raw.connection_assessment?.confidence || "low",
      reasoning: raw.connection_assessment?.reasoning || "",
      would_change_my_mind: raw.connection_assessment?.would_change_my_mind || "",
    },
    alert: { send: !!raw.alert?.send, headline: raw.alert?.headline || "", reason: raw.alert?.reason || "" },
    prep_note: raw.prep_note || "",
  };
  const seen = new Set();
  for (const ev of Array.isArray(raw.events) ? raw.events : []) {
    const sources = (Array.isArray(ev.sources) ? ev.sources : []).filter((s) => isHttp(s?.url));
    if (!ev.id || !ev.title || seen.has(ev.id)) continue;
    seen.add(ev.id);
    out.events.push({
      id: String(ev.id),
      category: String(ev.category || "other").toLowerCase(),
      title: String(ev.title),
      started_at: ev.started_at || "",
      status: ev.status === "resolved" ? "resolved" : "ongoing",
      impact: ev.impact || "",
      stated_cause: ev.stated_cause || "",
      confirmed: ev.confirmed === true && sources.length > 0, // confirmed needs a real source
      sources,
    });
  }
  // Guardrail: orange/red need at least one confirmed event; otherwise cap at yellow.
  if (RANK[out.level] >= RANK.orange && !out.events.some((e) => e.confirmed)) {
    out.level = "yellow";
    out.guardrail_note = "Level capped at yellow: no confirmed event (needs 2 independent sources or 1 official).";
    out.alert.send = false;
  }
  if (out.level === "green" || (!out.prep_note && out.level === "yellow")) {
    if (out.level === "green") out.prep_note = "";
  }
  return out;
}

// ---------- alert decision (code decides, not the model alone) ----------
export function decideAlert(status, prevLevel, state) {
  const rank = RANK[status.level];
  const confirmed = status.events.filter((e) => e.confirmed);
  const newConfirmed = confirmed.filter((e) => !state.alerted_ids.includes(e.id));
  const newCritical = newConfirmed.filter((e) => CRITICAL.includes(e.category));
  const lastRank = state.last_alert_rank ?? -1;
  // Escalation counts only if it is truly higher than what we last alerted on,
  // and (after a reset) only if there is at least one event we haven't alerted on yet.
  const escalated = rank >= RANK.orange && rank > lastRank && (lastRank >= 0 || newConfirmed.length > 0);
  const modelFlag = status.alert.send && newConfirmed.length > 0;

  let reason = null;
  if (escalated) reason = `level ${status.level.toUpperCase()}`;
  else if (rank >= RANK.orange && newConfirmed.length > 0 && rank >= RANK.orange) reason = "new confirmed event at " + status.level;
  else if (newCritical.length > 0 && rank >= RANK.yellow) reason = "new confirmed critical-sector event";
  else if (modelFlag && rank >= RANK.orange) reason = "analyst flagged";
  if (!reason) return null;
  return {
    reason,
    priority: rank >= RANK.red ? 4 : 3,
    headline: status.alert.headline || status.events.find((e) => e.confirmed)?.title || status.summary.split(".")[0],
    ids: newConfirmed.map((e) => e.id),
  };
}

async function sendPush(alert, level) {
  const topic = ENV.NTFY_TOPIC;
  const title = `Pulse Check heads-up (${level})`;
  const click = ENV.PAGE_URL || "";
  const text = `${alert.headline}${click ? "\n" + click : ""}`;
  if (ENV.NTFY_DRY === "1" || !topic) {
    console.log(`[PUSH${topic ? "" : " (no topic set)"}] p${alert.priority} ${title} | ${text.replace(/\n/g, " ")}`);
    return true;
  }
  const r = await fetch("https://ntfy.sh/" + encodeURIComponent(topic), {
    method: "POST",
    headers: { Title: title, Priority: String(alert.priority), Tags: level === "red" ? "rotating_light" : "warning", ...(click ? { Click: click } : {}) },
    body: text,
  });
  if (!r.ok) throw new Error("ntfy " + r.status);
  return true;
}

async function notifyPlain(title, text, priority = 3) {
  if (ENV.NTFY_DRY === "1" || !ENV.NTFY_TOPIC) { console.log(`[PUSH] p${priority} ${title} | ${text}`); return; }
  await fetch("https://ntfy.sh/" + encodeURIComponent(ENV.NTFY_TOPIC), { method: "POST", headers: { Title: title, Priority: String(priority) }, body: text });
}

// ---------- main ----------
async function main() {
  const prev = readJson(file("status.json"), null);
  const state = readJson(file("state.json"), { alerted_ids: [], last_alert_rank: -1, spend: {}, consecutive_failures: 0, failure_alerted: false });
  const history = readJson(file("history.json"), []);
  const nowIso = new Date().toISOString();

  try {
    let result, usage = { input: 0, output: 0, searches: 0, cost_usd: 0 }, health = [];
    if (fixtureArg) {
      result = JSON.parse(fs.readFileSync(fixtureArg, "utf8"));
    } else {
      if (!ENV.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
      const spentToday = state.spend[today()] || 0;
      if (spentToday >= DAILY_CAP) throw new Error(`daily spend cap reached ($${spentToday.toFixed(2)} >= $${DAILY_CAP})`);
      const feeds = await pullFeeds();
      health = feeds.health;
      const r = await askClaude(prev, feeds.digest);
      usage = r.usage;
      try {
        result = extractJson(r.text);
      } catch (parseErr) {
        console.log("First JSON parse failed (" + parseErr.message + "); trying one repair pass.");
        const fixed = await repairJson(r.text);
        usage = addUsage(usage, fixed.usage);
        result = extractJson(fixed.text);
      }
    }

    const status = validate(result);
    status.level_changed_from_last_run = !!prev && prev.level !== status.level;
    status.run = { model: fixtureArg ? "fixture" : MODEL, ...usage };
    status.source_health = health;

    // spend log
    state.spend[today()] = Number(((state.spend[today()] || 0) + usage.cost_usd).toFixed(4));
    for (const d of Object.keys(state.spend).sort().slice(0, -14)) delete state.spend[d];

    // alerts
    const alert = decideAlert(status, prev?.level, state);
    if (alert) {
      await sendPush(alert, status.level);
      state.alerted_ids = [...new Set([...state.alerted_ids, ...alert.ids])].slice(-300);
      state.last_alert_rank = Math.max(state.last_alert_rank ?? -1, RANK[status.level]);
      status.alert_sent = { at: nowIso, reason: alert.reason };
    }
    if (RANK[status.level] < RANK.orange) state.last_alert_rank = -1; // reset so a later re-escalation alerts again

    state.consecutive_failures = 0;
    state.failure_alerted = false;
    delete status.stale_reason;

    history.push({ t: nowIso, level: status.level });
    writeJson(file("status.json"), status);
    writeJson(file("history.json"), history.slice(-24 * 7));
    writeJson(file("state.json"), state);
    console.log(`OK level=${status.level} events=${status.events.length} cost=$${usage.cost_usd} searches=${usage.searches}`);
  } catch (err) {
    // Failure: keep old data, record failure, ping once after 3 straight.
    state.consecutive_failures = (state.consecutive_failures || 0) + 1;
    if (prev) { prev.stale_reason = String(err.message || err).slice(0, 200); writeJson(file("status.json"), prev); }
    history.push({ t: nowIso, level: "error" });
    writeJson(file("history.json"), history.slice(-24 * 7));
    if (state.consecutive_failures >= 3 && !state.failure_alerted) {
      try { await notifyPlain("Pulse Check is failing", `3 runs in a row failed. Last error: ${String(err.message || err).slice(0, 150)}`, 3); state.failure_alerted = true; } catch {}
    }
    writeJson(file("state.json"), state);
    console.error("RUN FAILED:", err.message || err);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
