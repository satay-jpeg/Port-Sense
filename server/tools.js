// Tool surface for the PortSense agent. Each tool maps to one of the three
// solution areas; the `view` field tells the frontend which panel to display
// when the agent uses it.

import {
  vessels, containers, yardSummary, digPlan, reshuffleRecommendations,
  equipment, alerts, notificationLog, SENSOR_SPEC,
} from "./state.js";
import { getIntervalMs, setIntervalMs, injectFault } from "./simulator.js";

export const TOOL_VIEWS = {
  get_vessel_arrivals: "arrivals",
  predict_vessel_arrival: "arrivals",
  get_yard_status: "yard",
  plan_container_retrieval: "yard",
  get_reshuffle_recommendations: "yard",
  get_equipment_status: "equipment",
  get_sensor_readings: "equipment",
  set_monitoring_interval: "equipment",
  get_alerts: "alerts",
  acknowledge_alert: "alerts",
  simulate_fault: "equipment",
};

export const toolDefinitions = [
  {
    name: "get_vessel_arrivals",
    description:
      "List vessels calling at the terminal with scheduled vs AI-predicted ETAs, delay hours, assigned berth and status. Call this when the user asks about arrivals, ETAs, delays, berths, or the vessel schedule.",
    input_schema: {
      type: "object",
      properties: {
        only_delayed: { type: "boolean", description: "Return only vessels predicted to arrive more than 1 hour late" },
      },
    },
  },
  {
    name: "predict_vessel_arrival",
    description:
      "Get the detailed arrival prediction for one vessel: predicted ETA, confidence, and the contributing delay factors (weather, upstream congestion, etc.). Call this when the user asks why a specific vessel is delayed or when it will actually arrive.",
    input_schema: {
      type: "object",
      properties: {
        vessel: { type: "string", description: "Vessel name or ID, e.g. 'Kota Harmoni' or 'V003'" },
      },
      required: ["vessel"],
    },
  },
  {
    name: "get_yard_status",
    description:
      "Summarise container yard blocks: containers stored, capacity and utilisation per block. Call this when the user asks how full the yard is or about yard capacity.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "plan_container_retrieval",
    description:
      "Compute the dig-out plan for a specific container: how many boxes sit on top of it, which relocations are needed and the estimated crane time. Call this when the user asks to retrieve, dig out, or locate a specific container ID (format CNTR-XXXX).",
    input_schema: {
      type: "object",
      properties: {
        container_id: { type: "string", description: "Container ID, e.g. CNTR-0042" },
      },
      required: ["container_id"],
    },
  },
  {
    name: "get_reshuffle_recommendations",
    description:
      "Recommend pre-emptive yard reshuffles: containers due for retrieval soon that are buried under others, ranked by urgency, with crane minutes saved if pre-shuffled during idle time. Call this when the user asks what to reshuffle, how to reduce digging, or how to prepare the yard.",
    input_schema: {
      type: "object",
      properties: {
        window_hours: { type: "number", description: "Look-ahead window in hours (default 12)" },
      },
    },
  },
  {
    name: "get_equipment_status",
    description:
      "List all terminal equipment (quay cranes, RTGs, AGVs) with current health state, live sensor values, assigned operator and utilisation. Call this when the user asks about equipment condition, maintenance status, or which machines need attention.",
    input_schema: {
      type: "object",
      properties: {
        only_unhealthy: { type: "boolean", description: "Return only equipment in warning or critical state" },
      },
    },
  },
  {
    name: "get_sensor_readings",
    description:
      "Get recent sensor history (temperature, vibration, hydraulic pressure, drive current) for one piece of equipment, with thresholds. Call this when the user asks about a specific machine's sensors or trend, e.g. 'show RTG-02 vibration'.",
    input_schema: {
      type: "object",
      properties: {
        equipment_id: { type: "string", description: "Equipment ID, e.g. QC-01, RTG-02, AGV-03" },
      },
      required: ["equipment_id"],
    },
  },
  {
    name: "set_monitoring_interval",
    description:
      "Change how often equipment sensors are sampled (seconds between readings, 1–300). Call this when the user asks to poll/measure/monitor sensors more or less frequently, e.g. 'check sensors every 10 seconds'.",
    input_schema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "Sampling interval in seconds" },
      },
      required: ["seconds"],
    },
  },
  {
    name: "get_alerts",
    description:
      "List anomaly alerts raised by sensor monitoring, including severity, breached threshold and which operator was notified. Call this when the user asks about alerts, anomalies, faults or notifications.",
    input_schema: {
      type: "object",
      properties: {
        include_acknowledged: { type: "boolean", description: "Also include acknowledged alerts" },
      },
    },
  },
  {
    name: "acknowledge_alert",
    description:
      "Mark an alert as acknowledged once it has been handled. Call this when the user says to acknowledge, clear or close an alert (format AL-XXX).",
    input_schema: {
      type: "object",
      properties: {
        alert_id: { type: "string", description: "Alert ID, e.g. AL-001" },
      },
      required: ["alert_id"],
    },
  },
  {
    name: "simulate_fault",
    description:
      "Inject a demo fault into a piece of equipment so its sensor drifts into alarm (for demonstrations only). Call this only when the user explicitly asks to simulate or demo a fault.",
    input_schema: {
      type: "object",
      properties: {
        equipment_id: { type: "string", description: "Equipment ID, e.g. AGV-01" },
        sensor: { type: "string", enum: Object.keys(SENSOR_SPEC), description: "Sensor to degrade (default vibration)" },
      },
      required: ["equipment_id"],
    },
  },
];

