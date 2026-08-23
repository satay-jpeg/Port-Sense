/* PortSense dashboard — vanilla JS, no build step. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let state = null;
const HISTORY_CAP = 60;

// Stable per-browser id so concurrent users get separate agent conversations.
const SESSION_ID = (() => {
  const KEY = "portsense-session";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now();
    localStorage.setItem(KEY, id);
  }
  return id;
})();

/* ── helpers ─────────────────────────────────────────────────────────────── */

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== false) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null && c !== false) n.append(c);
  return n;
}

function svg(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

// Inline 16px stroke icons (no emoji — they render inconsistently and read as
// unprofessional in an ops console).
const ICON = {
  ship: '<path d="M3 17l1.8-6.5A1 1 0 0 1 5.8 10h12.4a1 1 0 0 1 1 .5L21 17"/><path d="M2 20c1.5 0 1.5-1.2 3-1.2S6.5 20 8 20s1.5-1.2 3-1.2S12.5 20 14 20s1.5-1.2 3-1.2S18.5 20 20 20"/><path d="M12 10V5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  box: '<path d="M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  trend: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
  fuel: '<path d="M3 22h12V4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"/><path d="M15 9h3a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V9l-3-3"/><path d="M6 8h6"/>',
  dollar: '<path d="M12 2v20"/><path d="M17 7a4 4 0 0 0-4-3h-2a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-2a4 4 0 0 1-4-3"/>',
  anchor: '<circle cx="12" cy="5" r="3"/><path d="M12 22V8"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6"/>',
};

function icon(name, size = 14, cls = "") {
  const s = svg("svg", {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", "stroke-width": "1.8",
    "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true",
  });
  if (cls) s.setAttribute("class", cls);
  s.innerHTML = ICON[name] || "";
  return s;
}

const fmtDT = (iso) => new Date(iso).toLocaleString("en-SG", {
  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
const fmtT = (iso) => new Date(iso).toLocaleTimeString("en-SG", { hour12: false });
const num = (n) => n.toLocaleString("en-SG");

function pill(kind, text) { return el("span", { class: `pill ${kind}`, text }); }

function stat({ label, value, unit, delta, deltaDir, tone, iconName }) {
  return el("div", { class: `stat ${tone || ""}` }, [
    el("div", { class: "label" }, [iconName ? icon(iconName, 12) : null, el("span", { text: label })]),
    el("div", { class: "value" }, [
      document.createTextNode(value),
      unit ? el("small", { text: unit }) : null,
    ]),
    delta ? el("div", { class: `delta ${deltaDir || ""}`, text: delta }) : null,
  ]);
}

/* ── tabs ────────────────────────────────────────────────────────────────── */

function switchView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
}
$$(".tab").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));

/* ── arrivals ────────────────────────────────────────────────────────────── */

const STATUS_PILL = {
  BERTHED: ["ok", "Berthed"],
  APPROACHING: ["info", "Approaching"],
  ANCHORED: ["warn", "Anchored"],
  EN_ROUTE: ["plain", "En route"],
};

function renderArrivalStats() {
  const v = state.vessels;
  const late = v.filter((x) => x.delayHours > 1);
  const worst = [...v].sort((a, b) => b.delayHours - a.delayHours)[0];
  const teu = v.reduce((s, x) => s + x.teu, 0);
  const occupied = state.berths.filter((b) => b.status === "OCCUPIED").length;

  $("#arrival-stats").replaceChildren(
    stat({ label: "Vessels tracked", value: num(v.length), iconName: "ship" }),
    stat({
      label: "Predicted late", value: num(late.length), tone: late.length ? "warning" : "",
      delta: `${Math.round((late.length / v.length) * 100)}% of arrivals`, iconName: "clock",
    }),
    stat({
      label: "Largest variance", value: `+${worst.delayHours}`, unit: "h", tone: "warning",
      delta: worst.name, iconName: "trend",
    }),
    stat({ label: "Berths occupied", value: `${occupied}/${state.berths.length}`, iconName: "anchor" }),
    stat({ label: "TEU inbound", value: num(teu), iconName: "box" }),
  );
}

