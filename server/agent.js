// PortSense agent: routes operator questions to the right tool and view.
//
// Provider-agnostic by design. Three interchangeable paths, all driving the
// same tool surface in tools.js:
//
//   1. OpenAI-compatible providers (Gemini, Groq, Cerebras, OpenRouter) —
//      one adapter, selected by base URL. Gemini's free tier is the default.
//   2. Claude (claude-opus-4-8) via the Anthropic Messages API.
//   3. A deterministic keyword router, so the app stays demoable with no key
//      and no network at all.
//
// Selection order: AGENT_PROVIDER env var, else whichever API key is present,
// else the rule-based router.

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { toolDefinitions, executeTool, TOOL_VIEWS, findEquipment, currentIntervalSeconds } from "./tools.js";

const CLAUDE_MODEL = "claude-opus-4-8";

// OpenAI-compatible providers. Every one of these speaks the same
// chat.completions + tools wire format, so they share a single adapter.
const PROVIDERS = {
  gemini: {
    label: "Gemini",
    keyEnv: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    defaultModel: "gemini-2.5-flash",
    modelEnv: "GEMINI_MODEL",
  },
  groq: {
    label: "Groq",
    keyEnv: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    modelEnv: "GROQ_MODEL",
  },
  cerebras: {
    label: "Cerebras",
    keyEnv: "CEREBRAS_API_KEY",
    baseURL: "https://api.cerebras.ai/v1",
    defaultModel: "gpt-oss-120b",
    modelEnv: "CEREBRAS_MODEL",
  },
  openrouter: {
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    defaultModel: "meta-llama/llama-3.3-70b-instruct:free",
    modelEnv: "OPENROUTER_MODEL",
  },
};

// Which provider is active for this process.
function resolveProvider() {
  if (process.env.PORTSENSE_FORCE_RULES) return { kind: "rules", label: "rule-based" };
  const explicit = (process.env.AGENT_PROVIDER || "").toLowerCase().trim();
  if (explicit === "rules") return { kind: "rules", label: "rule-based" };
  if (explicit === "claude" || explicit === "anthropic") {
    return { kind: "claude", label: "Claude", model: CLAUDE_MODEL };
  }
  if (explicit && PROVIDERS[explicit]) {
    const p = PROVIDERS[explicit];
    return { kind: "openai", key: explicit, label: p.label, cfg: p, model: process.env[p.modelEnv] || p.defaultModel };
  }
  // Auto-detect from whichever key is present.
  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (process.env[p.keyEnv]) {
      return { kind: "openai", key, label: p.label, cfg: p, model: process.env[p.modelEnv] || p.defaultModel };
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return { kind: "claude", label: "Claude", model: CLAUDE_MODEL };
  return { kind: "rules", label: "rule-based" };
}

const provider = resolveProvider();

const SYSTEM_PROMPT = `You are PortSense, the operations assistant for a PSA container terminal in Singapore.
You have live tools covering three solution areas:
1. Unpredictable arrival timings — vessel ETAs, AI delay predictions, berth plan.
2. Yard reshuffling — dig-out plans for buried containers and pre-emptive reshuffle recommendations.
3. Equipment predictive maintenance — live sensor readings, configurable sampling interval, anomaly alerts and operator notifications.

Always answer from tool results, never from memory. Be concise and operational: lead with the answer, use short bullet points for lists, include concrete numbers (hours, moves, sensor values with units). If the user asks something outside port operations, briefly redirect them to what you can help with. The dashboard automatically opens the panel related to the tools you use, so you don't need to describe the UI.`;

let client = null;
// null = untested; true = provider answered; false = fell back to rules for good.
let aiAvailable = provider.kind === "rules" ? false : null;

function getClient() {
  if (client) return client;
  if (provider.kind === "claude") {
    client = new Anthropic();
  } else {
    client = new OpenAI({
      apiKey: process.env[provider.cfg.keyEnv],
      // AGENT_BASE_URL lets you point at a proxy, a self-hosted gateway, or a
      // local OpenAI-compatible server (Ollama, LM Studio) without code changes.
      baseURL: process.env.AGENT_BASE_URL || provider.cfg.baseURL,
    });
  }
  return client;
}

export function getMode() {
  if (aiAvailable === false) return "rules";
  return "ai";
}

// Human-readable provider label for the dashboard pill.
export function getProviderLabel() {
  if (aiAvailable === false) return "rule-based (no API key)";
  return provider.model ? `${provider.label} · ${provider.model}` : provider.label;
}

// Per-browser conversations. A single deployed instance is used by several
// judges at once, so histories must not be shared — otherwise one person's
// follow-up question inherits another person's context.
const SESSION_TTL_MS = 30 * 60 * 1000; // idle sessions expire after 30 min
const MAX_SESSIONS = 200;              // hard cap so memory can't grow unbounded
const sessions = new Map();            // sessionId -> { history, lastSeen }

function getSession(sessionId = "default") {
  const now = Date.now();
  // Evict idle sessions on access — no timer needed.
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(id);
  }
  // If still over the cap, drop the least recently used.
  if (sessions.size >= MAX_SESSIONS && !sessions.has(sessionId)) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
  let s = sessions.get(sessionId);
  if (!s) {
    s = { history: [], lastSeen: now };
    sessions.set(sessionId, s);
  }
  s.lastSeen = now;
  return s;
}