function findVessel(query) {
  const q = String(query).toLowerCase();
  return vessels.find(
    (v) => v.id.toLowerCase() === q || v.name.toLowerCase().includes(q)
  );
}

export function findEquipment(query) {
  const q = String(query).toUpperCase().trim();
  return equipment.find((e) => e.id === q || e.id.replace("-", "") === q.replace("-", ""));
}

export function executeTool(name, input = {}) {
  switch (name) {
    case "get_vessel_arrivals": {
      const list = input.only_delayed ? vessels.filter((v) => v.delayHours > 1) : vessels;
      return list.map(({ delayFactors, ...v }) => v);
    }
    case "predict_vessel_arrival": {
      const v = findVessel(input.vessel);
      return v || { error: `No vessel matching '${input.vessel}'. Known vessels: ${vessels.map((x) => x.name).join(", ")}` };
    }
    case "get_yard_status":
      return { blocks: yardSummary(), totalContainers: Object.keys(containers).length };
    case "plan_container_retrieval": {
      const plan = digPlan(String(input.container_id).toUpperCase());
      return plan || { error: `Container '${input.container_id}' not found. IDs look like CNTR-0042.` };
    }
    case "get_reshuffle_recommendations":
      return { windowHours: input.window_hours || 12, recommendations: reshuffleRecommendations(input.window_hours || 12) };
    case "get_equipment_status": {
      const list = input.only_unhealthy ? equipment.filter((e) => e.health !== "good") : equipment;
      return list.map((e) => ({
        id: e.id, type: e.type, health: e.health,
        operator: e.operator, utilisationPct: e.utilisationPct,
        lastServiceDays: e.lastServiceDays,
        sensors: Object.fromEntries(
          Object.entries(e.sensors).map(([k, s]) => [k, { value: +s.value.toFixed(1), unit: SENSOR_SPEC[k].unit, warn: SENSOR_SPEC[k].warn, crit: SENSOR_SPEC[k].crit }])
        ),
      }));
    }
    case "get_sensor_readings": {
      const eq = findEquipment(input.equipment_id);
      if (!eq) return { error: `No equipment '${input.equipment_id}'. Known: ${equipment.map((e) => e.id).join(", ")}` };
      return {
        id: eq.id, type: eq.type, health: eq.health, operator: eq.operator,
        sensors: Object.fromEntries(
          Object.entries(eq.sensors).map(([k, s]) => [k, {
            label: SENSOR_SPEC[k].label, unit: SENSOR_SPEC[k].unit,
            current: +s.value.toFixed(1), warn: SENSOR_SPEC[k].warn, crit: SENSOR_SPEC[k].crit,
            recent: s.history.slice(-15).map((h) => h.v),
          }])
        ),
      };
    }
    case "set_monitoring_interval": {
      const ms = setIntervalMs(Number(input.seconds) * 1000);
      return { ok: true, intervalSeconds: ms / 1000, message: `Sensor sampling interval set to ${ms / 1000}s` };
    }
    case "get_alerts": {
      const list = input.include_acknowledged ? alerts : alerts.filter((a) => !a.acknowledged);
      return { alerts: list, notifications: notificationLog.slice(0, 10) };
    }
    case "acknowledge_alert": {
      const a = alerts.find((x) => x.id.toUpperCase() === String(input.alert_id).toUpperCase());
      if (!a) return { error: `Alert '${input.alert_id}' not found` };
      a.acknowledged = true;
      return { ok: true, alert: a };
    }
    case "simulate_fault": {
      const ok = injectFault(String(input.equipment_id).toUpperCase(), input.sensor || "vibration");
      return ok
        ? { ok: true, message: `Fault injected into ${String(input.equipment_id).toUpperCase()} — expect an alert within a few sampling cycles.` }
        : { error: `Unknown equipment '${input.equipment_id}'` };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

export function currentIntervalSeconds() {
  return getIntervalMs() / 1000;
}