function renderRadar() {
  const host = $("#radar");
  host.replaceChildren();
  // A 400×300 user-unit space keeps strokes and type finely adjustable: a
  // coarse viewBox (e.g. 100 wide) makes 1 unit ≈ 1% of the width, so labels
  // and dots come out enormous once the SVG is scaled to fill the panel.
  const W = 400, H = 300;
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet" });

  const QX = W / 2, QY = H - 34;   // quay sits centre-bottom; rings radiate from it
  for (const r of [60, 110, 160, 210]) {
    s.append(svg("circle", { cx: QX, cy: QY, r, class: "radar-ring" }));
  }
  s.append(svg("line", { x1: 0, y1: QY, x2: W, y2: QY, class: "radar-cross" }));
  s.append(svg("line", { x1: QX, y1: 16, x2: QX, y2: QY, class: "radar-cross" }));

  s.append(svg("rect", { x: QX - 80, y: QY - 4, width: 160, height: 8, rx: 2, class: "radar-quay" }));
  // Label sits above the quay bar — below it would collide with the legend.
  const q = svg("text", { x: QX, y: QY - 11, "text-anchor": "middle", class: "radar-label" });
  q.textContent = "TERMINAL QUAY";
  s.append(q);

  const tooltip = $("#tip");
  for (const v of state.vessels) {
    // Keep vessels inside the plot area, above the quay line.
    const cx = 30 + (v.x / 100) * (W - 60);
    const cy = 26 + (v.y / 100) * (QY - 52);
    const g = svg("g");
    if (v.status === "BERTHED" || v.status === "APPROACHING") {
      g.append(svg("circle", { cx, cy, r: 13, fill: v.carrierColor, opacity: 0.14 }));
    }
    const dot = svg("circle", {
      cx, cy, r: 5, fill: v.carrierColor, class: "vessel-dot",
      stroke: "rgba(0,0,0,.55)", "stroke-width": 1,
    });
    const show = (ev) => {
      tooltip.hidden = false;
      tooltip.textContent = `${v.name} · ${v.carrierLabel} · ${STATUS_PILL[v.status][1]} · ${num(v.teu)} TEU`;
      tooltip.style.left = `${Math.min(ev.clientX + 12, window.innerWidth - 280)}px`;
      tooltip.style.top = `${ev.clientY - 32}px`;
    };
    dot.addEventListener("mousemove", show);
    dot.addEventListener("mouseleave", () => { tooltip.hidden = true; });
    g.append(dot);

    const label = svg("text", { x: cx, y: cy - 10, "text-anchor": "middle", class: "radar-label" });
    label.textContent = v.name.replace(/^MV /, "");
    g.append(label);
    s.append(g);
  }
  host.append(s);

  const legend = el("div", { class: "radar-legend" });
  for (const c of state.carriers) {
    legend.append(el("span", {}, [
      el("i", { class: "carrier-dot", style: `background:${c.color}` }),
      el("span", { text: c.label }),
    ]));
  }
  host.append(legend);
}

function renderBerths() {
  const host = $("#berths");
  host.replaceChildren();
  for (const b of state.berths) {
    const tone = b.status === "OCCUPIED" ? "bad" : b.status === "RESERVED" ? "warn" : "ok";
    const label = b.status === "OCCUPIED" ? "Occupied" : b.status === "RESERVED" ? "Reserved" : "Free";
    host.append(el("div", { class: "berth" }, [
      el("div", {}, [
        el("div", { class: "bid", text: b.id }),
        el("div", { style: "font-size:10px;color:var(--text-3)", text: b.terminal }),
      ]),
      el("div", {}, [
        el("div", { class: "who", text: b.occupiedBy || b.reservedFor || "Available" }, []),
        el("small", { style: "font-size:10px;color:var(--text-3)", text: `max LOA ${b.maxLength} m` }),
        el("div", { class: `meter ${b.utilisationPct > 70 ? "warn" : "ok"}` }, [
          el("i", { style: `width:${b.utilisationPct}%` }),
        ]),
      ]),
      pill(tone, label),
    ]));
  }
}

function renderCarrierMix() {
  const host = $("#carrier-mix");
  host.replaceChildren();
  const max = Math.max(...state.carriers.map((c) => c.count));
  for (const c of state.carriers) {
    host.append(el("div", { class: "mix-row" }, [
      el("div", { class: "nm" }, [
        el("i", { class: "carrier-dot", style: `background:${c.color}` }),
        el("span", { text: c.label }),
      ]),
      el("div", { class: "mix-bar" }, [
        el("i", { style: `width:${(c.count / max) * 100}%; background:${c.color}` }),
      ]),
      el("div", { class: "amt", text: `${c.count} · ${(c.teu / 1000).toFixed(0)}k` }),
    ]));
  }
}

