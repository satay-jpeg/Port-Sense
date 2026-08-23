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

function makeVessels() {
  const specs = [
    ["MV Ever Meadow",   "AEX1", -6,  0.4, "B1", "berthed"],
    ["MV Lotus Trader",  "CIX2",  2,  1.2, "B2", "approaching"],
    ["MV Kota Harmoni",  "SSE3",  5,  4.6, "B3", "en-route"],
    ["MV Pacific Crown", "AEX1",  9,  0.0, "B4", "en-route"],
    ["MV Maju Sentosa",  "IAS4", 14,  7.8, "B1", "en-route"],
    ["MV Blue Horizon",  "CIX2", 20,  2.1, "B2", "en-route"],
    ["MV Star Aquila",   "SSE3", 27, -1.5, "B3", "en-route"],
    ["MV Hai Feng 88",   "IAS4", 33,  5.9, "B4", "en-route"],
    ["MV Ocean Cantata", "AEX1", 41,  0.7, "B1", "en-route"],
    ["MV Temasek Glory", "CIX2", 47, 11.4, "B2", "en-route"],
  ];
  return specs.map(([name, service, etaOffsetH, delayH, berth, status], i) => {
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
      service,
      berth,
      status,
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
// 2. Container yard — blocks, stacks, and reshuffle planning
// ---------------------------------------------------------------------------
// Each block is a set of bays; each bay is a stack (array, index 0 = ground
// tier). A container buried under others requires one "dig" move per
// container above it.

export const yard = { blocks: {} };
export const containers = {}; // id -> { block, bay, tier, vessel, retrievalEta }

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
        stack.push(id);
        containers[id] = {
          id,
          block: b,
          bay: bay + 1,
          tier: tier + 1,
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
    return {
      block: key,
      containers: used,
      capacity: blk.capacity,
      utilisationPct: Math.round((used / blk.capacity) * 100),
    };
  });
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
