/* PortSense dashboard — vanilla JS, no build step. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Stable per-browser id so several people using the same deployed instance
// each get their own conversation thread.
const SESSION_ID = (() => {
  const KEY = "portsense-session";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now());
    localStorage.setItem(KEY, id);
  }
  return id;
})();

let state = null; // last /api/state payload
const HISTORY_CAP = 60;

/* ---------------- utilities ---------------- */

function fmtTime(iso) {
  return new Date(iso).toLocaleString("en-SG", {
    weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) node.append(c);
  return node;
}

function statusChip(kind, label) {
  return el("span", { class: `chip-status ${kind}`, text: label });
}

/* ---------------- tabs ---------------- */

function switchView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
}
$$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

/* ---------------- sparkline (SVG, 2px line, hover tooltip) ---------------- */

const tooltip = $("#tooltip");

function sparkline(values, { warn, crit, unit }) {
  const w = 200, h = 30, pad = 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "spark");
  svg.setAttribute("preserveAspectRatio", "none");
  if (!values.length) return svg;

  const min = Math.min(...values, warn * 0.7);
  const max = Math.max(...values, crit * 1.05);
  const x = (i) => pad + (i / Math.max(values.length - 1, 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);

  // threshold hairlines (recessive)
  for (const [lv, color] of [[warn, "var(--status-warning)"], [crit, "var(--status-critical)"]]) {
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", pad); line.setAttribute("x2", w - pad);
    line.setAttribute("y1", y(lv)); line.setAttribute("y2", y(lv));
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "1");
    line.setAttribute("stroke-dasharray", "3 4");
    line.setAttribute("opacity", "0.45");
    svg.append(line);
  }

  const path = document.createElementNS(svg.namespaceURI, "polyline");
  path.setAttribute("points", values.map((v, i) => `${x(i)},${y(v)}`).join(" "));
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "var(--series-1)");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(path);

  // hover: nearest reading in a tooltip
  svg.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const idx = Math.round(((ev.clientX - rect.left) / rect.width) * (values.length - 1));
    const v = values[Math.max(0, Math.min(values.length - 1, idx))];
    tooltip.hidden = false;
    tooltip.textContent = `${v} ${unit}`;
    tooltip.style.left = `${ev.clientX + 12}px`;
    tooltip.style.top = `${ev.clientY - 28}px`;
  });
  svg.addEventListener("mouseleave", () => { tooltip.hidden = true; });
  return svg;
}

/* ---------------- vessel arrivals ---------------- */

function renderVessels() {
  const tbody = $("#vessel-table tbody");
  tbody.replaceChildren();
  for (const v of state.vessels) {
    const variance =
      v.delayHours > 1 ? statusChip(v.delayHours > 6 ? "critical" : "warning", `+${v.delayHours} h late`)
      : v.delayHours < -0.5 ? statusChip("early", `${Math.abs(v.delayHours)} h early`)
      : statusChip("good", "On time");
    tbody.append(el("tr", {}, [
      el("td", { class: "strong", text: v.name }),
      el("td", { text: v.service }),
      el("td", { text: v.berth }),
      el("td", { text: fmtTime(v.scheduledEta) }),
      el("td", { text: fmtTime(v.predictedEta) }),
      el("td", {}, [variance]),
      el("td", { text: `${Math.round(v.confidence * 100)}%` }),
    ]));
  }

  const factors = $("#delay-factors");
  factors.replaceChildren();
  const atRisk = state.vessels.filter((v) => v.delayFactors && v.delayFactors.length);
  if (!atRisk.length) {
    factors.append(el("p", { class: "empty", text: "No delay drivers identified — all vessels tracking to schedule." }));
  }
  for (const v of atRisk) {
    factors.append(el("div", { class: "factor-card" }, [
      el("h3", { text: `${v.name} · +${v.delayHours} h` }),
      el("ul", {}, v.delayFactors.map((f) =>
        el("li", {}, [el("span", { text: f.factor }), el("b", { text: `+${f.impactHours} h` })])
      )),
    ]));
  }
}

