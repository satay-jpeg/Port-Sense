// Sensor simulation loop: samples every equipment sensor on a configurable
// interval, detects threshold breaches / abnormal drift, raises alerts, and
// notifies the assigned operator (simulated pager dispatch). Broadcasts every
// tick and alert over SSE so the dashboard updates live.

import { equipment, SENSOR_SPEC, alerts, notificationLog } from "./state.js";

// Set by index.js after boot to avoid a circular import with agent.js.
// Receives operational events so the agent can analyse them unprompted.
let eventSink = null;
export function setEventSink(fn) {
  eventSink = fn;
}

// Autonomous analysis costs a model call, and free tiers are rate-limited
// (~15 req/min on Gemini). Analyse a given machine+sensor at most once every
// few minutes no matter how long it stays in alarm.
const AUTONOMOUS_COOLDOWN_MS = Number(process.env.AUTONOMOUS_COOLDOWN_MS || 5 * 60 * 1000);
const autonomousCooldown = new Map();

const HISTORY_LEN = 60;
let intervalMs = Number(process.env.SENSOR_INTERVAL_MS || 5000);
let timer = null;
let alertSeq = 1;
const sseClients = new Set();

export function getIntervalMs() {
  return intervalMs;
}

export function setIntervalMs(ms) {
  intervalMs = Math.max(1000, Math.min(300000, ms));
  start(); // re-arm with the new cadence
  return intervalMs;
}

export function addClient(res) {
  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// Lets other modules (e.g. the trace layer) push onto the same SSE stream.
export function broadcastTo(event, data) {
  broadcast(event, data);
}

function raiseAlert(eq, sensorKey, value, severity) {
  const spec = SENSOR_SPEC[sensorKey];
  const threshold = severity === "critical" ? spec.crit : spec.warn;
  // Don't spam: one open alert per equipment+sensor, escalate in place
  const existing = alerts.find(
    (a) => a.equipmentId === eq.id && a.sensor === sensorKey && !a.acknowledged
  );
  if (existing) {
    if (existing.severity === severity) {
      existing.value = value;
      return null;
    }
    existing.acknowledged = true; // superseded by escalation
  }
  const alert = {
    id: `AL-${String(alertSeq++).padStart(3, "0")}`,
    time: new Date().toISOString(),
    severity,
    equipmentId: eq.id,
    equipmentType: eq.type,
    sensor: sensorKey,
    sensorLabel: spec.label,
    value: +value.toFixed(1),
    threshold,
    unit: spec.unit,
    message: `${eq.id} ${spec.label.toLowerCase()} at ${value.toFixed(1)} ${spec.unit} (limit ${threshold} ${spec.unit})`,
    operator: eq.operator,
    notified: true,
    acknowledged: false,
  };
  alerts.unshift(alert);
  notificationLog.unshift({
    time: alert.time,
    to: `${eq.operator.name} (${eq.operator.channel})`,
    text: `[${severity.toUpperCase()}] ${alert.message}. Please inspect ${eq.id}.`,
  });
  broadcast("alert", alert);

  // Hand the alert to the agent as an autonomous input. Only critical alerts
  // trigger analysis — warnings would flood the trace and burn free-tier quota.
  // A per-machine cooldown stops a machine that sits above its critical
  // threshold from re-triggering analysis on every sampling tick.
  const cooldownKey = `${eq.id}:${sensorKey}`;
  const lastRun = autonomousCooldown.get(cooldownKey) || 0;
  const cooledDown = Date.now() - lastRun > AUTONOMOUS_COOLDOWN_MS;
  if (eventSink && severity === "critical" && cooledDown) {
    autonomousCooldown.set(cooldownKey, Date.now());
    eventSink({
      triggerType: "operational_alert",
      summary: alert.message,
      detail: {
        alertId: alert.id,
        equipmentId: eq.id,
        equipmentType: eq.type,
        sensor: sensorKey,
        value: alert.value,
        threshold: alert.threshold,
        unit: alert.unit,
        severity,
        operator: eq.operator,
      },
    });
  }
  return alert;
}

function tick() {
  const t = Date.now();
  for (const eq of equipment) {
    let worst = "good";
    for (const [key, spec] of Object.entries(SENSOR_SPEC)) {
      const s = eq.sensors[key];
      // random walk around baseline
      const pull = (spec.baseline - s.value) * 0.08;
      let next = s.value + pull + (Math.random() - 0.5) * 2 * spec.jitter;
      // active fault: steady upward drift on the affected sensor
      if (eq.fault && eq.fault.sensor === key) next += eq.fault.ratePerTick;
      s.value = next;
      s.history.push({ t, v: +next.toFixed(2) });
      if (s.history.length > HISTORY_LEN) s.history.shift();

      if (next >= spec.crit) {
        worst = "critical";
        raiseAlert(eq, key, next, "critical");
      } else if (next >= spec.warn) {
        if (worst !== "critical") worst = "warning";
        raiseAlert(eq, key, next, "warning");
      }
    }
    eq.health = worst;
  }
  broadcast("tick", {
    t,
    intervalMs,
    equipment: equipment.map((e) => ({
      id: e.id,
      health: e.health,
      sensors: Object.fromEntries(
        Object.entries(e.sensors).map(([k, s]) => [k, +s.value.toFixed(1)])
      ),
    })),
  });
}

// Scripted degradations so a live demo always shows the alerting flow:
// RTG-02 develops rising gearbox vibration shortly after startup, and QC-03
// runs slightly hot from the start (produces an early warning).
function scriptFaults() {
  const rtg2 = equipment.find((e) => e.id === "RTG-02");
  const qc3 = equipment.find((e) => e.id === "QC-03");
  // QC-03 runs hot: drift settles ~82 °C, above the 78 °C warning line
  qc3.fault = { sensor: "motorTemp", ratePerTick: 1.6 };
  // RTG-02 gearbox vibration climbs past warning (~4.5) then critical (~7)
  setTimeout(() => {
    rtg2.fault = { sensor: "vibration", ratePerTick: 0.45 };
  }, 20000);
}

export function injectFault(equipmentId, sensorKey = "vibration") {
  const eq = equipment.find((e) => e.id === equipmentId);
  if (!eq || !SENSOR_SPEC[sensorKey]) return false;
  eq.fault = { sensor: sensorKey, ratePerTick: SENSOR_SPEC[sensorKey].jitter * 1.5 };
  return true;
}

export function clearFault(equipmentId) {
  const eq = equipment.find((e) => e.id === equipmentId);
  if (!eq) return false;
  eq.fault = null;
  const spec = eq.sensors;
  for (const [key, s] of Object.entries(spec)) s.value = SENSOR_SPEC[key].baseline;
  return true;
}

export function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, intervalMs);
}

export function boot() {
  // pre-fill 20 readings of history so sparklines aren't empty at load
  for (let i = 0; i < 20; i++) tick();
  scriptFaults();
  start();
}
