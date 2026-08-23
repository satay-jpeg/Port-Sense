// Human-in-the-loop gate.
//
// Read-only tools run freely. Anything that changes terminal state is proposed
// rather than executed: the agent gets back "awaiting approval", the operator
// sees an Approve / Reject control, and only then does the tool run. This is
// the honest design for a port — an autonomous model should not be silently
// reconfiguring equipment monitoring.

import { executeTool } from "./tools.js";
import { addStep, markAwaitingApproval, endEpisode, STEP, summariseResult } from "./trace.js";
import { notificationLog } from "./state.js";

// Anything not listed here is treated as read-only.
export const WRITE_TOOLS = {
  set_monitoring_interval: {
    risk: "medium",
    describe: (a) => `Change sensor sampling interval to ${a.seconds}s for all equipment`,
    why: "Alters how quickly every machine's anomalies are detected.",
  },
  acknowledge_alert: {
    risk: "medium",
    describe: (a) => `Acknowledge alert ${String(a.alert_id || "").toUpperCase()}`,
    why: "Closing an alert stops it being surfaced to operators.",
  },
  simulate_fault: {
    risk: "high",
    describe: (a) => `Inject a simulated fault into ${String(a.equipment_id || "").toUpperCase()}`,
    why: "Drives a machine into an alarm state.",
  },
};

export function requiresApproval(toolName) {
  return Object.prototype.hasOwnProperty.call(WRITE_TOOLS, toolName);
}

// The supervisor an escalation goes to when severity warrants a human decision.
export const SUPERVISOR = { name: "Duty Terminal Manager", channel: "ops-bridge x4400" };

const pending = new Map(); // id -> record
let seq = 1;

export function proposeAction({ tool, args, episode, rationale }) {
  const spec = WRITE_TOOLS[tool];

  // A model that sees "awaiting approval" may call the same tool again on the
  // next loop iteration. Collapse identical pending proposals into one so the
  // operator isn't asked to approve the same action twice.
  const fingerprint = JSON.stringify({ tool, args: args || {} });
  const existing = [...pending.values()].find(
    (r) => r.status === "pending" && JSON.stringify({ tool: r.tool, args: r.args || {} }) === fingerprint
  );
  if (existing) {
    // Track every episode waiting on this proposal so they all get closed out
    // when the operator decides — otherwise duplicates hang forever.
    if (episode && !existing.episodeIds.includes(episode.id)) existing.episodeIds.push(episode.id);
    addStep(episode, STEP.APPROVAL_REQUIRED,
      `Already pending approval: ${existing.description}`, { approvalId: existing.id, tool, args, duplicate: true });
    markAwaitingApproval(episode);
    return existing;
  }

  const id = `APR-${String(seq++).padStart(3, "0")}`;
  const record = {
    id,
    tool,
    args,
    risk: spec.risk,
    description: spec.describe(args || {}),
    why: spec.why,
    rationale: rationale || null,
    episodeIds: episode ? [episode.id] : [],
    createdAt: new Date().toISOString(),
    status: "pending", // pending | approved | rejected
    result: null,
  };
  pending.set(id, record);

  addStep(
    episode,
    STEP.APPROVAL_REQUIRED,
    `Approval required (${spec.risk} risk): ${record.description}`,
    { approvalId: id, tool, args, why: spec.why }
  );
  markAwaitingApproval(episode);
  return record;
}

export function listApprovals({ includeResolved = false } = {}) {
  const all = [...pending.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return includeResolved ? all : all.filter((r) => r.status === "pending");
}

export function getApproval(id) {
  return pending.get(String(id).toUpperCase()) || null;
}

// Resolve a proposal. `episodeLookup` lets us append to the originating trace.
export function resolveApproval(id, decision, { by = "operator", reason = null, episodeLookup } = {}) {
  const record = getApproval(id);
  if (!record) return { error: `Approval '${id}' not found` };
  if (record.status !== "pending") {
    return { error: `Approval ${record.id} was already ${record.status}` };
  }

  // Every episode that proposed (or deduped onto) this action gets the outcome.
  const eps = episodeLookup ? record.episodeIds.map(episodeLookup).filter(Boolean) : [];
  const forEach = (fn) => eps.forEach(fn);

  if (decision !== "approve") {
    record.status = "rejected";
    record.resolvedAt = new Date().toISOString();
    forEach((ep) => {
      addStep(ep, STEP.APPROVAL_DENIED, `${by} rejected: ${record.description}${reason ? ` — ${reason}` : ""}`, { approvalId: record.id });
      endEpisode(ep, "completed", "Action not taken — rejected by operator.");
    });
    return { ok: true, record };
  }

  record.status = "approved";
  record.resolvedAt = new Date().toISOString();
  forEach((ep) => addStep(ep, STEP.APPROVAL_GRANTED, `${by} approved: ${record.description}`, { approvalId: record.id }));

  // Only now does the tool actually run.
  let result;
  try {
    result = executeTool(record.tool, record.args);
  } catch (err) {
    result = { error: String(err.message || err) };
  }
  record.result = result;

  if (result && result.error) {
    forEach((ep) => {
      addStep(ep, STEP.TOOL_ERROR, `${record.tool} failed: ${result.error}`, { tool: record.tool });
      endEpisode(ep, "failed", `Approved action could not be completed: ${result.error}`);
    });
  } else {
    forEach((ep) => {
      addStep(ep, STEP.ACTION, `Executed: ${record.description}`, { tool: record.tool, result: summariseResult(result) });
      endEpisode(ep, "completed", `Action completed: ${record.description}`);
    });
  }
  return { ok: true, record, result };
}

// Escalate to a human. Records on the trace and writes to the same dispatch log
// the equipment pager uses, so escalations appear alongside operator pages.
export function escalate(episode, { to = SUPERVISOR, reason, severity = "high" }) {
  const entry = {
    time: new Date().toISOString(),
    to: `${to.name} (${to.channel})`,
    text: `[ESCALATION · ${severity.toUpperCase()}] ${reason}`,
  };
  notificationLog.unshift(entry);
  addStep(episode, STEP.ESCALATION, `Escalated to ${to.name} (${to.channel}): ${reason}`, { severity });
  return entry;
}