export function resetConversation(sessionId = "default") {
  sessions.delete(sessionId);
}

export function sessionCount() {
  return sessions.size;
}

function viewForTools(toolsUsed) {
  for (let i = toolsUsed.length - 1; i >= 0; i--) {
    if (TOOL_VIEWS[toolsUsed[i]]) return TOOL_VIEWS[toolsUsed[i]];
  }
  return null;
}

// --- OpenAI-compatible adapter (Gemini / Groq / Cerebras / OpenRouter) -------

// The tool surface is authored in Anthropic shape; translate once at startup.
const openAiTools = toolDefinitions.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    // The compatibility layers reject a bare {} schema, so always give an
    // explicit object schema even for no-argument tools.
    parameters: {
      type: "object",
      properties: t.input_schema.properties || {},
      ...(t.input_schema.required ? { required: t.input_schema.required } : {}),
    },
  },
}));

async function askOpenAICompatible(question, session) {
  const api = getClient();
  let history = session.history;
  if (!history.length) history.push({ role: "system", content: SYSTEM_PROMPT });
  history.push({ role: "user", content: question });
  // Keep the system turn pinned at index 0 while trimming older turns.
  if (history.length > 21) {
    history = [history[0], ...history.slice(-20)];
    session.history = history;
  }

  const toolsUsed = [];
  let message;
  for (let iter = 0; iter < 6; iter++) {
    const completion = await api.chat.completions.create({
      model: provider.model,
      messages: history,
      tools: openAiTools,
      tool_choice: "auto",
      max_tokens: 2048,
    });

    message = completion.choices[0].message;
    history.push(message);

    const calls = message.tool_calls || [];
    if (!calls.length) break;

    for (const call of calls) {
      toolsUsed.push(call.function.name);
      let result;
      try {
        // Arguments arrive as a JSON string; a model can emit malformed JSON.
        const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        result = executeTool(call.function.name, args);
      } catch (err) {
        result = { error: String(err.message || err) };
      }
      history.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  const text = (message?.content || "").trim();
  return {
    text: text || "Done.",
    view: viewForTools(toolsUsed),
    toolsUsed,
    mode: "ai",
    provider: getProviderLabel(),
  };
}

// --- Anthropic adapter -------------------------------------------------------

async function askClaude(question, session) {
  const anthropic = getClient();
  let history = session.history;
  history.push({ role: "user", content: question });
  if (history.length > 20) {
    history = history.slice(-20);
    session.history = history;
  }

  const toolsUsed = [];
  let response;
  for (let iter = 0; iter < 6; iter++) {
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: toolDefinitions,
      messages: history,
    });

    history.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") break;

    const results = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      toolsUsed.push(block.name);
      let result;
      try {
        result = executeTool(block.name, block.input);
      } catch (err) {
        result = { error: String(err.message || err) };
      }
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        ...(result && result.error ? { is_error: true } : {}),
      });
    }
    history.push({ role: "user", content: results });
  }

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return { text: text || "Done.", view: viewForTools(toolsUsed), toolsUsed, mode: "ai", provider: getProviderLabel() };
}

// ---------------------------------------------------------------------------
// Rule-based fallback router (no API key required)
// ---------------------------------------------------------------------------

