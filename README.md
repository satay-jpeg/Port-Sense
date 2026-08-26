# PortSense

**An agentic operations console for a PSA container terminal.**

PortSense watches a terminal, forms a view about what is happening, and proposes
what to do about it. It covers three problem areas — unpredictable vessel
arrivals, yard reshuffling, and equipment predictive maintenance — behind a
single agent that decides which of them a given input concerns.

The design position, stated up front: **an autonomous model should not be
allowed to change a live port.** Everything the agent does that only *reads* the
terminal runs freely. Everything that *changes* it is a proposal that waits for
a named human. The execution trace exists so that decision is auditable rather
than taken on trust.

---

## The idea

Most port software is reactive: it shows an operator a screen, and the operator
notices things. The gap that creates is attention. A duty operator watching ten
vessels, four yard blocks and ten machines will not notice that a gearbox has
been drifting for six minutes, or that a vessel's revised ETA has quietly
invalidated a berth window.

PortSense inverts that. The terminal's own signals — sensor readings, ETA
revisions, yard KPIs, gate logs — are treated as **inputs to an agent**, not
just as pixels for a human. The agent analyses each one, decides whether it
matters, gathers whatever additional state it needs, and produces a ranked
recommendation. A human still decides; they just no longer have to notice first.

---

## How it works

```
   INPUTS                        AGENT                         CONTROLS
┌──────────────────┐      ┌──────────────────────┐      ┌────────────────────┐
│ operator question│─────▶│                      │      │                    │
│ equipment alarm  │─────▶│  analyse → plan →    │─────▶│ read-only tools    │
│ vessel ETA change│─────▶│  call tools → decide │      │ run immediately    │
│ yard KPI breach  │─────▶│                      │      ├────────────────────┤
│ gate log anomaly │─────▶│                      │─────▶│ state-changing     │
└──────────────────┘      └──────────┬───────────┘      │ tools → PROPOSED,  │
                                     │                  │ await human        │
                                     ▼                  └────────────────────┘
                          ┌──────────────────────┐
                          │  EXECUTION TRACE     │  every decision, tool call,
                          │  (streamed live)     │  result, error, approval
                          └──────────────────────┘
```

### 1. Five kinds of input reach the agent

Only one of them is a human typing. The other four arrive on their own:

| Input | Source | Fires when |
|---|---|---|
| **Operator request** | Chat panel | Someone asks a question |
| **Operational alert** | `simulator.js` | A sensor crosses its critical threshold |
| **State change** | `monitors.js` | A vessel's predicted ETA drifts ≥ 1.5 h, threatening its berth window |
| **Process metric** | `monitors.js` | Yard utilisation ≥ 85%, or ≥ 25 rehandles projected in 12 h |
| **Event log** | `monitors.js` | A gate transaction batch contains a turnaround outlier |

The autonomous ones are threshold-driven and rate-limited, not on a timer. A
machine sitting in alarm does not re-trigger analysis every sampling tick; it
gets one assessment and a cooldown. This is both an operational choice (a noisy
agent is ignored) and a practical one (each analysis costs model quota).

### 2. The agent decides what the input means

Every input opens an **episode**. The agent states the objective, calls whatever
tools it needs to establish the current picture, and produces a plan. It has
twelve tools spanning the three problem areas:

`get_vessel_arrivals` · `predict_vessel_arrival` · `get_yard_status` ·
`plan_container_retrieval` · `get_reshuffle_recommendations` ·
`get_equipment_status` · `get_sensor_readings` · `set_monitoring_interval` ·
`get_alerts` · `acknowledge_alert` · `simulate_fault` · `request_clarification`

Tool selection is what routes the interface: each tool is mapped to a dashboard
panel, so asking about a buried container opens the yard view without anyone
navigating there.

### 3. Changing anything requires a human

Tools are split by consequence. Read-only tools execute immediately. The three
that mutate terminal state — changing the sensor sampling interval, acknowledging
an alert, injecting a fault — are **never executed by the agent**. They become
proposals carrying a risk level and a stated reason, and they sit in the
approvals queue until a person decides.

There is a second rung: **high-risk actions require a supervisor**, not merely
any signed-in user. That check is enforced server-side — an operator who calls
the approve endpoint directly gets a `403`, because hiding a button is not a
control.

Critical-severity events also **escalate** to the Duty Terminal Manager, logged
alongside the operator pager dispatches.

### 4. Uncertainty is surfaced, not smoothed over

