import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vessels, yardSummary, equipment, alerts, notificationLog, SENSOR_SPEC, yard, reshuffleRecommendations, digPlan } from "./state.js";
import { boot, addClient, getIntervalMs, setIntervalMs } from "./simulator.js";
import { ask, getMode, getProviderLabel, resetConversation, sessionCount } from "./agent.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(here, "..", "public")));

// ---- dashboard data ----
app.get("/api/state", (req, res) => {
  res.json({
    mode: getMode(),
    provider: getProviderLabel(),
    intervalSeconds: getIntervalMs() / 1000,
    vessels,
    yard: {
      summary: yardSummary(),
      recommendations: reshuffleRecommendations(12),
      blocks: Object.fromEntries(
        Object.entries(yard.blocks).map(([k, b]) => [k, b.bays.map((s) => s.length)])
      ),
    },
    equipment: equipment.map((e) => ({
      id: e.id,
      type: e.type,
      health: e.health,
      operator: e.operator,
      utilisationPct: e.utilisationPct,
      lastServiceDays: e.lastServiceDays,
      sensors: Object.fromEntries(
        Object.entries(e.sensors).map(([k, s]) => [k, {
          ...SENSOR_SPEC[k],
          value: +s.value.toFixed(1),
          history: s.history.map((h) => h.v),
        }])
      ),
    })),
    alerts,
    notifications: notificationLog.slice(0, 12),
  });
});

app.get("/api/dig-plan/:id", (req, res) => {
  const plan = digPlan(req.params.id.toUpperCase());
  if (!plan) return res.status(404).json({ error: "container not found" });
  res.json(plan);
});

app.post("/api/interval", (req, res) => {
  const seconds = Number(req.body?.seconds);
  if (!Number.isFinite(seconds)) return res.status(400).json({ error: "seconds required" });
  const ms = setIntervalMs(seconds * 1000);
  res.json({ intervalSeconds: ms / 1000 });
});

app.post("/api/alerts/:id/ack", (req, res) => {
  const a = alerts.find((x) => x.id === req.params.id.toUpperCase());
  if (!a) return res.status(404).json({ error: "alert not found" });
  a.acknowledged = true;
  res.json({ ok: true });
});

// ---- live sensor stream ----
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: {"intervalMs": ${getIntervalMs()}}\n\n`);
  addClient(res);
});

// ---- agent chat ----
// Each browser sends its own session id so concurrent visitors (e.g. several
// judges on one deployed instance) never share a conversation thread.
function sessionIdOf(req) {
  return String(req.get("x-session-id") || "default").slice(0, 64);
}

app.post("/api/chat", async (req, res) => {
  const question = String(req.body?.message || "").slice(0, 2000).trim();
  if (!question) return res.status(400).json({ error: "message required" });
  try {
    const answer = await ask(question, sessionIdOf(req));
    res.json(answer);
  } catch (err) {
    console.error("[portsense] chat error:", err);
    res.status(500).json({ error: "agent failed", detail: String(err.message || err) });
  }
});

app.post("/api/chat/reset", (req, res) => {
  resetConversation(sessionIdOf(req));
  res.json({ ok: true });
});

// Health probe for uptime pingers (keeps a free-tier instance from idling).
app.get("/healthz", (req, res) => {
  res.json({ ok: true, provider: getProviderLabel(), sessions: sessionCount(), uptime: process.uptime() });
});

const PORT = Number(process.env.PORT || 3000);
boot();
app.listen(PORT, () => {
  console.log(`PortSense running on http://localhost:${PORT}`);
  console.log(`Agent provider: ${getProviderLabel()}`);
});
