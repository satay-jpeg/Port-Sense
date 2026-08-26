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
import {
  startEpisode, addStep, endEpisode, getEpisode, STEP, TRIGGER_TYPES, summariseResult,
} from "./trace.js";
import { requiresApproval, proposeAction, escalate, SUPERVISOR } from "./approvals.js";

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
    // llama-3.3-70b-versatile was retired; gpt-oss-120b is the strongest
    // tool-calling model on Groq's free tier. If this one is retired too,
    // discovery walks the ranked queue automatically.
    defaultModel: "openai/gpt-oss-120b",
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
    // Requesting a provider whose key is missing is a config mistake. Say so
    // clearly here — otherwise the SDK later reports a confusing
    // "OPENAI_API_KEY is missing" that names the wrong variable entirely.
    if (!process.env[p.keyEnv]) {
      return {
        kind: "rules",
        label: "rule-based",
        misconfigured: `AGENT_PROVIDER=${explicit} but ${p.keyEnv} is not set in the environment`,
        fix: `Either set ${p.keyEnv}, or change AGENT_PROVIDER to a provider whose key you have.`,
      };
    }
    return { kind: "openai", key: explicit, label: p.label, cfg: p, model: process.env[p.modelEnv] || p.defaultModel };
  }
  if ((explicit === "claude" || explicit === "anthropic") && !process.env.ANTHROPIC_API_KEY) {
    return {
      kind: "rules",
      label: "rule-based",
      misconfigured: "AGENT_PROVIDER=claude but ANTHROPIC_API_KEY is not set",
      fix: "Set ANTHROPIC_API_KEY, or remove AGENT_PROVIDER to fall back to whichever key you do have.",
    };
  }
  if (explicit && !PROVIDERS[explicit]) {
    return {
      kind: "rules",
      label: "rule-based",
      misconfigured: `AGENT_PROVIDER="${explicit}" is not a known provider`,
      fix: `Use one of: ${Object.keys(PROVIDERS).join(", ")}, claude, rules.`,
    };
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

// Surface a config mistake loudly at startup rather than on the first question.
if (provider.misconfigured) {
  console.error(
    `\n[portsense] ⚠️  Agent misconfigured: ${provider.misconfigured}\n` +
    `[portsense]     ${provider.fix}\n` +
    `[portsense]     Running the rule-based router meanwhile — the app still works.\n`
  );
}

const SYSTEM_PROMPT = `You are PortSense, the operations assistant for a PSA container terminal in Singapore.
You have live tools covering three solution areas:
1. Unpredictable arrival timings — vessel ETAs, AI delay predictions, berth plan.
2. Yard reshuffling — dig-out plans for buried containers and pre-emptive reshuffle recommendations.
3. Equipment predictive maintenance — live sensor readings, configurable sampling interval, anomaly alerts and operator notifications.

Always answer from tool results, never from memory. Be concise and operational: lead with the answer, use short bullet points for lists, include concrete numbers (hours, moves, sensor values with units). If the user asks something outside port operations, briefly redirect them to what you can help with. The dashboard automatically opens the panel related to the tools you use, so you don't need to describe the UI.

Handling uncertainty:
- If a request is ambiguous (e.g. "the crane is playing up" when there are three quay cranes and four RTGs), ask ONE specific clarifying question instead of guessing. Say what you'd need to proceed.
- If a tool returns an error or empty result, say so plainly, state what you could not determine, and suggest the next step. Never invent data to fill the gap.
- When a prediction carries a confidence value, quote it. Flag low-confidence figures (below 80%) as provisional.

Actions that change terminal state (changing the sensor sampling interval, acknowledging an alert, injecting a fault) are NOT executed directly — they are proposed and require operator approval. When you call one of those tools you will get back a status saying approval is pending. Tell the operator exactly what you proposed and that it awaits their approval; do not claim the change has been made.`;

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

// Why the AI path is unavailable, if it is. Kept so the dashboard can tell the
// difference between "no key configured" and "key works but something failed".
let lastError = null;

// ---------------------------------------------------------------------------
// Self-throttling
// ---------------------------------------------------------------------------
// Free tiers are tight (Gemini 2.5 Flash-Lite is 15 req/min; 2.5 Flash is 10)
// and ONE operator question costs several requests because every tool
// round-trip is its own call. Rather than let the provider 429 us, we track our
// own spend over a rolling minute and step aside to the rule-based router when
// the budget is gone — which is instant, rather than a failed call plus retry.
//
// Autonomous event analysis is capped below the full budget so background work
// can never starve a human who is asking a question.
const RPM_BUDGET = Number(process.env.AGENT_RPM || 10);
const AUTONOMOUS_SHARE = 0.5; // background work may use at most half the budget
const callTimes = [];

function recentCalls() {
  const cutoff = Date.now() - 60_000;
  while (callTimes.length && callTimes[0] < cutoff) callTimes.shift();
  return callTimes.length;
}

// `budgeted` = how many requests this turn is likely to need (tool loops cost
// several), so we don't start a turn we can't finish.
function canSpend({ autonomous = false, budgeted = 3 } = {}) {
  const ceiling = autonomous ? Math.floor(RPM_BUDGET * AUTONOMOUS_SHARE) : RPM_BUDGET;
  return recentCalls() + budgeted <= ceiling;
}

function noteCall() {
  callTimes.push(Date.now());
}

export function rateStatus() {
  const used = recentCalls();
  return { used, budget: RPM_BUDGET, remaining: Math.max(0, RPM_BUDGET - used) };
}

export function getMode() {
  if (aiAvailable === false) return "rules";
  return "ai";
}

// Human-readable provider label for the dashboard pill.
export function getProviderLabel() {
  if (aiAvailable === false) {
    // A config mistake reads very differently from "no key configured".
    if (provider.misconfigured) return `rule-based (config: ${provider.misconfigured})`;
    if (provider.kind === "rules") return "rule-based (no API key)";
    // A key IS configured but the provider rejected us — say what went wrong
    // rather than blaming a missing key.
    return `rule-based (${provider.label} error: ${lastError || "unknown"})`;
  }
  return provider.model ? `${provider.label} · ${provider.model}` : provider.label;
}

// Model IDs churn on free tiers. When the configured model 404s, ask the
// provider what it actually offers and pick the best available match, so a
// renamed or retired model self-heals instead of dropping to the rule router.
let modelCandidates = null; // ranked queue, built lazily from /models

// Models that cannot serve this app at all: speech, embedding, safety, image
// and other single-purpose endpoints. PortSense is useless without tool
// calling, so anything in this list is excluded outright.
const NOT_CHAT = /whisper|tts|embed|guard|moderation|imagen|veo|rerank|ocr|allam|vision|distil-whisper/i;

// Families known to support tool/function calling across the providers we
// target. Scored up because a model without tool support fails on the first
// question, regardless of how capable it otherwise is.
const TOOL_CAPABLE = /llama-?3\.[13]|llama-?4|qwen|gpt-oss|mixtral|kimi|deepseek|flash|sonnet|opus|haiku/i;

// Ranking is tuned for FREE-TIER RELIABILITY, not raw capability. On Gemini's
// free tier the quota differences are large and they decide whether a live demo
// survives: 2.5 Flash-Lite allows 15 req/min and 1,000/day, 2.5 Flash allows
// 10/min and 250/day, and the newer preview models are tighter still. A
// slightly weaker model that answers every time beats a stronger one that
// spends the demo rate-limited. Override with GEMINI_MODEL to force a choice.
export function modelScore(id) {
  let s = 0;
  if (NOT_CHAT.test(id)) return -1000;          // cannot serve this app at all
  if (TOOL_CAPABLE.test(id)) s += 200;          // tool calling is non-negotiable
  if (/flash/i.test(id)) s += 100;              // Gemini's free-quota tier
  if (/lite|instant/i.test(id)) s += 12;        // most generous rate limits
  if (/pro/i.test(id)) s -= 60;                 // paid-only or heavily capped
  if (/exp|preview|thinking/i.test(id)) s -= 40;// preview builds = tightest quota
  // Very small models are cheap but unreliable at multi-step tool use — they
  // tend to emit wrong JSON types, which strict providers reject outright.
  const params = /(\d+)\s*b\b/i.exec(id);
  if (params) {
    const b = Number(params[1]);
    if (b < 8) s -= 40;
    else if (b >= 70) s += 15;   // larger models follow tool schemas reliably
  }
  // Version preference applies to DECIMAL versions only (2.5, 3.7). Matching
  // any number here would read the "120" of "gpt-oss-120b" as version 120 and
  // bury a strong model — that bug picked a weak model over gpt-oss.
  const verMatch = id.match(/(?:^|[^\d.])(\d\.\d)(?![\db])/);
  if (verMatch) {
    const ver = parseFloat(verMatch[1]);
    s += ver <= 2.9 ? ver * 2 : -ver;  // newest previews carry the tightest quota
  }
  return s;
}

// Advance to the next viable model. Catalogues churn and a single guess is
// fragile — a retired ID 404s, and a surviving-but-wrong ID (a speech or
// safety model) 400s with "tool calling is not supported". So we build a
// ranked queue once and walk it until one actually works.
async function rediscoverModel() {
  if (provider.kind !== "openai") return false;

  if (!modelCandidates) {
    try {
      const res = await getClient().models.list();
      // Gemini returns ids as "models/gemini-x"; others return bare ids.
      const ids = res.data.map((m) => String(m.id).replace(/^models\//, ""));
      modelCandidates = ids
        .filter((id) => modelScore(id) > -1000)
        .sort((a, b) => modelScore(b) - modelScore(a));
      console.warn(`[portsense] Discovered ${modelCandidates.length} usable models; ranked: ${modelCandidates.slice(0, 3).join(", ")}…`);
    } catch (err) {
      console.warn(`[portsense] Could not list models: ${err.message}`);
      modelCandidates = [];
      return false;
    }
  }

  const idx = modelCandidates.indexOf(provider.model);
  const next = modelCandidates[idx + 1];
  if (!next) {
    console.warn("[portsense] No further model candidates to try.");
    return false;
  }
  console.warn(`[portsense] Model "${provider.model}" unusable — trying "${next}".`);
  provider.model = next;
  return true;
}

// Errors that mean "this model won't work" rather than "the request was bad".
function isModelProblem(err) {
  const status = err?.status ?? err?.statusCode;
  const msg = String(err?.message || "");
  if (status === 404) return true;
  // "tool call validation failed" means the model emitted arguments of the
  // wrong JSON type (e.g. "true" instead of true) and the provider rejected
  // them. That is a model-capability failure, not a bad request on our side —
  // a stronger model fixes it, so treat it as a reason to try the next one.
  return /model.*(not found|does not exist|decommissioned|deprecated)|tool call\w*.*(not supported|validation failed)|does not support tools|not supported with this model|did not match schema/i.test(msg);
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

// Single choke point for every tool invocation, whichever adapter is driving.
// It records the call on the trace, diverts state-changing tools into the
// approval queue instead of running them, and records the result or failure.
function runTool(name, args = {}, episode = null) {
  addStep(episode, STEP.TOOL_CALL, `${name}(${JSON.stringify(args).slice(0, 140)})`, { tool: name, args });

  // Clarification is a first-class outcome, not a data lookup: record the
  // ambiguity and the question so the trace evidences that the agent declined
  // to guess. Without this, uncertainty handling is invisible on the AI path.
  if (name === "request_clarification") {
    addStep(episode, STEP.UNCERTAINTY, args.ambiguity || "Request is ambiguous",
      { options: args.options || [] });
    addStep(episode, STEP.CLARIFICATION, args.question || "Asked the operator to clarify");
    return executeTool(name, args);
  }

  if (requiresApproval(name)) {
    const proposal = proposeAction({ tool: name, args, episode });
    return {
      status: "awaiting_human_approval",
      approval_id: proposal.id,
      proposed: proposal.description,
      note: "This changes terminal state, so it has been queued for operator approval. It has NOT been applied yet.",
    };
  }

  let result;
  try {
    result = executeTool(name, args);
  } catch (err) {
    result = { error: String(err.message || err) };
  }

  if (result && result.error) {
    addStep(episode, STEP.TOOL_ERROR, `${name} failed — ${result.error}`, { tool: name });
  } else {
    addStep(episode, STEP.TOOL_RESULT, `${name} → ${summariseResult(result)}`, { tool: name });
  }
  return result;
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

async function askOpenAICompatible(question, session, episode = null) {
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
    noteCall();
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
        result = runTool(call.function.name, args, episode);
      } catch (err) {
        result = { error: `Could not parse tool arguments: ${String(err.message || err)}` };
        addStep(episode, STEP.TOOL_ERROR, `${call.function.name} — malformed arguments`, { tool: call.function.name });
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

async function askClaude(question, session, episode = null) {
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
    noteCall();
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
      const result = runTool(block.name, block.input, episode);
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

function answerWithRules(question, episode = null) {
  const q = question.toLowerCase();
  const toolsUsed = [];
  const run = (name, input) => {
    toolsUsed.push(name);
    return runTool(name, input, episode);
  };
  let text;

  // Ambiguity check: a bare equipment-type mention with several candidates and
  // no specific unit is under-specified — ask rather than guess.
  const bareType = q.match(/\b(crane|rtg|agv|quay crane)\b/);
  const hasSpecificUnit = /\b(qc|rtg|agv)[- ]?\d{1,2}\b/i.test(question);
  if (bareType && !hasSpecificUnit && /(fault|problem|issue|acting|playing up|wrong|broken|check|look)/.test(q)) {
    const fleet = executeTool("get_equipment_status", {});
    const candidates = fleet
      .filter((e) => e.type.toLowerCase().includes(bareType[1].replace("quay crane", "quay")))
      .map((e) => e.id);
    const options = (candidates.length ? candidates : fleet.map((e) => e.id)).join(", ");
    addStep(episode, STEP.UNCERTAINTY, `Ambiguous target: "${bareType[1]}" matches ${candidates.length || fleet.length} machines`);
    addStep(episode, STEP.CLARIFICATION, "Asked the operator which unit they mean");
    return {
      text: `Which unit do you mean? That matches: ${options}.\nTell me the ID (e.g. "check RTG-02") and I'll pull its sensor history.`,
      view: "equipment",
      toolsUsed: [],
      mode: "rules",
      provider: "rule-based",
      needsClarification: true,
    };
  }

  const cntrMatch = question.match(/CNTR-?\d{3,4}/i);
  const alertMatch = question.match(/AL-?\d{2,3}/i);
  const eqMatch = question.match(/\b(QC|RTG|AGV)[- ]?(\d{1,2})\b/i);
  const secondsMatch = q.match(/every\s+(\d+)\s*(second|sec|s\b)/) || q.match(/(\d+)\s*(second|sec)\b/);

  if (secondsMatch && /(interval|monitor|poll|sample|measure|check|read)/.test(q)) {
    const r = run("set_monitoring_interval", { seconds: Number(secondsMatch[1]) });
    text = r.status === "awaiting_human_approval"
      ? `Proposed: ${r.proposed}.\nThis changes how quickly anomalies are detected across the fleet, so it needs your approval — see the Approvals panel (${r.approval_id}). Nothing has changed yet.`
      : `Done — ${r.message}.`;
  } else if (alertMatch && /(ack|clear|close|resolve)/.test(q)) {
    const r = run("acknowledge_alert", { alert_id: alertMatch[0].toUpperCase() });
    text = r.status === "awaiting_human_approval"
      ? `Proposed: ${r.proposed}.\nAcknowledging stops the alert being surfaced to operators, so it needs your approval (${r.approval_id}). The alert is still active.`
      : r.error || `Acknowledged ${r.alert.id}.`;
  } else if (/(alert|anomal|fault|notif)/.test(q) && !/simulate/.test(q)) {
    const r = run("get_alerts", {});
    text = r.alerts.length
      ? `There ${r.alerts.length === 1 ? "is 1 active alert" : `are ${r.alerts.length} active alerts`}:\n` +
        r.alerts.map((a) => `• ${a.id} [${a.severity.toUpperCase()}] ${a.message} — ${a.operator.name} notified via ${a.operator.channel}`).join("\n")
      : "No active alerts. All equipment sensors are within normal thresholds.";
  } else if (/simulate|inject|demo.*fault/.test(q) && eqMatch) {
    const r = run("simulate_fault", { equipment_id: `${eqMatch[1]}-${eqMatch[2].padStart(2, "0")}`.toUpperCase() });
    text = r.status === "awaiting_human_approval"
      ? `Proposed: ${r.proposed}.\nThis drives a machine into an alarm state, so it's high risk and needs your approval (${r.approval_id}).`
      : r.error || r.message;
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
  const episode = startEpisode({
    triggerType: TRIGGER_TYPES.USER_REQUEST,
    summary: question,
    sessionId,
  });
  addStep(episode, STEP.ANALYSIS, `Interpreting operator request; selecting tools from the ${toolDefinitions.length}-tool terminal surface`);

  const finish = (answer) => {
    // An episode that queued an approval stays open until the operator decides.
    if (episode.status !== "awaiting_approval") {
      endEpisode(episode, "completed", answer.needsClarification
        ? "Clarification requested from operator"
        : `Responded via ${answer.mode === "ai" ? getProviderLabel() : "rule-based router"}`);
    }
    return { ...answer, episodeId: episode.id };
  };

  // Step aside before spending a request we don't have budget for — a rules
  // answer now beats a 429 and a retry.
  if (aiAvailable !== false && !canSpend({ budgeted: 3 })) {
    const r = rateStatus();
    addStep(episode, STEP.FALLBACK,
      `Rate-limit budget spent (${r.used}/${r.budget} calls in the last minute) — answering from the rule-based router to stay inside the free tier`);
    return finish({ ...answerWithRules(question, episode), note: "rate-limited" });
  }

  if (aiAvailable !== false) {
    const session = getSession(sessionId);
    const snapshot = session.history.slice();
    try {
      const answer = provider.kind === "claude"
        ? await askClaude(question, session, episode)
        : await askOpenAICompatible(question, session, episode);
      aiAvailable = true;
      return finish(answer);
    } catch (err) {
      // A stale or tool-incapable model is a catalogue problem, not a bad key.
      // Walk the ranked candidate queue until one works (bounded, so a provider
      // with no usable models can't spin here).
      for (let attempt = 0; attempt < 4 && isModelProblem(err); attempt++) {
        if (!(await rediscoverModel())) break;
        addStep(episode, STEP.FALLBACK, `Model unusable — switched to "${provider.model}" and retrying`);
        try {
          session.history = snapshot;
          const answer = await askOpenAICompatible(question, session, episode);
          aiAvailable = true;
          return finish(answer);
        } catch (retryErr) {
          err = retryErr; // try the next candidate, or fall through below
        }
      }

      if (isPermanentFailure(err) || aiAvailable === null) {
        // No usable credentials/model — use the deterministic router from here on.
        aiAvailable = false;
        lastError = `${err.status || "error"} ${String(err.message || "").slice(0, 80)}`;
        sessions.clear();
        addStep(episode, STEP.FALLBACK,
          `${provider.label} unavailable (${err.status || "error"}) — switching to the rule-based router for this session`);
        console.warn(
          `[portsense] ${provider.label} unavailable (${err.status || "error"}: ${err.message}). ` +
          `Falling back to the rule-based router.`
        );
      } else {
        // Transient (rate limit, 5xx) on a previously working provider: answer
        // this turn with rules but keep trying the model on later turns.
        addStep(episode, STEP.FALLBACK, `${provider.label} failed transiently (${err.status || "error"}) — answering from rules, will retry the model next turn`);
        console.warn(`[portsense] ${provider.label} call failed transiently: ${err.message}`);
        session.history = snapshot; // discard the partial turn so the next call is well-formed
        return finish({ ...answerWithRules(question, episode), note: "transient-ai-error" });
      }
    }
  }
  return finish(answerWithRules(question, episode));
}

// ---------------------------------------------------------------------------
// Autonomous event ingestion
// ---------------------------------------------------------------------------
// Inputs that are not user requests — operational alerts, state changes,
// process metrics — enter here. The agent analyses them unprompted, decides a
// course of action, and escalates when severity warrants a human.

const AUTONOMOUS_PROMPT = `An operational event has just been raised by the terminal's monitoring systems. Analyse it and respond with:
1. What the issue is, in one line.
2. The operational impact — which berth, vessel, yard block or gate lane it threatens.
3. A recommended course of action, concrete and ranked.
Call the tools you need to establish the current picture before recommending; do not speculate about state you have not checked. Be brief — this is an ops bulletin, not an essay.`;

const INGEST_NOTE = {
  operational_alert: "Equipment alarm ingested — no operator prompted this; assessing severity and impact",
  state_change: "Vessel state change ingested — assessing berth-window impact",
  process_metric: "Yard KPI breach ingested — assessing whether intervention is warranted",
  event_log: "Gate log anomaly ingested — assessing throughput impact",
};

export async function handleEvent({ triggerType, summary, detail = null }) {
  const episode = startEpisode({ triggerType, summary, detail });
  addStep(episode, STEP.ANALYSIS, INGEST_NOTE[triggerType] || "Autonomous ingest — assessing severity and impact");

  const severity = detail?.severity || "warning";

  try {
    // Background analysis yields to operator questions: it may only use part of
    // the per-minute budget, so a human asking something always gets the model.
    if (aiAvailable !== false && !canSpend({ autonomous: true, budgeted: 4 })) {
      const r = rateStatus();
      addStep(episode, STEP.FALLBACK,
        `Reserving remaining model budget for operator questions (${r.used}/${r.budget} used this minute) — assessing with rules instead`);
      throw Object.assign(new Error("rate budget reserved for operators"), { status: 429, quiet: true });
    }
    if (aiAvailable !== false) {
      const session = { history: [] }; // one-shot context; not tied to a browser
      const prompt = `${AUTONOMOUS_PROMPT}\n\nEVENT: ${summary}\nDETAIL: ${JSON.stringify(detail)}`;
      const answer = provider.kind === "claude"
        ? await askClaude(prompt, session, episode)
        : await askOpenAICompatible(prompt, session, episode);
      addStep(episode, STEP.PLAN, answer.text.slice(0, 400));
      if (severity === "critical") {
        escalate(episode, { reason: `${summary} — agent recommendation issued`, severity });
      }
      if (episode.status !== "awaiting_approval") {
        endEpisode(episode, "completed", "Recommendation posted to operators");
      }
      return { ...answer, episodeId: episode.id };
    }
  } catch (err) {
    // `quiet` marks the deliberate budget-reservation path, already traced above.
    if (!err.quiet) {
      addStep(episode, STEP.FALLBACK, `Model unavailable during autonomous analysis (${err.status || "error"}) — using rule-based assessment`);
    }
  }

  // Rule-based autonomous assessment — keeps this path working with no API key.
  const assessment = assessEventWithRules({ triggerType, severity, detail, summary, episode });
  addStep(episode, STEP.PLAN, assessment.text);
  if (severity === "critical") {
    escalate(episode, { reason: `${summary} — automatic escalation on critical severity`, severity });
  }
  if (episode.status !== "awaiting_approval") {
    endEpisode(episode, "completed", "Recommendation posted to operators");
  }
  return { ...assessment, episodeId: episode.id };
}

// Deterministic assessment per input class. Mirrors what the model is asked to
// produce (issue → impact → ranked action) so the trace reads the same either
// way, and so the no-key path is a real fallback rather than a stub.
function assessEventWithRules({ triggerType, severity, detail = {}, summary, episode }) {
  const toolsUsed = [];
  const run = (name, input) => {
    toolsUsed.push(name);
    return runTool(name, input, episode);
  };
  const lines = [`${severity === "critical" ? "CRITICAL" : "Warning"}: ${summary}`];
  let view = "equipment";

  if (triggerType === "state_change") {
    view = "arrivals";
    const v = run("predict_vessel_arrival", { vessel: detail.vessel || "" });
    if (v.error) {
      addStep(episode, STEP.UNCERTAINTY, `Could not resolve vessel: ${v.error}`);
    } else {
      lines.push(`Predicted ETA now ${new Date(v.predictedEta).toUTCString().slice(5, 22)} (confidence ${Math.round(v.confidence * 100)}%).`);
      if (v.confidence < 0.8) {
        addStep(episode, STEP.UNCERTAINTY, `Prediction confidence ${Math.round(v.confidence * 100)}% — treat the revised ETA as provisional`);
        lines.push("Confidence is below 80% — treat this ETA as provisional and re-check before committing the berth.");
      }
    }
    lines.push(
      Math.abs(detail.driftHours || 0) >= 4
        ? `Recommended: release berth ${detail.berth} to the next arrival and re-plan this vessel's window; notify the berth planner.`
        : `Recommended: hold berth ${detail.berth} but rebuild the labour roster around the revised window.`
    );

  } else if (triggerType === "process_metric") {
    view = "yard";
    const y = run("get_yard_status", {});
    const recs = run("get_reshuffle_recommendations", { window_hours: 12 });
    lines.push(`Yard at ${detail.utilisationPct}% across ${y.blocks?.length ?? "?"} blocks; ${detail.projectedRehandles} rehandles projected.`);
    lines.push(
      recs.recommendations?.length
        ? `Recommended: pre-shuffle the top ${Math.min(3, recs.recommendations.length)} buried boxes during the next crane idle window — that removes ${detail.avoidableRehandles} of the projected rehandles.`
        : "Recommended: no pre-shuffle candidates; hold and re-evaluate after the next discharge."
    );

  } else if (triggerType === "event_log") {
    view = "equipment";
    lines.push(`${detail.affectedTransactions} of ${detail.batchSize} sampled transactions exceeded the normal band (${detail.normalRangeMin?.join("–")} min).`);
    const fleet = run("get_equipment_status", { only_unhealthy: true });
    if (fleet.length) {
      lines.push(`${fleet.length} machine(s) currently degraded — a slow gate often reflects yard-side congestion rather than the lane itself.`);
      lines.push(`Recommended: check ${fleet.map((e) => e.id).join(", ")} before assuming a gate fault; if the fleet is healthy, open a second lane.`);
    } else {
      addStep(episode, STEP.UNCERTAINTY, "No degraded equipment found — root cause not determinable from available signals");
      lines.push(`Recommended: fleet is healthy, so the constraint is likely the lane itself — open a second ${detail.lane?.startsWith("GATE-IN") ? "inbound" : "outbound"} lane and re-measure.`);
    }

  } else {
    // operational_alert — equipment alarm
    const equipmentId = detail.equipmentId || null;
    const reading = equipmentId ? run("get_sensor_readings", { equipment_id: equipmentId }) : null;
    const fleet = run("get_equipment_status", { only_unhealthy: true });
    if (reading && reading.error) {
      addStep(episode, STEP.UNCERTAINTY, `Could not read sensors for ${equipmentId}: ${reading.error}`);
    }
    const spares = (run("get_equipment_status", {}) || [])
      .filter((e) => e.health === "good" && e.type === (reading?.type || ""))
      .map((e) => e.id).slice(0, 2);
    if (reading && !reading.error) {
      const worst = Object.values(reading.sensors).find((s) => s.current >= s.crit)
        || Object.values(reading.sensors).find((s) => s.current >= s.warn);
      if (worst) lines.push(`${worst.label} at ${worst.current} ${worst.unit} (warn ${worst.warn}, critical ${worst.crit}).`);
      lines.push(`Operator on duty: ${reading.operator.name} (${reading.operator.channel}).`);
    }
    lines.push(
      severity === "critical"
        ? `Recommended: stop assigning new moves to ${equipmentId || "the affected unit"}, raise a maintenance job, and redistribute work${spares.length ? ` to ${spares.join(" / ")}` : ""}.`
        : `Recommended: keep ${equipmentId || "the unit"} in service but inspect at the next shift change; re-check the trend within the hour.`
    );
    if (fleet.length > 1) lines.push(`Note: ${fleet.length} machines are degraded — check fleet capacity before reassigning work.`);
  }

  return {
    text: lines.join("\n"),
    view,
    toolsUsed,
    mode: aiAvailable === false ? "rules" : "ai",
    provider: getProviderLabel(),
  };
}
