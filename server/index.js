import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  vessels, berths, carrierMix, yardSummary, yardStats, optimisationPlan,
  equipment, alerts, notificationLog, SENSOR_SPEC, reshuffleRecommendations, digPlan,
} from "./state.js";
import { boot, addClient, getIntervalMs, setIntervalMs, setEventSink, broadcastTo } from "./simulator.js";
import { ask, handleEvent, getMode, getProviderLabel, resetConversation, sessionCount, rateStatus } from "./agent.js";
import { listEpisodes, getEpisode, setBroadcaster } from "./trace.js";
import { listApprovals, resolveApproval, getApproval, canApprove, SUPERVISOR } from "./approvals.js";
import { setEventSink as setMonitorSink, startMonitors, forceCheck, nudgeEta } from "./monitors.js";
import {
  verifyCredentials, createSession, cookieHeader, currentUser, requireAuth, DEMO_CREDENTIALS,
} from "./auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const app = express();
app.disable("x-powered-by");
app.use(express.json());

// ---- authentication ----
// The login page and its assets are public; the dashboard and every data route
// sit behind a session.
app.get("/login", (req, res) => {
  if (currentUser(req)) return res.redirect("/");
  res.sendFile(path.join(publicDir, "login.html"));
});

app.get("/api/demo-credentials", (req, res) => {
  // Published deliberately: this is a public demo, and judges need a way in.
  res.json(DEMO_CREDENTIALS);
});

app.post("/api/login", (req, res) => {
  const user = verifyCredentials(req.body?.username, req.body?.password);
  if (!user) return res.status(401).json({ error: "Incorrect username or password" });
  res.setHeader("Set-Cookie", cookieHeader(createSession(user)));
  res.json({ ok: true, user });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", cookieHeader("", { clear: true }));
  res.json({ ok: true });
});

app.get("/api/me", requireAuth({ api: true }), (req, res) => {
  res.json({ user: req.user });
});

app.get("/", requireAuth(), (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// Static assets (css/js/login page) stay public; index.html is served only via
// the guarded route above so it can't be fetched around the login.
app.use(express.static(publicDir, { index: false }));

// Every data route requires a session from here on.
app.use("/api", (req, res, next) => {
  if (["/login", "/logout", "/demo-credentials", "/me"].includes(req.path)) return next();
  return requireAuth({ api: true })(req, res, next);
});

// ---- dashboard data ----
app.get("/api/state", (req, res) => {
  res.json({
    mode: getMode(),
    provider: getProviderLabel(),
    user: req.user,
    intervalSeconds: getIntervalMs() / 1000,
    vessels,
    berths,
    carriers: carrierMix(),
    yard: {
      summary: yardSummary(),
      stats: yardStats(),
      plan: optimisationPlan(12),
      recommendations: reshuffleRecommendations(12),
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
    trace: listEpisodes(25),
    approvals: listApprovals(),
    supervisor: SUPERVISOR,
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
  res.json({
    ok: true,
    provider: getProviderLabel(),
    sessions: sessionCount(),
    rate: rateStatus(),
    uptime: process.uptime(),
  });
});

// ---- demo triggers ----
// The autonomous inputs are threshold-driven and rate-limited, which is right
// for running but awkward for a presentation. This fires one on cue.
app.post("/api/demo/trigger", (req, res) => {
  const kind = String(req.body?.kind || "").toLowerCase();
  if (kind === "state_change") {
    const v = nudgeEta(req.body?.vessel || "Kota Harmoni", Number(req.body?.hours) || 3);
    if (!v) return res.status(404).json({ error: "vessel not found" });
    forceCheck("state_change");
    return res.json({ ok: true, kind, vessel: v.name, delayHours: v.delayHours });
  }
  if (["process_metric", "event_log"].includes(kind)) {
    return res.json({ ok: forceCheck(kind), kind });
  }
  res.status(400).json({ error: "kind must be state_change, process_metric or event_log" });
});

// ---- execution trace ----
app.get("/api/trace", (req, res) => {
  res.json({ episodes: listEpisodes(Number(req.query.limit) || 25) });
});

app.get("/api/trace/:id", (req, res) => {
  const ep = getEpisode(req.params.id.toUpperCase());
  if (!ep) return res.status(404).json({ error: "episode not found" });
  res.json(ep);
});

// ---- human approvals ----
app.get("/api/approvals", (req, res) => {
  res.json({
    approvals: listApprovals({ includeResolved: req.query.all === "1" }),
    supervisor: SUPERVISOR,
  });
});

app.post("/api/approvals/:id", (req, res) => {
  const decision = String(req.body?.decision || "").toLowerCase();
  if (!["approve", "reject"].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
  }
  const record = getApproval(req.params.id.toUpperCase());
  if (!record) return res.status(404).json({ error: "approval not found" });

  // Authority check happens server-side: hiding the button would not be a control.
  if (decision === "approve") {
    const verdict = canApprove(record, req.user);
    if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
  }

  const out = resolveApproval(req.params.id.toUpperCase(), decision, {
    by: `${req.user.name} (${req.user.role})`,
    reason: req.body?.reason ? String(req.body.reason).slice(0, 200) : null,
    episodeLookup: getEpisode,
  });
  if (out.error) return res.status(409).json(out);
  res.json(out);
});

const PORT = Number(process.env.PORT || 3000);

// Stream trace updates to the dashboard over the existing SSE channel, and let
// the simulator hand operational events to the agent for autonomous analysis.
setBroadcaster(broadcastTo);

// All autonomous inputs — equipment alarms from the simulator, and vessel
// state changes / yard KPI breaches / gate log anomalies from the monitors —
// funnel into the same agent entry point.
const ingest = (event) => {
  handleEvent(event).catch((err) => console.error("[portsense] autonomous event failed:", err));
};
setEventSink(ingest);
setMonitorSink(ingest);

boot();
startMonitors();
app.listen(PORT, () => {
  console.log(`PortSense running on http://localhost:${PORT}`);
  console.log(`Agent provider: ${getProviderLabel()}`);
});