function renderVessels() {
  const tb = $("#vessel-table tbody");
  tb.replaceChildren();
  for (const v of state.vessels) {
    const variance =
      v.delayHours > 1 ? pill(v.delayHours > 6 ? "bad" : "warn", `+${v.delayHours} h`)
      : v.delayHours < -0.5 ? pill("ok", `${Math.abs(v.delayHours)} h early`)
      : pill("ok", "On time");
    const [tone, label] = STATUS_PILL[v.status] || ["plain", v.status];
    const conf = Math.round(v.confidence * 100);
    tb.append(el("tr", {}, [
      el("td", { class: "strong" }, [
        el("div", { text: v.name }),
        el("span", { class: "sub mono", text: `MMSI ${v.mmsi} · ${v.flag} · ${num(v.teu)} TEU` }),
      ]),
      el("td", {}, [el("span", { style: "display:inline-flex;align-items:center;gap:6px" }, [
        el("i", { class: "carrier-dot", style: `background:${v.carrierColor}` }),
        el("span", { text: v.carrierLabel }),
      ])]),
      el("td", { class: "mono", text: v.berth }),
      el("td", { class: "mono", text: fmtDT(v.scheduledEta) }),
      el("td", { class: "mono", text: fmtDT(v.predictedEta) }),
      el("td", {}, [variance]),
      el("td", { class: "mono", style: conf < 80 ? "color:var(--warning)" : "", text: `${conf}%` }),
      el("td", {}, [pill(tone, label)]),
    ]));
  }
}

function renderFactors() {
  const host = $("#factors");
  host.replaceChildren();
  const risky = state.vessels.filter((v) => v.delayFactors?.length);
  if (!risky.length) return host.append(el("p", { class: "empty", text: "No delay drivers — all vessels tracking to schedule." }));
  for (const v of risky) {
    for (const f of v.delayFactors) {
      host.append(el("div", { class: "factor" }, [
        el("div", {}, [
          el("div", { class: "vs", text: v.name }),
          el("div", { class: "fs", text: f.factor }),
        ]),
        el("div", { class: "imp", text: `+${f.impactHours} h` }),
      ]));
    }
  }
}

/* ── yard ────────────────────────────────────────────────────────────────── */

function renderYardStats() {
  const s = state.yard.stats;
  const p = state.yard.plan;
  $("#yard-stats").replaceChildren(
    stat({ label: "Yard utilisation", value: `${s.utilisationPct}`, unit: "%", iconName: "layers",
      delta: `${num(s.containersInYard)} of ${num(Math.round(s.containersInYard / (s.utilisationPct / 100)))} slots` }),
    stat({ label: "Containers", value: num(s.containersInYard), iconName: "box",
      delta: `${s.reefer} reefer · ${s.hazmat} hazmat` }),
    stat({ label: "Urgent departures", value: num(s.urgentDepartures), tone: "warning", iconName: "clock",
      delta: "due within 12h" }),
    stat({ label: "Rehandles saved", value: num(p.rehandlesSaved), tone: "success", iconName: "trend",
      delta: `${p.currentRehandles} → ${p.optimisedRehandles}`, deltaDir: "up" }),
    stat({ label: "Crane time saved", value: num(p.timeSavedMin), unit: "min", tone: "success", iconName: "clock" }),
    stat({ label: "Fuel saved", value: num(p.fuelSavedL), unit: "L", tone: "success", iconName: "fuel" }),
    stat({ label: "Cost avoided", value: `$${num(p.costSavedUSD)}`, tone: "success", iconName: "dollar" }),
  );
}

function renderYardBlocks() {
  const host = $("#yard-blocks");
  host.replaceChildren();
  for (const b of state.yard.summary) {
    host.append(el("div", { class: "block-card" }, [
      el("header", {}, [
        el("h3", { text: `Block ${b.block}` }),
        el("span", { class: "cap", text: `${b.containers}/${b.capacity} · ${b.utilisationPct}%` }),
      ]),
      el("div", { class: `meter ${b.utilisationPct > 80 ? "warn" : "ok"}` }, [
        el("i", { style: `width:${b.utilisationPct}%` }),
      ]),
      el("div", { class: "bays", title: "Stack height per bay" },
        b.stacks.map((h) => el("div", { class: `bay ${h >= 5 ? "full" : ""}` },
          Array.from({ length: h }, () => el("div", { class: "tier" }))))
      ),
      el("div", { class: "block-tags" }, [
        el("span", { class: "tag" }, [el("i", { style: "background:var(--accent)" }), el("span", { text: `${b.reefer} reefer` })]),
        el("span", { class: "tag" }, [el("i", { style: "background:var(--warning)" }), el("span", { text: `${b.hazmat} hazmat` })]),
        el("span", { class: "tag" }, [el("i", { style: "background:var(--danger)" }), el("span", { text: `${b.urgent} urgent` })]),
      ]),
    ]));
  }
}

