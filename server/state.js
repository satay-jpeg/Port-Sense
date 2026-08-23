// In-memory simulated state for a PSA container terminal.
// Three domains: vessel arrivals, container yard, and equipment health.

const now = () => Date.now();
const HOUR = 3600 * 1000;

function iso(t) {
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// 1. Vessel arrivals — scheduled vs AI-predicted ETAs with delay factors
// ---------------------------------------------------------------------------

const DELAY_FACTORS = [
  "Monsoon squall along Malacca Strait",
  "Congestion at previous port (Port Klang)",
  "Engine derating reported by vessel master",
  "Late departure from Colombo",
  "Strong headwinds in South China Sea",
  "Pilot boarding queue at anchorage",
  "Bunkering overrun at previous call",
];

// Carrier lines, as in the arrivals design. Each gets a colour used for the
// radar plot, schedule rows and the fleet-mix breakdown.
export const CARRIERS = {
  MAERSK:    { label: "Maersk",      color: "#0078d2" },
  MSC:       { label: "MSC",         color: "#f5a623" },
  CMACGM:    { label: "CMA CGM",     color: "#00c864" },
  COSCO:     { label: "COSCO",       color: "#e5484d" },
  EVERGREEN: { label: "Evergreen",   color: "#00c8b4" },
  ONE:       { label: "ONE",         color: "#ff3c78" },
};

function makeVessels() {
  //     name              carrier      svc     eta   delay  berth  status        flag  teu    loa   x    y
  const specs = [
    ["MV Ever Meadow",   "EVERGREEN", "AEX1",  -6,  0.4, "B1", "BERTHED",     "PA", 14424, 366, 46, 62],
    ["MV Lotus Trader",  "MAERSK",    "CIX2",   2,  1.2, "B2", "APPROACHING", "DK", 11000, 335, 62, 44],
    ["MV Kota Harmoni",  "ONE",       "SSE3",   5,  4.6, "B3", "ANCHORED",    "SG",  8200, 294, 74, 30],
    ["MV Pacific Crown", "MSC",       "AEX1",   9,  0.0, "B4", "APPROACHING", "LR", 19200, 399, 30, 24],
    ["MV Maju Sentosa",  "COSCO",     "IAS4",  14,  7.8, "B1", "ANCHORED",    "MY",  6400, 260, 18, 52],
    ["MV Blue Horizon",  "CMACGM",    "CIX2",  20,  2.1, "B2", "EN_ROUTE",    "FR", 15500, 372, 86, 66],
    ["MV Star Aquila",   "EVERGREEN", "SSE3",  27, -1.5, "B3", "EN_ROUTE",    "PA", 12100, 340, 12, 18],
    ["MV Hai Feng 88",   "COSCO",     "IAS4",  33,  5.9, "B4", "EN_ROUTE",    "CN",  5200, 228, 90, 20],
    ["MV Ocean Cantata", "MSC",       "AEX1",  41,  0.7, "B1", "EN_ROUTE",    "LR", 16800, 383, 24, 80],
    ["MV Temasek Glory", "MAERSK",    "CIX2",  47, 11.4, "B2", "EN_ROUTE",    "SG", 20500, 400, 68, 86],
  ];
  return specs.map(([name, carrier, service, etaOffsetH, delayH, berth, status, flag, teu, loa, x, y], i) => {
    const scheduled = now() + etaOffsetH * HOUR;
    const predicted = scheduled + delayH * HOUR;
    const factors = [];
    if (delayH > 3) {
      factors.push({ factor: DELAY_FACTORS[i % DELAY_FACTORS.length], impactHours: +(delayH * 0.6).toFixed(1) });
      factors.push({ factor: DELAY_FACTORS[(i + 3) % DELAY_FACTORS.length], impactHours: +(delayH * 0.4).toFixed(1) });
    } else if (delayH > 0.5) {
      factors.push({ factor: DELAY_FACTORS[(i + 1) % DELAY_FACTORS.length], impactHours: delayH });
    }
    return {
      id: `V${String(i + 1).padStart(3, "0")}`,
      name,
      carrier,
      carrierLabel: CARRIERS[carrier].label,
      carrierColor: CARRIERS[carrier].color,
      service,
      berth,
      status,
      flag,
      teu,
      loa,                       // length overall, metres
      mmsi: String(563000000 + i * 13417),
      x, y,                      // position on the approach radar, 0-100%
      scheduledEta: iso(scheduled),
      predictedEta: iso(predicted),
      delayHours: delayH,
      delayFactors: factors,
      confidence: delayH === 0 ? 0.97 : +(0.95 - Math.min(0.25, Math.abs(delayH) * 0.02)).toFixed(2),
      dischargeMoves: 400 + ((i * 137) % 900),
      loadMoves: 350 + ((i * 211) % 800),
    };
  });
}

export const vessels = makeVessels();

// ---------------------------------------------------------------------------
// Berths — the quay side of the arrivals picture
// ---------------------------------------------------------------------------

function makeBerths() {
  const defs = [
    ["B1", "NORTH", 400], ["B2", "NORTH", 400],
    ["B3", "SOUTH", 350], ["B4", "SOUTH", 420],
    ["B5", "EAST", 300],  ["B6", "EAST", 300],
  ];
  return defs.map(([id, terminal, maxLength]) => {
    const occupant = vessels.find((v) => v.berth === id && v.status === "BERTHED");
    const reserved = vessels.find((v) => v.berth === id && v.status === "APPROACHING");
    return {
      id,
      terminal,
      maxLength,
      status: occupant ? "OCCUPIED" : reserved ? "RESERVED" : "FREE",
      occupiedBy: occupant ? occupant.name : null,
      reservedFor: reserved ? reserved.name : null,
      // Share of the next 24h this berth is committed for.
      utilisationPct: occupant ? 82 : reserved ? 55 : 18,
    };
  });
}

export const berths = makeBerths();

// Fleet mix by carrier, for the arrivals breakdown panel.
export function carrierMix() {
  const counts = {};
  for (const v of vessels) counts[v.carrier] = (counts[v.carrier] || 0) + 1;
  return Object.entries(counts)
    .map(([key, count]) => ({
      carrier: key,
      label: CARRIERS[key].label,
      color: CARRIERS[key].color,
      count,
      teu: vessels.filter((v) => v.carrier === key).reduce((s, v) => s + v.teu, 0),
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// 2. Container yard — blocks, stacks, and reshuffle planning
// ---------------------------------------------------------------------------
// Each block is a set of bays; each bay is a stack (array, index 0 = ground
// tier). A container buried under others requires one "dig" move per
// container above it.

export const yard = { blocks: {} };
export const containers = {}; // id -> { block, bay, tier, type, flow, vessel, … }

const DESTINATIONS = ["Rotterdam", "Shanghai", "Los Angeles", "Busan", "Hamburg", "Dubai", "Jebel Ali"];

// Handling cost assumptions used to price a reshuffle plan. Stated here so the
// savings figures on the yard screen are traceable rather than magic numbers.
export const MOVE_COST = {
  minutesPerRehandle: 4,
  litresPerRehandle: 2.6,   // RTG diesel burn per container move
  usdPerRehandle: 38,       // crane time + fuel + labour
};

function makeYard() {
  const blockNames = ["A", "B", "C", "D"];
  let seq = 1;
  for (const b of blockNames) {
    const bays = [];
    const bayCount = 12;
    for (let bay = 0; bay < bayCount; bay++) {
      const height = 1 + ((bay * 7 + b.charCodeAt(0)) % 5); // 1..5 tiers
      const stack = [];
      for (let tier = 0; tier < height; tier++) {
        const id = `CNTR-${String(seq++).padStart(4, "0")}`;
        // Retrieval times spread over next 72h; some buried boxes are due soon
        const dueH = ((seq * 13) % 72) + 1;
        const vessel = vessels[seq % vessels.length];
        // Reefers need power and hazmat needs segregation, so both constrain
        // where a box may be relocated during a reshuffle.
        const type = seq % 11 === 0 ? "hazmat" : seq % 4 === 0 ? "reefer" : "dry";
        const flow = dueH <= 24 ? "outbound" : seq % 5 === 0 ? "transit" : dueH > 60 ? "dwell" : "inbound";
        stack.push(id);
        containers[id] = {
          id,
          block: b,
          bay: bay + 1,
          tier: tier + 1,
          type,
          flow,
          weightT: 8 + ((seq * 7) % 22),
          destination: DESTINATIONS[seq % DESTINATIONS.length],
          vessel: vessel.name,
          retrievalEta: iso(now() + dueH * HOUR),
          dueInHours: dueH,
        };
      }
      bays.push(stack);
    }
    yard.blocks[b] = { name: `Block ${b}`, bays, capacity: bayCount * 5 };
  }
}
makeYard();

export function yardSummary() {
  return Object.entries(yard.blocks).map(([key, blk]) => {
    const used = blk.bays.reduce((s, stack) => s + stack.length, 0);
    const boxes = Object.values(containers).filter((c) => c.block === key);
    return {
      block: key,
      containers: used,
      capacity: blk.capacity,
      utilisationPct: Math.round((used / blk.capacity) * 100),
      // Stack heights per bay drive the block heat-map in the yard view.
      stacks: blk.bays.map((s) => s.length),
      reefer: boxes.filter((c) => c.type === "reefer").length,
      hazmat: boxes.filter((c) => c.type === "hazmat").length,
      urgent: boxes.filter((c) => c.dueInHours <= 12).length,
    };
  });
}

// Headline counters for the yard screen.
export function yardStats() {
  const all = Object.values(containers);
  const summary = yardSummary();
  const capacity = summary.reduce((s, b) => s + b.capacity, 0);
  return {
    containersInYard: all.length,
    totalBlocks: summary.length,
    utilisationPct: Math.round((all.length / capacity) * 100),
    urgentDepartures: all.filter((c) => c.dueInHours <= 12).length,
    reefer: all.filter((c) => c.type === "reefer").length,
    hazmat: all.filter((c) => c.type === "hazmat").length,
  };
}

// The reshuffle plan, priced.
//
// "Current rehandles" is how many digs the yard would incur if every container
// due in the window were fetched from where it sits today. "Optimised" is what
// remains after pre-emptively relocating the worst-buried boxes during idle
// crane time. The difference is what the savings figures are derived from.
export function optimisationPlan(windowH = 12) {
  const due = Object.values(containers).filter((c) => c.dueInHours <= windowH);

  let currentRehandles = 0;
  const candidates = [];
  for (const c of due) {
    const stack = yard.blocks[c.block].bays[c.bay - 1];
    const buried = stack.length - stack.indexOf(c.id) - 1;
    currentRehandles += buried;
    if (buried >= 2) candidates.push({ c, buried });
  }

  // Work the most-buried, soonest-due boxes first.
  candidates.sort((a, b) => b.buried - a.buried || a.c.dueInHours - b.c.dueInHours);
  const chosen = candidates.slice(0, 10);

  const moves = chosen.map(({ c, buried }, i) => {
    const target = yard.blocks[c.block].bays
      .map((s, idx) => ({ bay: idx + 1, height: s.length }))
      .filter((t) => t.bay !== c.bay && t.height < 5)
      .sort((a, b) => a.height - b.height)[0];
    const reason =
      c.type === "reefer" ? "Reefer due out — move to a powered slot near the gate"
      : c.type === "hazmat" ? "Hazmat segregation — relocate clear of the stack"
      : c.dueInHours <= 4 ? "Departing within 4h — surface before the window opens"
      : "Buried under later-departing boxes — pre-dig during idle time";
    return {
      priority: i + 1,
      containerId: c.id,
      containerType: c.type,
      from: `${c.block}${String(c.bay).padStart(2, "0")}-T${c.tier}`,
      to: target ? `${c.block}${String(target.bay).padStart(2, "0")}` : `${c.block}-buffer`,
      reason,
      rehandlesAvoided: buried,
      timeSavedMin: buried * MOVE_COST.minutesPerRehandle,
      fuelSavedL: +(buried * MOVE_COST.litresPerRehandle).toFixed(1),
      vessel: c.vessel,
      dueInHours: c.dueInHours,
    };
  });

  const rehandlesAvoided = moves.reduce((s, m) => s + m.rehandlesAvoided, 0);
  return {
    windowHours: windowH,
    currentRehandles,
    optimisedRehandles: Math.max(0, currentRehandles - rehandlesAvoided),
    rehandlesSaved: rehandlesAvoided,
    timeSavedMin: rehandlesAvoided * MOVE_COST.minutesPerRehandle,
    fuelSavedL: +(rehandlesAvoided * MOVE_COST.litresPerRehandle).toFixed(1),
    costSavedUSD: rehandlesAvoided * MOVE_COST.usdPerRehandle,
    moves,
  };
}

// Number of containers stacked on top of the target = dig moves required.
export function digPlan(containerId) {
  const c = containers[containerId];
  if (!c) return null;
  const stack = yard.blocks[c.block].bays[c.bay - 1];
  const idx = stack.indexOf(containerId);
  const above = stack.slice(idx + 1);
  // Relocate each blocking box to the shortest neighbouring stack in-block.
  const moves = above.reverse().map((id) => {
    const targets = yard.blocks[c.block].bays
      .map((s, i) => ({ bay: i + 1, height: s.length }))
      .filter((t) => t.bay !== c.bay && t.height < 5)
      .sort((a, b) => a.height - b.height);
    return { container: id, from: `${c.block}${String(c.bay).padStart(2, "0")}`, to: `${c.block}${String(targets[0].bay).padStart(2, "0")}` };
  });
  return {
    target: c,
    digMoves: moves.length,
    estimatedMinutes: moves.length * 4 + 3,
    relocations: moves,
  };
}

// Containers due within `windowH` hours that are buried — best candidates for
// pre-emptive reshuffling during crane idle time.
export function reshuffleRecommendations(windowH = 12) {
  const recs = [];
  for (const c of Object.values(containers)) {
    if (c.dueInHours > windowH) continue;
    const stack = yard.blocks[c.block].bays[c.bay - 1];
    const buriedUnder = stack.length - stack.indexOf(c.id) - 1;
    if (buriedUnder >= 2) {
      recs.push({
        container: c.id,
        location: `${c.block}${String(c.bay).padStart(2, "0")} tier ${c.tier}`,
        buriedUnder,
        retrievalEta: c.retrievalEta,
        dueInHours: c.dueInHours,
        vessel: c.vessel,
        craneMinutesSavedIfPreShuffled: buriedUnder * 4,
      });
    }
  }
  return recs.sort((a, b) => a.dueInHours - b.dueInHours).slice(0, 8);
}

// ---------------------------------------------------------------------------
// 3. Equipment — sensors, thresholds, operators
// ---------------------------------------------------------------------------

const OPERATORS = [
  { name: "Amisha Rao",   channel: "pager 7301" },
  { name: "Marcus Tan",   channel: "pager 7302" },
  { name: "Siti Nurul",   channel: "pager 7303" },
  { name: "Ravi Kumar",   channel: "pager 7304" },
  { name: "Wei Ling Chua", channel: "pager 7305" },
];

// sensor key -> { unit, baseline, warn, crit, jitter }
export const SENSOR_SPEC = {
  motorTemp:    { label: "Motor temperature", unit: "°C",  baseline: 62,  warn: 78,  crit: 88,  jitter: 1.4 },
  vibration:    { label: "Gearbox vibration", unit: "mm/s", baseline: 2.4, warn: 4.5, crit: 7.0, jitter: 0.25 },
  hydraulic:    { label: "Hydraulic pressure", unit: "bar", baseline: 182, warn: 205, crit: 220, jitter: 2.5 },
  current:      { label: "Drive current", unit: "A",   baseline: 310, warn: 370, crit: 410, jitter: 6 },
};

function makeEquipment() {
  const specs = [
    ["QC-01", "Quay crane"], ["QC-02", "Quay crane"], ["QC-03", "Quay crane"],
    ["RTG-01", "RTG crane"], ["RTG-02", "RTG crane"], ["RTG-03", "RTG crane"], ["RTG-04", "RTG crane"],
    ["AGV-01", "AGV"], ["AGV-02", "AGV"], ["AGV-03", "AGV"],
  ];
  return specs.map(([id, type], i) => {
    const sensors = {};
    for (const [key, s] of Object.entries(SENSOR_SPEC)) {
      sensors[key] = { value: s.baseline, history: [] };
    }
    return {
      id,
      type,
      health: "good", // good | warning | critical
      fault: null,    // { sensor, ratePerTick } when a degradation is active
      operator: OPERATORS[i % OPERATORS.length],
      utilisationPct: 55 + ((i * 17) % 40),
      lastServiceDays: (i * 11) % 60,
      sensors,
    };
  });
}

export const equipment = makeEquipment();

export const alerts = []; // { id, time, severity, equipmentId, sensor, value, threshold, message, operator, notified, acknowledged }

export const notificationLog = []; // simulated pager/SMS dispatches
