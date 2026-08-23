// Execution trace: an auditable record of everything the agent did in response
// to one input, whether that input was a human question or an autonomous event.
//
// One "episode" = one input processed end to end. Steps are appended as they
// happen and streamed to the dashboard, so an observer can see the decision
// path — not just the final answer.

const MAX_EPISODES = 60;
const episodes = [];
let seq = 1;
let broadcaster = null;

export const TRIGGER_TYPES = {
  USER_REQUEST: "user_request",
  OPERATIONAL_ALERT: "operational_alert",
  STATE_CHANGE: "state_change",
  PROCESS_METRIC: "process_metric",
  EVENT_LOG: "event_log",
};

// Step kinds, in rough order of appearance. Each maps to an icon in the UI.
export const STEP = {
  INPUT: "input",                     // what arrived
  ANALYSIS: "analysis",               // objective / issue identified
  PLAN: "plan",                       // chosen course of action
  TOOL_CALL: "tool_call",             // tool + arguments
  TOOL_RESULT: "tool_result",         // result summary
  TOOL_ERROR: "tool_error",           // failed tool
  UNCERTAINTY: "uncertainty",         // ambiguity / missing data noted
  CLARIFICATION: "clarification",     // question put back to the human
  APPROVAL_REQUIRED: "approval_required",
  APPROVAL_GRANTED: "approval_granted",
  APPROVAL_DENIED: "approval_denied",
  ACTION: "action",                   // state-changing action performed
  ESCALATION: "escalation",           // handed to a human/supervisor
  FALLBACK: "fallback",               // degraded path taken
  OUTCOME: "outcome",                 // final result
  ERROR: "error",                     // episode-level failure
};

export function setBroadcaster(fn) {
  broadcaster = fn;
}

function emit(episode) {
  if (broadcaster) broadcaster("trace", episode);
}

export function startEpisode({ triggerType, summary, detail = null, sessionId = null }) {
  const ep = {
    id: `TRC-${String(seq++).padStart(3, "0")}`,
    startedAt: new Date().toISOString(),
    endedAt: null,
    triggerType,
    summary,
    sessionId,
    status: "running", // running | awaiting_approval | completed | failed
    steps: [],
  };
  episodes.unshift(ep);
  if (episodes.length > MAX_EPISODES) episodes.pop();
  addStep(ep, STEP.INPUT, summary, detail);
  return ep;
}

export function addStep(ep, type, summary, detail = null) {
  if (!ep) return null;
  const step = { t: new Date().toISOString(), type, summary, detail };
  ep.steps.push(step);
  emit(ep);
  return step;
}

export function endEpisode(ep, status, summary) {
  if (!ep) return;
  ep.status = status;
  ep.endedAt = new Date().toISOString();
  if (summary) addStep(ep, status === "failed" ? STEP.ERROR : STEP.OUTCOME, summary);
  else emit(ep);
}

export function markAwaitingApproval(ep) {
  if (!ep) return;
  ep.status = "awaiting_approval";
  emit(ep);
}

export function listEpisodes(limit = 25) {
  return episodes.slice(0, limit);
}

export function getEpisode(id) {
  return episodes.find((e) => e.id === id) || null;
}

// Compact one-line summary of a tool result, so the trace stays readable
// regardless of how large the underlying payload is.
export function summariseResult(result) {
  if (result == null) return "no result";
  if (result.error) return `error: ${result.error}`;
  if (Array.isArray(result)) return `${result.length} record${result.length === 1 ? "" : "s"}`;
  if (typeof result === "object") {
    const arrayKey = Object.keys(result).find((k) => Array.isArray(result[k]));
    if (arrayKey) return `${result[arrayKey].length} ${arrayKey}`;
    if (result.message) return String(result.message);
    const keys = Object.keys(result).slice(0, 4).join(", ");
    return `object (${keys}${Object.keys(result).length > 4 ? ", …" : ""})`;
  }
  return String(result).slice(0, 120);
}