function renderMoves() {
  const p = state.yard.plan;
  $("#plan-window").textContent = `next ${p.windowHours}h`;
  $("#plan-sub").textContent =
    `${p.currentRehandles} rehandles if left as-is → ${p.optimisedRehandles} after pre-shuffling. Ranked by rehandles avoided.`;
  const host = $("#moves");
  host.replaceChildren();
  if (!p.moves.length) return host.append(el("p", { class: "empty", text: "No buried containers due soon — the yard is well positioned." }));
  for (const m of p.moves) {
    host.append(el("div", { class: "move" }, [
      el("div", { class: "rank", text: String(m.priority) }),
      el("div", { class: "what" }, [
        el("b", {}, [
          el("span", { text: m.containerId }),
          m.containerType !== "dry" ? el("span", { class: `type-tag ${m.containerType}`, text: m.containerType }) : null,
          el("span", { class: "path" }, [
            el("span", { text: m.from }),
            el("span", { class: "arrow", text: "→" }),
            el("span", { text: m.to }),
          ]),
        ]),
        el("div", { class: "why", text: `${m.reason} · ${m.vessel}, due in ${m.dueInHours}h` }),
      ]),
      el("div", { class: "save" }, [
        document.createTextNode(`−${m.rehandlesAvoided} rehandles`),
        el("small", { text: `${m.timeSavedMin} min · ${m.fuelSavedL} L` }),
      ]),
    ]));
  }
}

