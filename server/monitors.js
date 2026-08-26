// Autonomous input sources beyond equipment alarms.
//
// The agent is meant to act on whatever the terminal emits, not only on things
// a human types. Alongside operational alerts (raised in simulator.js), three
// further classes of input are produced here:
//
//   state_change   — a vessel's predicted ETA moves enough to threaten its berth slot
//   process_metric — a yard KPI crosses an operating threshold
//   event_log      — a batch of gate transactions containing an anomaly
//
// Each check is threshold-driven and rate-limited: a model call costs free-tier
// quota, so these fire on genuine change rather than on a timer.

import { vessels, berths, yardStats, optimisationPlan } from "./state.js";

const MIN = 60 * 1000;

let sink = null;
export function setEventSink(fn) { sink = fn; }

// Per-check cooldowns. Deliberately long — these are advisory signals, and a
// demo that floods the trace is harder to read, not more impressive.
const COOLDOWN = {
  state_change: Number(process.env.MONITOR_COOLDOWN_MS || 6 * MIN),
  process_metric: Number(process.env.MONITOR_COOLDOWN_MS || 8 * MIN),
  event_log: Number(process.env.MONITOR_COOLDOWN_MS || 10 * MIN),
};
const lastFired = {};

function ready(kind) {
  const last = lastFired[kind] || 0;
  if (Date.now() - last < COOLDOWN[kind]) return false;
  lastFired[kind] = Date.now();
  return true;
}

function emit(event) {
  if (sink) sink(event);
}

// ── 1. state_change ────────────────────────────────────────────────────────
// A vessel's ETA drifts. Matters because berth windows are pre-allocated: if a
// vessel slips past its slot, the berth either idles or the next arrival is
// pushed. Fires when the drift is large enough to threaten the plan.

const etaBaseline = new Map(vessels.map((v) => [v.id, v.delayHours]));

function checkEtaDrift() {
  for (const v of vessels) {
    const before = etaBaseline.get(v.id) ?? v.delayHours;
    const drift = +(v.delayHours - before).toFixed(1);
    if (Math.abs(drift) < 1.5) continue;
    etaBaseline.set(v.id, v.delayHours);
    if (!ready("state_change")) return;

    const berth = berths.find((b) => b.id === v.berth);
    emit({
      triggerType: "state_change",
      summary: `${v.name} ETA revised by ${drift > 0 ? "+" : ""}${drift}h — now ${v.delayHours > 0 ? `${v.delayHours}h late` : "on schedule"}`,
      detail: {
        vessel: v.name, vesselId: v.id, driftHours: drift,
        delayHours: v.delayHours, berth: v.berth,
        berthStatus: berth ? berth.status : "unknown",
        confidence: v.confidence,
        severity: Math.abs(drift) >= 4 ? "critical" : "warning",
      },
    });
    return; // one at a time — keep the trace legible
  }
}

// ── 2. process_metric ──────────────────────────────────────────────────────
// Yard KPIs. Utilisation above ~85% means rehandles climb sharply because
// there is nowhere to place a dug-out box; a large projected rehandle count
// means the next shift starts behind.

function checkYardMetrics() {
  const s = yardStats();
  const plan = optimisationPlan(12);
  const breaches = [];
  if (s.utilisationPct >= 85) breaches.push(`utilisation ${s.utilisationPct}% (limit 85%)`);
  if (plan.currentRehandles >= 25) breaches.push(`${plan.currentRehandles} rehandles projected in the next 12h (limit 25)`);
  if (s.urgentDepartures >= 20) breaches.push(`${s.urgentDepartures} containers due within 12h (limit 20)`);
  if (!breaches.length || !ready("process_metric")) return;

  emit({
    triggerType: "process_metric",
    summary: `Yard KPI threshold breached — ${breaches.join("; ")}`,
    detail: {
      utilisationPct: s.utilisationPct,
      containersInYard: s.containersInYard,
      urgentDepartures: s.urgentDepartures,
      projectedRehandles: plan.currentRehandles,
      avoidableRehandles: plan.rehandlesSaved,
      severity: s.utilisationPct >= 92 ? "critical" : "warning",
    },
  });
}

// ── 3. event_log ───────────────────────────────────────────────────────────
// Gate transactions from the terminal operating system. Real logs are noisy;
// the agent's job is to notice the line that matters — here, a truck turnaround
// time well outside the normal band, which signals a gate or yard bottleneck.

const GATE_LANES = ["GATE-IN-1", "GATE-IN-2", "GATE-OUT-1", "GATE-OUT-2"];
let gateSeq = 4100;

function checkGateLog({ force = false } = {}) {
  // Sample a batch of transactions the way a log scraper would.
  const batch = Array.from({ length: 8 }, () => {
    const lane = GATE_LANES[Math.floor(Math.random() * GATE_LANES.length)];
    const turnaroundMin = 18 + Math.round(Math.random() * 14);
    return { txn: `TXN-${gateSeq++}`, lane, turnaroundMin };
  });
  // Most batches are clean — that is the point, the agent has to find the one
  // that matters. A forced (demo) check always plants one so it has something
  // to find on cue.
  if (force || Math.random() < 0.5) {
    batch[Math.floor(Math.random() * batch.length)].turnaroundMin = 61 + Math.round(Math.random() * 20);
  }

  const slow = batch.filter((t) => t.turnaroundMin > 45);
  if (!slow.length || !ready("event_log")) return false;

  const worst = slow.sort((a, b) => b.turnaroundMin - a.turnaroundMin)[0];
  emit({
    triggerType: "event_log",
    summary: `Gate log anomaly — ${worst.lane} truck turnaround ${worst.turnaroundMin} min (normal 18–32 min)`,
    detail: {
      lane: worst.lane,
      transaction: worst.txn,
      turnaroundMin: worst.turnaroundMin,
      normalRangeMin: [18, 32],
      affectedTransactions: slow.length,
      batchSize: batch.length,
      severity: worst.turnaroundMin > 70 ? "critical" : "warning",
    },
  });
  return true;
}

let timer = null;

export function startMonitors() {
  if (timer) clearInterval(timer);
  // Evaluate on a slow cadence; the cooldowns above decide what actually fires.
  timer = setInterval(() => {
    try {
      checkEtaDrift();
      checkYardMetrics();
      checkGateLog();
    } catch (err) {
      console.error("[portsense] monitor error:", err.message);
    }
  }, Number(process.env.MONITOR_INTERVAL_MS || 30 * 1000));
}

// Nudge a vessel's ETA so the state_change path is demonstrable on request
// (used by the demo endpoint, not by the simulation itself).
export function nudgeEta(vesselName, hours = 3) {
  const v = vessels.find((x) => x.name.toLowerCase().includes(String(vesselName || "").toLowerCase()));
  if (!v) return null;
  v.delayHours = +(v.delayHours + hours).toFixed(1);
  v.predictedEta = new Date(new Date(v.scheduledEta).getTime() + v.delayHours * 3600 * 1000).toISOString();
  v.confidence = +Math.max(0.6, v.confidence - 0.05).toFixed(2);
  return v;
}

// Force a specific monitor to fire now, bypassing its cooldown. Exposed for
// demonstrations so all five input classes can be shown without waiting.
// Returns whether an episode was actually emitted, not merely that the check
// ran — a check can legitimately find nothing worth reporting.
export function forceCheck(kind) {
  lastFired[kind] = 0;
  if (kind === "state_change") return checkEtaDrift() !== false;
  if (kind === "process_metric") return checkYardMetrics() !== false;
  if (kind === "event_log") return checkGateLog({ force: true }) !== false;
  return false;
}