function fmtEta(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleString("en-SG", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

function answerWithRules(question) {
  const q = question.toLowerCase();
  const toolsUsed = [];
  const run = (name, input) => {
    toolsUsed.push(name);
    return executeTool(name, input);
  };
  let text;

  const cntrMatch = question.match(/CNTR-?\d{3,4}/i);
  const alertMatch = question.match(/AL-?\d{2,3}/i);
  const eqMatch = question.match(/\b(QC|RTG|AGV)[- ]?(\d{1,2})\b/i);
  const secondsMatch = q.match(/every\s+(\d+)\s*(second|sec|s\b)/) || q.match(/(\d+)\s*(second|sec)\b/);

  if (secondsMatch && /(interval|monitor|poll|sample|measure|check|read)/.test(q)) {
    const r = run("set_monitoring_interval", { seconds: Number(secondsMatch[1]) });
    text = `Done — ${r.message}. All equipment sensors now report on the new cadence.`;
  } else if (alertMatch && /(ack|clear|close|resolve)/.test(q)) {
    const r = run("acknowledge_alert", { alert_id: alertMatch[0].toUpperCase() });
    text = r.error ? r.error : `Acknowledged ${r.alert.id} (${r.alert.message}).`;
  } else if (/(alert|anomal|fault|notif)/.test(q) && !/simulate/.test(q)) {
    const r = run("get_alerts", {});
    text = r.alerts.length
      ? `There ${r.alerts.length === 1 ? "is 1 active alert" : `are ${r.alerts.length} active alerts`}:\n` +
        r.alerts.map((a) => `• ${a.id} [${a.severity.toUpperCase()}] ${a.message} — ${a.operator.name} notified via ${a.operator.channel}`).join("\n")
      : "No active alerts. All equipment sensors are within normal thresholds.";
  } else if (/simulate|inject|demo.*fault/.test(q) && eqMatch) {
    const r = run("simulate_fault", { equipment_id: `${eqMatch[1]}-${eqMatch[2].padStart(2, "0")}`.toUpperCase() });
    text = r.error || r.message;
  } else if (cntrMatch) {
    const id = cntrMatch[0].toUpperCase().replace(/^CNTR(\d)/, "CNTR-$1");
    const r = run("plan_container_retrieval", { container_id: id });
    text = r.error
      ? r.error
      : `${r.target.id} is at ${r.target.block}${String(r.target.bay).padStart(2, "0")}, tier ${r.target.tier}, buried under ${r.digMoves} container${r.digMoves === 1 ? "" : "s"}.\n` +
        `Dig-out plan (~${r.estimatedMinutes} min):\n` +
        r.relocations.map((m, i) => `${i + 1}. Move ${m.container} from ${m.from} → ${m.to}`).join("\n");
  } else if (/(reshuffle|dig|shuffl|rehandl|buried|prepare.*yard)/.test(q)) {
    const r = run("get_reshuffle_recommendations", {});
    text = r.recommendations.length
      ? `Top pre-emptive reshuffle candidates (next ${r.windowHours}h):\n` +
        r.recommendations.slice(0, 5).map((x) => `• ${x.container} at ${x.location} — due in ${x.dueInHours}h, buried under ${x.buriedUnder} boxes (saves ~${x.craneMinutesSavedIfPreShuffled} crane-min if pre-shuffled)`).join("\n")
      : "No buried containers due in the next 12 hours — the yard is well positioned.";
  } else if (/(yard|block|capacity|utili[sz])/.test(q)) {
    const r = run("get_yard_status", {});
    text = "Yard utilisation by block:\n" +
      r.blocks.map((b) => `• ${b.block}: ${b.containers}/${b.capacity} slots (${b.utilisationPct}%)`).join("\n") +
      `\nTotal containers on the ground: ${r.totalContainers}.`;
  } else if (eqMatch || /(sensor|vibration|temperature|pressure|current draw)/.test(q)) {
    if (eqMatch) {
      const eq = findEquipment(`${eqMatch[1]}-${eqMatch[2].padStart(2, "0")}`);
      if (eq) {
        const r = run("get_sensor_readings", { equipment_id: eq.id });
        text = `${r.id} (${r.type}) — health: ${r.health.toUpperCase()}, operator ${r.operator.name}:\n` +
          Object.values(r.sensors).map((s) => `• ${s.label}: ${s.current} ${s.unit} (warn ${s.warn}, critical ${s.crit})`).join("\n");
      }
    }
    if (!text) {
      const r = run("get_equipment_status", { only_unhealthy: true });
      text = r.length
        ? `Equipment needing attention:\n` + r.map((e) => `• ${e.id} (${e.type}) — ${e.health.toUpperCase()}, operator ${e.operator.name}`).join("\n")
        : "All equipment healthy. Sensors sampling every " + currentIntervalSeconds() + "s.";
    }
  } else if (/(equipment|crane|maintenance|machine|health|rtg|agv|qc)/.test(q)) {
    const r = run("get_equipment_status", {});
    const bad = r.filter((e) => e.health !== "good");
    text = `Monitoring ${r.length} machines (every ${currentIntervalSeconds()}s). ` +
      (bad.length
        ? `${bad.length} need attention:\n` + bad.map((e) => `• ${e.id} — ${e.health.toUpperCase()} (operator ${e.operator.name})`).join("\n")
        : "All healthy.");
  } else if (/(why|delay|late|reason|when)/.test(q) && /(kota|meadow|pacific crown|maju|horizon|aquila|hai feng|cantata|temasek|lotus|harmoni|sentosa|glory|crown)/.test(q)) {
    const nameMatch = q.match(/(kota harmoni|harmoni|ever meadow|meadow|lotus trader|lotus|pacific crown|crown|maju sentosa|sentosa|blue horizon|horizon|star aquila|aquila|hai feng|ocean cantata|cantata|temasek glory|glory)/);
    const r = run("predict_vessel_arrival", { vessel: nameMatch ? nameMatch[1] : q });
    text = r.error
      ? r.error
      : `${r.name}: scheduled ${fmtEta(r.scheduledEta)}, predicted ${fmtEta(r.predictedEta)} (${r.delayHours > 0 ? `+${r.delayHours}h late` : "on time"}, confidence ${Math.round(r.confidence * 100)}%).` +
        (r.delayFactors.length ? "\nContributing factors:\n" + r.delayFactors.map((f) => `• ${f.factor} (+${f.impactHours}h)`).join("\n") : "");
  } else if (/(vessel|arriv|eta|berth|schedule|ship)/.test(q)) {
    const delayedOnly = /delay|late/.test(q);
    const r = run("get_vessel_arrivals", { only_delayed: delayedOnly });
    text = (delayedOnly ? "Vessels predicted to arrive late:\n" : "Upcoming vessel arrivals:\n") +
      r.slice(0, 6).map((v) => `• ${v.name} (${v.service}) → berth ${v.berth}: predicted ${fmtEta(v.predictedEta)}${v.delayHours > 1 ? ` (+${v.delayHours}h)` : v.delayHours < -0.5 ? " (early)" : " (on time)"}`).join("\n");
  } else {
    text = "I can help with three things:\n• Vessel arrivals — \"Which vessels are delayed?\", \"Why is Kota Harmoni late?\"\n• Yard reshuffling — \"What should we reshuffle before tonight?\", \"Dig out CNTR-0042\"\n• Equipment maintenance — \"Any anomalies?\", \"Show RTG-02 sensors\", \"Sample sensors every 10 seconds\"";
  }

  return { text, view: viewForTools(toolsUsed), toolsUsed, mode: "rules", provider: "rule-based" };
}

// A bad key, a disabled API, or a model the key can't reach are all permanent
// for this process — drop to rules. Rate limits and 5xx are transient.
function isPermanentFailure(err) {
  const status = err?.status ?? err?.statusCode;
  if (status === 429 || (status >= 500 && status < 600)) return false;
  // 400 covers Gemini's response to an invalid key or an unusable model.
  if (status === 400 || status === 401 || status === 403 || status === 404) return true;
  return /api key|authentication|permission|not found|unsupported|invalid.*model/i.test(
    String(err?.message || "")
  );
}

export async function ask(question, sessionId = "default") {
  if (aiAvailable !== false) {
    const session = getSession(sessionId);
    const snapshot = session.history.slice();
    try {
      const answer = provider.kind === "claude"
        ? await askClaude(question, session)
        : await askOpenAICompatible(question, session);
      aiAvailable = true;
      return answer;
    } catch (err) {
      if (isPermanentFailure(err) || aiAvailable === null) {
        // No usable credentials/model — use the deterministic router from here on.
        aiAvailable = false;
        sessions.clear();
        console.warn(
          `[portsense] ${provider.label} unavailable (${err.status || "error"}: ${err.message}). ` +
          `Falling back to the rule-based router.`
        );
      } else {
        // Transient (rate limit, 5xx) on a previously working provider: answer
        // this turn with rules but keep trying the model on later turns.
        console.warn(`[portsense] ${provider.label} call failed transiently: ${err.message}`);
        session.history = snapshot; // discard the partial turn so the next call is well-formed
        return { ...answerWithRules(question), note: "transient-ai-error" };
      }
    }
  }
  return answerWithRules(question);
}