async function showDigPlan(id) {
  const res = await fetch(`/api/dig-plan/${id}`);
  if (!res.ok) return;
  const plan = await res.json();
  $("#dig-panel").hidden = false;
  $("#dig-title").textContent = `Dig-out plan · ${plan.target.id}`;
  $("#dig-sub").textContent = `${plan.digMoves} relocation${plan.digMoves === 1 ? "" : "s"} · approx ${plan.estimatedMinutes} min crane time`;

  const stack = el("div", { class: "dig-stack" });
  const boxes = [
    ...Array.from({ length: plan.target.tier - 1 }, (_, i) => ({ id: `tier ${i + 1}`, cls: "" })),
    { id: plan.target.id, cls: "target" },
    ...plan.relocations.slice().reverse().map((m) => ({ id: m.container, cls: "blocking" })),
  ];
  for (const b of boxes) stack.append(el("div", { class: `dig-box ${b.cls}`, text: b.id }));
  $("#dig-visual").replaceChildren(el("div", {}, [
    stack,
    el("div", { style: "font-size:10.5px;color:var(--text-3);text-align:center;margin-top:8px", text: `Bay ${plan.target.block}${String(plan.target.bay).padStart(2, "0")}` }),
  ]));

  const steps = $("#dig-steps");
  steps.replaceChildren();
  plan.relocations.forEach((m, i) => {
    steps.append(el("li", {}, [
      el("span", { class: "n", text: String(i + 1) }),
      el("span", { class: "mono", text: `${m.container}` }),
      el("span", { style: "color:var(--text-3)", text: `${m.from} → ${m.to}` }),
    ]));
  });
  if (!plan.relocations.length) {
    steps.append(el("li", { text: "Container is on top of its stack — direct pick, no digging required." }));
  }
  $("#dig-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ── equipment ───────────────────────────────────────────────────────────── */

const tip = () => $("#tip");

function sparkline(values, s) {
  const w = 200, h = 26, pad = 2;
  const g = svg("svg", { viewBox: `0 0 ${w} ${h}`, class: "spark", preserveAspectRatio: "none" });
  if (!values.length) return g;
  const min = Math.min(...values, s.warn * 0.75);
  const max = Math.max(...values, s.crit * 1.03);
  const X = (i) => pad + (i / Math.max(values.length - 1, 1)) * (w - pad * 2);
  const Y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);

  for (const [lv, col] of [[s.warn, "var(--warning)"], [s.crit, "var(--danger)"]]) {
    g.append(svg("line", {
      x1: pad, x2: w - pad, y1: Y(lv), y2: Y(lv),
      stroke: col, "stroke-width": 1, "stroke-dasharray": "3 4", opacity: 0.4,
    }));
  }
  const last = values[values.length - 1];
  const col = last >= s.crit ? "var(--danger)" : last >= s.warn ? "var(--warning)" : "var(--accent)";
  g.append(svg("polyline", {
    points: values.map((v, i) => `${X(i)},${Y(v)}`).join(" "),
    fill: "none", stroke: col, "stroke-width": 1.6,
    "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke",
  }));

  g.addEventListener("mousemove", (ev) => {
    const r = g.getBoundingClientRect();
    const i = Math.round(((ev.clientX - r.left) / r.width) * (values.length - 1));
    const v = values[Math.max(0, Math.min(values.length - 1, i))];
    const t = tip();
    t.hidden = false;
    t.textContent = `${v} ${s.unit}`;
    t.style.left = `${ev.clientX + 12}px`;
    t.style.top = `${ev.clientY - 28}px`;
  });
  g.addEventListener("mouseleave", () => { tip().hidden = true; });
  return g;
}

const HEALTH = { good: ["ok", "Healthy"], warning: ["warn", "Warning"], critical: ["bad", "Critical"] };

function renderEquipment() {
  const host = $("#equipment");
  host.replaceChildren();
  for (const e of state.equipment) {
    const [tone, label] = HEALTH[e.health];
    const card = el("div", { class: `eq ${e.health}` }, [
      el("header", {}, [el("h3", { text: `${e.id} · ${e.type}` }), pill(tone, label)]),
      el("p", { class: "meta", text: `${e.operator.name} (${e.operator.channel}) · ${e.utilisationPct}% utilisation · serviced ${e.lastServiceDays}d ago` }),
    ]);
    for (const [, s] of Object.entries(e.sensors)) {
      const cls = s.value >= s.crit ? "crit" : s.value >= s.warn ? "warn" : "";
      card.append(el("div", { class: "sensor" }, [
        el("span", { class: "nm", text: s.label }),
        sparkline(s.history, s),
        el("span", { class: `val ${cls}`, text: `${s.value} ${s.unit}` }),
      ]));
    }
    host.append(card);
  }
}

/* ── alerts ──────────────────────────────────────────────────────────────── */

function renderAlerts() {
  const host = $("#alerts");
  host.replaceChildren();
  const active = state.alerts.filter((a) => !a.acknowledged);
  const badge = $("#alert-count");
  badge.hidden = !active.length;
  badge.textContent = active.length;

  if (!state.alerts.length) {
    host.append(el("p", { class: "empty", text: "No alerts — all sensors within thresholds." }));
  }
  for (const a of state.alerts.slice(0, 20)) {
    host.append(el("div", { class: `row ${a.severity} ${a.acknowledged ? "resolved" : ""}` }, [
      el("div", { class: "main" }, [
        el("b", {}, [
          pill(a.severity === "critical" ? "bad" : "warn", a.severity),
          el("span", { class: "mono", text: a.id }),
          el("span", { text: a.message }),
        ]),
        el("span", { text: `${fmtDT(a.time)} · ${a.operator.name} paged via ${a.operator.channel}` }),
      ]),
      el("div", { class: "actions" }, [
        a.acknowledged
          ? el("span", { style: "font-size:11px;color:var(--text-3)", text: "acknowledged" })
          : el("button", {
              class: "btn sm", text: "Acknowledge",
              onclick: async () => {
                await fetch(`/api/alerts/${a.id}/ack`, { method: "POST" });
                a.acknowledged = true;
                renderAlerts();
              },
            }),
      ]),
    ]));
  }

  const nl = $("#notifications");
  nl.replaceChildren();
  for (const n of state.notifications) {
    nl.append(el("li", {}, [
      el("time", { text: fmtT(n.time) }),
      el("span", {}, [el("b", { style: "color:var(--text)", text: n.to }), document.createTextNode(` — ${n.text}`)]),
    ]));
  }
  if (!state.notifications.length) nl.append(el("li", { class: "empty", text: "No notifications dispatched yet." }));
}

/* ── approvals & trace ───────────────────────────────────────────────────── */

const TRIGGER = { user_request: "operator request", operational_alert: "operational alert", state_change: "state change", process_metric: "process metric", event_log: "event log" };
const STEP_LABEL = {
  input: "input", analysis: "analysis", plan: "plan", tool_call: "tool call", tool_result: "result",
  tool_error: "tool error", uncertainty: "uncertainty", clarification: "clarification",
  approval_required: "approval req", approval_granted: "approved", approval_denied: "rejected",
  action: "action", escalation: "escalation", fallback: "fallback", outcome: "outcome", error: "error",
};
const openEps = new Set();

async function decide(id, decision) {
  await fetch(`/api/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, by: state.user?.name || "operator" }),
  });
  await refreshState();
  switchView("trace");
}

function renderApprovals() {
  const host = $("#approvals");
  host.replaceChildren();
  const list = state.approvals || [];
  const badge = $("#approval-count");
  badge.hidden = !list.length;
  badge.textContent = list.length;
  if (state.supervisor) $("#supervisor").textContent = `${state.supervisor.name} (${state.supervisor.channel})`;

  if (!list.length) {
    return host.append(el("p", { class: "empty", text: "Nothing awaiting approval. Read-only queries run freely; state-changing actions appear here first." }));
  }
  for (const a of list) {
    host.append(el("div", { class: "row" }, [
      el("div", { class: "main" }, [
        el("b", {}, [
          pill(a.risk === "high" ? "bad" : "warn", `${a.risk} risk`),
          el("span", { class: "mono", text: a.id }),
          el("span", { text: a.description }),
        ]),
        el("span", { text: a.why }),
      ]),
      el("div", { class: "actions" }, [
        el("button", { class: "btn accent sm", onclick: () => decide(a.id, "approve") }, [icon("check", 12), el("span", { text: "Approve" })]),
        el("button", { class: "btn danger sm", onclick: () => decide(a.id, "reject") }, [icon("x", 12), el("span", { text: "Reject" })]),
      ]),
    ]));
  }
}

function renderTrace() {
  const host = $("#trace");
  host.replaceChildren();
  const eps = state.trace || [];
  if (!eps.length) {
    return host.append(el("p", { class: "empty", text: "No episodes yet. Ask a question, or wait for an equipment alert to trigger autonomous analysis." }));
  }
  for (const ep of eps) {
    const card = el("div", { class: `episode ${openEps.has(ep.id) ? "open" : ""}` });
    const head = el("div", { class: "ep-head" }, [
      icon("chevron", 13, "chev"),
      el("span", { class: "eid", text: ep.id }),
      el("span", { class: `trigger ${ep.triggerType}`, text: TRIGGER[ep.triggerType] || ep.triggerType }),
      el("span", { class: "esum", text: ep.summary.slice(0, 110) }),
      pill(ep.status === "completed" ? "ok" : ep.status === "failed" ? "bad" : "warn", ep.status.replace(/_/g, " ")),
      el("span", { class: "eid", text: `${ep.steps.length} steps` }),
    ]);
    head.addEventListener("click", () => {
      openEps.has(ep.id) ? openEps.delete(ep.id) : openEps.add(ep.id);
      renderTrace();
    });
    const steps = el("div", { class: "ep-steps" }, ep.steps.map((s) =>
      el("div", { class: `step ${s.type}` }, [
        el("span", { class: "t", text: fmtT(s.t) }),
        el("span", { class: "k", text: STEP_LABEL[s.type] || s.type }),
        el("span", { class: "d", text: s.summary }),
      ])
    ));
    card.append(head, steps);
    host.append(card);
  }
}

/* ── chat ────────────────────────────────────────────────────────────────── */

const VIEW_LABEL = { arrivals: "Arrivals", yard: "Yard", equipment: "Equipment", alerts: "Alerts" };
const chatLog = $("#chat-log");

function addMsg(role, text) {
  const m = el("div", { class: `msg ${role}`, text });
  chatLog.append(m);
  chatLog.scrollTop = chatLog.scrollHeight;
  return m;
}

async function askAgent(q) {
  addMsg("user", q);
  const pending = addMsg("agent thinking", "Thinking…");
  $("#chat-send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": SESSION_ID },
      body: JSON.stringify({ message: q }),
    });
    if (res.status === 401) return (window.location.href = "/login");
    const d = await res.json();
    pending.remove();
    if (d.error) return addMsg("agent", `Sorry — ${d.detail || d.error}`);
    const m = addMsg("agent", d.text);
    if (d.view) {
      m.append(el("span", { class: "routed" }, [icon("route", 11), el("span", { text: `opened ${VIEW_LABEL[d.view] || d.view}` })]));
      await refreshState();
      switchView(d.view);
    }
    setAgentChip(d.mode, d.provider);
  } catch (err) {
    pending.remove();
    addMsg("agent", `Connection error: ${err.message}`);
  } finally {
    $("#chat-send").disabled = false;
    $("#chat-text").focus();
  }
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#chat-text").value.trim();
  if (!q) return;
  $("#chat-text").value = "";
  askAgent(q);
});
$$(".suggest button").forEach((b) => b.addEventListener("click", () => askAgent(b.dataset.q)));

/* ── chrome ──────────────────────────────────────────────────────────────── */

function setAgentChip(mode, provider) {
  const chip = $("#agent-chip");
  chip.classList.toggle("live", mode === "ai");
  chip.classList.toggle("degraded", mode !== "ai");
  $("#agent-text").textContent = provider || (mode === "ai" ? "live" : "rule-based");
}

function setInterval_(sec) {
  $("#interval-chip").textContent = `sensors ${sec}s`;
  const input = $("#interval-input");
  if (document.activeElement !== input) input.value = sec;
}

$("#interval-apply").addEventListener("click", async () => {
  const seconds = Number($("#interval-input").value);
  if (!seconds) return;
  const r = await fetch("/api/interval", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seconds }),
  });
  setInterval_((await r.json()).intervalSeconds);
});

$("#logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

function toast(a) {
  const t = el("div", { class: `toast ${a.severity}` }, [
    el("b", { text: `${a.id} · ` }),
    document.createTextNode(`${a.message} — ${a.operator.name} paged.`),
  ]);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 8000);
}

/* ── live stream ─────────────────────────────────────────────────────────── */

function connectStream() {
  const es = new EventSource("/api/stream");
  es.addEventListener("tick", (ev) => {
    if (!state) return;
    const d = JSON.parse(ev.data);
    setInterval_(d.intervalMs / 1000);
    for (const u of d.equipment) {
      const e = state.equipment.find((x) => x.id === u.id);
      if (!e) continue;
      e.health = u.health;
      for (const [k, v] of Object.entries(u.sensors)) {
        e.sensors[k].value = v;
        e.sensors[k].history.push(v);
        if (e.sensors[k].history.length > HISTORY_CAP) e.sensors[k].history.shift();
      }
    }
    if ($("#view-equipment").classList.contains("active")) renderEquipment();
  });
  es.addEventListener("trace", (ev) => {
    if (!state) return;
    const ep = JSON.parse(ev.data);
    const list = state.trace || (state.trace = []);
    const i = list.findIndex((e) => e.id === ep.id);
    if (i >= 0) list[i] = ep; else list.unshift(ep);
    if (ep.status === "awaiting_approval") {
      fetch("/api/approvals").then((r) => r.json()).then((d) => {
        state.approvals = d.approvals;
        state.supervisor = d.supervisor;
        renderApprovals();
      });
    }
    renderTrace();
  });
  es.addEventListener("alert", (ev) => {
    const a = JSON.parse(ev.data);
    if (state) {
      state.alerts.unshift(a);
      state.notifications.unshift({ time: a.time, to: `${a.operator.name} (${a.operator.channel})`, text: a.message });
      renderAlerts();
      if ($("#view-equipment").classList.contains("active")) renderEquipment();
    }
    toast(a);
  });
  es.onerror = () => { es.close(); setTimeout(connectStream, 3000); };
}

/* ── boot ────────────────────────────────────────────────────────────────── */

async function refreshState() {
  const res = await fetch("/api/state");
  if (res.status === 401) return (window.location.href = "/login");
  state = await res.json();

  if (state.user) {
    $("#user-name").textContent = state.user.name;
    $("#user-role").textContent = state.user.role;
    $("#avatar").textContent = state.user.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  }

  renderArrivalStats(); renderRadar(); renderBerths(); renderCarrierMix();
  renderVessels(); renderFactors();
  renderYardStats(); renderYardBlocks(); renderMoves();
  renderEquipment(); renderAlerts(); renderApprovals(); renderTrace();
  setInterval_(state.intervalSeconds);
  setAgentChip(state.mode, state.provider);
}

setInterval(() => {
  $("#clock").textContent = new Date().toLocaleTimeString("en-SG", { hour12: false });
}, 1000);

refreshState().then(connectStream);