Three distinct behaviours, all visible in the trace:

- **Ambiguous input** → the agent asks one specific question instead of guessing.
  "The crane is playing up" returns *"Which unit do you mean? That matches
  QC-01, QC-02, QC-03, RTG-01…"*. On the model-driven path this is a real tool
  call (`request_clarification`), so the ambiguity is recorded rather than
  inferred.
- **Missing information** → stated plainly. When a gate anomaly has no
  corresponding degraded equipment, the trace records *"root cause not
  determinable from available signals"* rather than inventing one.
- **Low confidence** → quoted. ETA predictions below 80% confidence are flagged
  provisional in both the table and the agent's own reasoning.

### 5. Failure is a designed path, not an exception

The system degrades in stages rather than breaking:

| Failure | What happens |
|---|---|
| A tool errors | Returned to the model as `is_error` so it can recover; recorded as `tool_error` |
| Model rate-limited | Agent self-throttles *before* the provider rejects it, and answers from the deterministic router |
| Model ID retired | Provider is queried for its live catalogue, models ranked, next viable one tried |
| Model returns bad tool arguments | Treated as a capability failure; the next-best model is tried |
| Provider down or key invalid | Whole session falls back to the rule-based router |
| No API key at all | Everything still works — the rule-based router covers all three problem areas |

That last row matters: **the application has no hard dependency on an LLM.**
The agent layer is an enhancement over a deterministic core, not a load-bearing
requirement. Autonomous analysis also yields to human questions — background
work may consume at most half the per-minute model budget, so an operator asking
something always gets the model.

### 6. Everything is auditable

The **Agent Trace** panel is the centrepiece. Each episode records, in order:
the input received, the objective identified, the plan chosen, every tool call
*with its arguments*, every result or error, any uncertainty declared, approvals
requested and granted or denied, actions executed, escalations raised, and the
outcome. Episodes stream live over SSE, including ones the agent starts on its
own while nobody is watching.

---

## Architecture

Single Node process, no build step, no database — all state is in memory.

| File | Responsibility |
|---|---|
| `server/state.js` | The simulated terminal: vessels, carriers, berths, yard blocks, containers, equipment. Also the reshuffle optimiser that prices a plan in rehandles, crane minutes, fuel and dollars. |
| `server/simulator.js` | Sensor sampling loop on a configurable interval; threshold detection; operator paging |
| `server/monitors.js` | The other three autonomous input sources — ETA drift, yard KPIs, gate logs |
| `server/agent.js` | Provider-agnostic agent: one OpenAI-compatible adapter (Gemini/Groq/Cerebras/OpenRouter), one Anthropic adapter, one deterministic router. Self-throttling, model rediscovery, fallback chain. |
| `server/tools.js` | The twelve tools and their schemas |
| `server/approvals.js` | Risk classification, the proposal queue, role checks, escalation |
| `server/trace.js` | Episode recording and live streaming |
| `server/auth.js` | scrypt-hashed accounts, signed HMAC session cookies |
| `public/` | The console — vanilla JS, no framework |

**Swapping the simulation for real systems** means replacing `state.js` and
`simulator.js` with feeds from a TOS and an IoT gateway. The agent, tools,
approval gate and trace are unchanged by that — they only ever see tool results.

### Model providers

The agent runs on a free-tier provider by default (Groq or Gemini). Provider is
auto-detected from whichever API key is present, so switching is an environment
variable rather than a code change. The deployed instance deliberately uses a
free tier: the chat endpoint is reachable by anyone with the URL, and a free key
caps the worst case at a rate limit rather than a bill.

---

## Seeing it run

```bash
npm install && npm start          # http://localhost:3000
```

Sign in with `operator` / `portsense` (pre-filled). A `supervisor` account with
the same password exists — needed for high-risk approvals.

Deployment notes are in [DEPLOY.md](DEPLOY.md).

Worth trying, in order:

1. **"Which vessels are predicted to arrive late?"** — tool selection routes the view
2. **"The crane is playing up"** — ambiguity produces a question, not a guess
3. **"Sample the sensors every 30 seconds"** — watch the interval *not* change until approved
4. **Agent Trace** — expand the `operational alert` episode nobody asked for
5. **Sign in as `supervisor`** — approve a high-risk action an operator cannot

The scripted faults mean an alert always appears: QC-03 runs hot within a minute,
RTG-02's gearbox vibration climbs to critical shortly after.

---

*Terminal data is simulated. PSA Code Sprint submission.*