/* ---------------- yard ---------------- */

function renderYard() {
  const grid = $("#yard-blocks");
  grid.replaceChildren();
  for (const b of state.yard.summary) {
    const bays = state.yard.blocks[b.block] || [];
    grid.append(el("div", { class: "block-card" }, [
      el("h3", {}, [
        el("span", { class: "strong", text: `Block ${b.block}` }),
        el("span", { text: `${b.containers}/${b.capacity} · ${b.utilisationPct}%` }),
      ]),
      el("div", { class: "meter" }, [el("div", { style: `width:${b.utilisationPct}%` })]),
      el("div", { class: "stacks", title: "Stack heights per bay" },
        bays.map((height) => el("div", { class: "bay" },
          Array.from({ length: height }, () => el("div", { class: "tier" }))
        ))
      ),
    ]));
  }

  const list = $("#reshuffle-list");
  list.replaceChildren();
  if (!state.yard.recommendations.length) {
    list.append(el("p", { class: "empty", text: "No buried containers due soon — nothing to pre-shuffle." }));
  }
  for (const r of state.yard.recommendations) {
    list.append(el("div", { class: "rec-card" }, [
      el("div", { class: "rec-main" }, [
        el("b", { text: `${r.container} — ${r.location}` }),
        el("span", { text: `For ${r.vessel} · retrieval ${fmtTime(r.retrievalEta)}` }),
      ]),
      el("div", { class: "rec-meta" }, [
        el("span", { class: r.dueInHours <= 4 ? "due-soon" : "", text: `due in ${r.dueInHours} h` }),
        el("span", { text: `buried under ${r.buriedUnder}` }),
        el("span", { text: `saves ~${r.craneMinutesSavedIfPreShuffled} crane-min` }),
        el("button", { class: "btn", text: "Plan dig-out", onclick: () => showDigPlan(r.container) }),
      ]),
    ]));
  }
}

async function showDigPlan(containerId) {
  const res = await fetch(`/api/dig-plan/${containerId}`);
  if (!res.ok) return;
  const plan = await res.json();
  const panel = $("#dig-panel");
  panel.hidden = false;
  $("#dig-title").textContent = `Dig-out plan — ${plan.target.id}`;
  $("#dig-sub").textContent =
    `${plan.digMoves} relocation${plan.digMoves === 1 ? "" : "s"} needed · est. ${plan.estimatedMinutes} min crane time`;

  // stack visual: target bay with blocking boxes highlighted
  const visual = $("#dig-visual");
  visual.replaceChildren();
  const stackWrap = el("div", { class: "dig-stack" });
  const blocking = new Set(plan.relocations.map((m) => m.container));
  // rebuild the stack from target tier info: boxes above target are the relocations
  const boxes = [
    ...Array.from({ length: plan.target.tier - 1 }, (_, i) => ({ id: `tier ${i + 1}`, cls: "" })),
    { id: plan.target.id, cls: "target" },
    ...plan.relocations.slice().reverse().map((m) => ({ id: m.container, cls: "blocking" })),
  ];
  for (const b of boxes) stackWrap.append(el("div", { class: `box ${b.cls}`, text: b.id }));
  const labeled = el("div", {}, [stackWrap, el("div", { class: "label", text: `Bay ${plan.target.block}${String(plan.target.bay).padStart(2, "0")}` })]);
  visual.append(labeled);

  const steps = $("#dig-steps");
  steps.replaceChildren();
  for (const m of plan.relocations) {
    steps.append(el("li", { text: `Move ${m.container} from ${m.from} to ${m.to}` }));
  }
  if (!plan.relocations.length) {
    steps.append(el("li", { text: "Container is on top of its stack — direct pick, no digging required." }));
  }
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------------- equipment ---------------- */

const HEALTH_LABEL = { good: "Healthy", warning: "Warning", critical: "Critical" };

function renderEquipment() {
  const grid = $("#equipment-grid");
  grid.replaceChildren();
  for (const eq of state.equipment) {
    const card = el("div", { class: `eq-card ${eq.health}`, id: `eq-${eq.id}` }, [
      el("div", { class: "eq-head" }, [
        el("h3", { text: `${eq.id} · ${eq.type}` }),
        statusChip(eq.health, HEALTH_LABEL[eq.health]),
      ]),
      el("p", { class: "eq-sub", text: `Operator ${eq.operator.name} (${eq.operator.channel}) · utilisation ${eq.utilisationPct}% · serviced ${eq.lastServiceDays} d ago` }),
    ]);
    for (const [key, s] of Object.entries(eq.sensors)) {
      const valueCls = s.value >= s.crit ? "crit" : s.value >= s.warn ? "warn" : "";
      card.append(el("div", { class: "sensor-row", "data-sensor": key }, [
        el("span", { class: "s-label", text: s.label }),
        sparkline(s.history, s),
        el("span", { class: `s-value ${valueCls}`, text: `${s.value} ${s.unit}` }),
      ]));
    }
    grid.append(card);
  }
}

/* ---------------- alerts ---------------- */

function renderAlerts() {
  const list = $("#alert-list");
  list.replaceChildren();
  const active = state.alerts.filter((a) => !a.acknowledged);
  const badge = $("#alert-badge");
  badge.hidden = active.length === 0;
  badge.textContent = active.length;

  if (!state.alerts.length) {
    list.append(el("p", { class: "empty", text: "No alerts — all sensors within thresholds." }));
  }
  for (const a of state.alerts.slice(0, 20)) {
    list.append(el("div", { class: `alert-card ${a.severity} ${a.acknowledged ? "acknowledged" : ""}` }, [
      el("div", { class: "alert-main" }, [
        el("b", {}, [statusChip(a.severity === "critical" ? "critical" : "warning", a.severity.toUpperCase()), ` ${a.id} · ${a.message}`]),
        el("span", { text: `${fmtTime(a.time)} · ${a.operator.name} notified via ${a.operator.channel}` }),
      ]),
      a.acknowledged
        ? el("span", { class: "empty", text: "acknowledged" })
        : el("button", { class: "btn", text: "Acknowledge", onclick: async () => {
            await fetch(`/api/alerts/${a.id}/ack`, { method: "POST" });
            a.acknowledged = true;
            renderAlerts();
          } }),
    ]));
  }

  const notif = $("#notif-list");
  notif.replaceChildren();
  for (const n of state.notifications) {
    notif.append(el("li", {}, [
      el("time", { text: new Date(n.time).toLocaleTimeString("en-SG", { hour12: false }) }),
      el("b", { text: n.to }), `: ${n.text}`,
    ]));
  }
  if (!state.notifications.length) notif.append(el("li", { class: "empty", text: "No notifications dispatched yet." }));
}

/* ---------------- approvals & execution trace ---------------- */

const TRIGGER_LABEL = {
  user_request: "operator request",
  operational_alert: "operational alert",
  state_change: "state change",
  process_metric: "process metric",
  event_log: "event log",
};

const STEP_LABEL = {
  input: "input", analysis: "analysis", plan: "plan",
  tool_call: "tool call", tool_result: "result", tool_error: "tool error",
  uncertainty: "uncertainty", clarification: "clarification",
  approval_required: "approval req", approval_granted: "approved", approval_denied: "rejected",
  action: "action", escalation: "escalation", fallback: "fallback",
  outcome: "outcome", error: "error",
};

const openEpisodes = new Set(); // ids the user expanded — preserved across re-renders

function hhmmss(iso) {
  return new Date(iso).toLocaleTimeString("en-SG", { hour12: false });
}

async function decideApproval(id, decision) {
  await fetch(`/api/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, by: "operator" }),
  });
  await refreshState();
  switchView("trace");
}

function renderApprovals() {
  const list = $("#approval-list");
  list.replaceChildren();
  const pending = state.approvals || [];
  const badge = $("#approval-badge");
  badge.hidden = pending.length === 0;
  badge.textContent = pending.length;
  if (state.supervisor) $("#supervisor-name").textContent = `${state.supervisor.name} (${state.supervisor.channel})`;

  if (!pending.length) {
    list.append(el("p", { class: "empty", text: "No actions awaiting approval. Read-only queries run without a gate; anything that changes terminal state appears here first." }));
    return;
  }
  for (const a of pending) {
    list.append(el("div", { class: `approval-card ${a.risk}` }, [
      el("div", { class: "approval-main" }, [
        el("b", { text: `${a.id} · ${a.description}` }),
        el("span", { class: "why", text: a.why }),
      ]),
      el("div", { class: "approval-meta" }, [
        el("span", { class: `risk-tag ${a.risk}`, text: `${a.risk} risk` }),
        el("button", { class: "btn approve", text: "Approve", onclick: () => decideApproval(a.id, "approve") }),
        el("button", { class: "btn reject", text: "Reject", onclick: () => decideApproval(a.id, "reject") }),
      ]),
    ]));
  }
}

function renderTrace() {
  const list = $("#trace-list");
  list.replaceChildren();
  const episodes = state.trace || [];
  if (!episodes.length) {
    list.append(el("p", { class: "empty", text: "No episodes yet. Ask the agent a question, or wait for an equipment alert to trigger autonomous analysis." }));
    return;
  }
  for (const ep of episodes) {
    const card = el("div", { class: `trace-card ${openEpisodes.has(ep.id) ? "open" : ""}` });
    const head = el("div", { class: "trace-head" }, [
      el("span", { class: "tid", text: ep.id }),
      el("span", { class: `trigger-tag ${ep.triggerType}`, text: TRIGGER_LABEL[ep.triggerType] || ep.triggerType }),
      el("span", { class: "tsummary", text: ep.summary.slice(0, 120) }),
      el("span", { class: `trace-status ${ep.status}`, text: ep.status.replace(/_/g, " ") }),
      el("span", { class: "tid", text: `${ep.steps.length} steps` }),
    ]);
    head.addEventListener("click", () => {
      if (openEpisodes.has(ep.id)) openEpisodes.delete(ep.id);
      else openEpisodes.add(ep.id);
      renderTrace();
    });
    const steps = el("div", { class: "trace-steps" },
      ep.steps.map((s) => el("div", { class: `step ${s.type}` }, [
        el("span", { class: "st-time", text: hhmmss(s.t) }),
        el("span", { class: "st-kind", text: STEP_LABEL[s.type] || s.type }),
        el("span", { class: "st-text", text: s.summary }),
      ]))
    );
    card.append(head, steps);
    list.append(card);
  }
}

/* ---------------- toasts ---------------- */

function toast(alert) {
  const stack = $("#toast-stack");
  const t = el("div", { class: `toast ${alert.severity}` }, [
    el("b", { text: `${alert.severity === "critical" ? "🚨" : "⚠️"} ${alert.id}: ` }),
    `${alert.message} — ${alert.operator.name} paged.`,
  ]);
  stack.append(t);
  setTimeout(() => t.remove(), 8000);
}

/* ---------------- mode & interval ---------------- */

function renderMode(mode, providerLabel) {
  const pill = $("#mode-pill");
  pill.classList.remove("ai", "rules");
  if (mode === "ai") {
    pill.classList.add("ai");
    pill.textContent = `agent: ${providerLabel || "live"}`;
  } else if (mode === "rules") {
    pill.classList.add("rules");
    pill.textContent = `agent: ${providerLabel || "rule-based (no API key)"}`;
  } else {
    pill.textContent = "agent: detecting…";
  }
}

function renderInterval(seconds) {
  $("#interval-pill").textContent = `sensors: every ${seconds}s`;
  const input = $("#interval-input");
  if (document.activeElement !== input) input.value = seconds;
}

$("#interval-apply").addEventListener("click", async () => {
  const seconds = Number($("#interval-input").value);
  if (!seconds) return;
  const res = await fetch("/api/interval", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seconds }),
  });
  const data = await res.json();
  renderInterval(data.intervalSeconds);
});

/* ---------------- chat ---------------- */

const chatLog = $("#chat-log");
const chatForm = $("#chat-form");
const chatText = $("#chat-text");

function addMessage(role, text) {
  const m = el("div", { class: `msg ${role}`, text });
  chatLog.append(m);
  chatLog.scrollTop = chatLog.scrollHeight;
  return m;
}

const VIEW_LABEL = { arrivals: "Vessel Arrivals", yard: "Yard Reshuffling", equipment: "Equipment Health", alerts: "Alerts" };

async function sendQuestion(q) {
  addMessage("user", q);
  const pending = addMessage("agent thinking", "Thinking…");
  $("#chat-send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
      body: JSON.stringify({ message: q }),
    });
    const data = await res.json();
    pending.remove();
    if (data.error) {
      addMessage("agent", `Sorry — ${data.detail || data.error}`);
    } else {
      const m = addMessage("agent", data.text);
      if (data.view) {
        m.append(el("span", { class: "view-note", text: `↳ showing ${VIEW_LABEL[data.view]}` }));
        await refreshState();          // tools may have mutated state (ack, interval…)
        switchView(data.view);
      }
      renderMode(data.mode, data.provider);
    }
  } catch (err) {
    pending.remove();
    addMessage("agent", `Connection error: ${err.message}`);
  } finally {
    $("#chat-send").disabled = false;
    chatText.focus();
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = chatText.value.trim();
  if (!q) return;
  chatText.value = "";
  sendQuestion(q);
});

$$(".chip[data-q]").forEach((c) => c.addEventListener("click", () => sendQuestion(c.dataset.q)));

/* ---------------- live stream ---------------- */

function connectStream() {
  const es = new EventSource("/api/stream");
  es.addEventListener("tick", (ev) => {
    if (!state) return;
    const data = JSON.parse(ev.data);
    renderInterval(data.intervalMs / 1000);
    for (const upd of data.equipment) {
      const eq = state.equipment.find((e) => e.id === upd.id);
      if (!eq) continue;
      eq.health = upd.health;
      for (const [k, v] of Object.entries(upd.sensors)) {
        eq.sensors[k].value = v;
        eq.sensors[k].history.push(v);
        if (eq.sensors[k].history.length > HISTORY_CAP) eq.sensors[k].history.shift();
      }
    }
    if ($("#view-equipment").classList.contains("active")) renderEquipment();
  });
  // Trace episodes stream in live — including ones the agent starts on its own
  // in response to equipment alerts, with no operator involvement.
  es.addEventListener("trace", (ev) => {
    if (!state) return;
    const ep = JSON.parse(ev.data);
    const list = state.trace || (state.trace = []);
    const idx = list.findIndex((e) => e.id === ep.id);
    if (idx >= 0) list[idx] = ep;
    else list.unshift(ep);
    if (ep.status === "awaiting_approval") {
      // A proposal just landed — refresh so the approval card appears.
      fetch("/api/approvals").then((r) => r.json()).then((d) => {
        state.approvals = d.approvals;
        state.supervisor = d.supervisor;
        renderApprovals();
      });
    }
    renderTrace();
  });
  es.addEventListener("alert", (ev) => {
    const alert = JSON.parse(ev.data);
    if (state) {
      state.alerts.unshift(alert);
      state.notifications.unshift({
        time: alert.time,
        to: `${alert.operator.name} (${alert.operator.channel})`,
        text: alert.message,
      });
      renderAlerts();
      if ($("#view-equipment").classList.contains("active")) renderEquipment();
    }
    toast(alert);
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectStream, 3000);
  };
}

/* ---------------- boot ---------------- */

async function refreshState() {
  const res = await fetch("/api/state");
  state = await res.json();
  renderVessels();
  renderYard();
  renderEquipment();
  renderAlerts();
  renderApprovals();
  renderTrace();
  renderInterval(state.intervalSeconds);
  renderMode(state.mode, state.provider);
}

setInterval(() => {
  $("#clock").textContent = new Date().toLocaleString("en-SG", {
    weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}, 1000);

refreshState().then(connectStream);
