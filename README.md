# ⚓ PortSense — Agentic Port Operations Assistant

**PSA Code Sprint** submission covering three solution areas behind a single agentic interface:

| # | Solution area | What PortSense does |
|---|---------------|---------------------|
| 1 | **Unpredictable arrival timings** | Scheduled vs AI-predicted ETAs per vessel, delay variance, confidence, and the contributing delay factors (weather, upstream congestion, engine derating…) |
| 2 | **Yard reshuffling / digging** | Dig-out plans for any buried container (relocations + crane minutes) and ranked pre-emptive reshuffle recommendations for containers due soon |
| 3 | **Equipment predictive maintenance** | Continuous sensor monitoring (temperature, vibration, hydraulic pressure, drive current) on a **configurable sampling interval**; anomaly detection raises alerts and pages the assigned operator |

The **agentic workflow**: operators ask questions in plain language ("Why is Kota Harmoni late?", "What should we reshuffle before tonight?", "Sample sensors every 10 seconds"). The agent picks the right tool(s), answers from live terminal state, and the dashboard **automatically switches to the relevant solution panel**.

The agent runs on **Google Gemini's free tier** by default — no credit card, no billing risk during judging.

## How it meets the agentic requirements

| Requirement | Where it happens | See it in the demo |
|---|---|---|
| **Process varied inputs** — event log, state change, operational alert, process metric, user request | Operator questions enter via `POST /api/chat`; the simulator pushes **operational alerts** straight into the agent through `setEventSink` ([simulator.js](server/simulator.js)) — no human prompt needed | Agent Trace tab shows episodes tagged `operator request` **and** `operational alert` |
| **Analyse input, identify the objective** | Every episode opens with an `analysis` step; autonomous events are assessed for severity and impact | First two rows of any trace episode |
| **Determine a course of action** | `plan` step — for alerts the agent recommends concrete steps (stop assigning moves, raise a maintenance job, redistribute to named spare units) | Wait ~1–2 min for the RTG-02 critical alert |
| **Orchestrate tools/systems/workflows** | 11 tools over vessels, yard and equipment, driven in a multi-step loop; all calls funnel through one `runTool` choke point | `tool call` / `result` steps with real arguments |
| **Handle uncertainty & incomplete information** | Ambiguous input triggers a clarifying question instead of a guess; low-confidence predictions are flagged; missing data is stated, never invented | Ask *"the crane is playing up"* → agent asks which of the 7 units |
| **Handle tool failures** | Tool errors are captured as `tool_error` and returned to the model to recover from; provider outages fall back to the rule-based router; a retired model ID is auto-rediscovered | Trace shows `fallback` / `tool error` steps when they occur |
| **Human review, approval, escalation** | Read-only tools run freely; **state-changing tools are proposed, not executed** ([approvals.js](server/approvals.js)) and wait for operator Approve/Reject. Critical severity auto-escalates to the Duty Terminal Manager | Ask *"sample sensors every 30 seconds"* → approval card appears, interval does **not** change until you approve |
| **Clear execution trace** | Every episode records input → analysis → plan → tool calls (with arguments) → results/errors → approvals → actions → escalations → outcome, streamed live over SSE | **Agent Trace** tab; click any episode to expand |

The design decision worth calling out: an autonomous model should not silently
reconfigure equipment monitoring in a live port. Anything that mutates terminal
state is a **proposal** with a stated risk level and rationale, and the trace
records who approved it and when.

## Architecture

```
┌─────────────────────────── Browser ────────────────────────────┐
│  Dashboard (arrivals / yard / equipment / alerts)  +  Chat dock │
└───────────────┬───────────────────────────▲────────────────────┘
                │ POST /api/chat            │ SSE /api/stream (ticks + alerts)
┌───────────────▼───────────────────────────┴────────────────────┐
│                     Express server (Node 18+)                   │
│  agent.js ── provider-agnostic tool-calling loop:               │
│      │       • Gemini / Groq / Cerebras / OpenRouter (one       │
│      │         OpenAI-compatible adapter, picked by base URL)   │
│      │       • Claude (Anthropic Messages API)                  │
│      │       • rule-based router — no key, no network needed    │
│  tools.js ── 11 tools over live terminal state                  │
│  simulator.js ── sensor sampling loop (configurable interval),  │
│                  anomaly detection, operator paging             │
│  state.js ── vessels · yard blocks/stacks · equipment fleet     │
└─────────────────────────────────────────────────────────────────┘
```

**Agent tools:** `get_vessel_arrivals`, `predict_vessel_arrival`, `get_yard_status`, `plan_container_retrieval`, `get_reshuffle_recommendations`, `get_equipment_status`, `get_sensor_readings`, `set_monitoring_interval`, `get_alerts`, `acknowledge_alert`, `simulate_fault`.

Each tool is mapped to a dashboard view; the chat response carries a `view` directive so the UI opens the panel matching the question.

## Run locally

```bash
cd portsense
npm install
cp .env.example .env
# paste your free Gemini key into .env as GEMINI_API_KEY=...
npm start                   # http://localhost:3000
```

**Getting the free Gemini key** (2 minutes, no credit card): go to
[aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in with a Google
account, click **Create API key**, and copy it into `.env`. The free tier allows
~15 requests/minute and 1,500/day on `gemini-2.5-flash` — far more than a demo needs.

Verify the key works and see which models it can reach:

```bash
npm run models
```

### Swapping providers

The provider is auto-detected from whichever key is present in `.env`, so switching
is a one-line change — no code edits:

| Provider | Env var | Free tier | Get a key |
|---|---|---|---|
| **Gemini** (default) | `GEMINI_API_KEY` | 15 RPM / 1,500 per day | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Groq | `GROQ_API_KEY` | ~14,400 per day, very fast | [console.groq.com/keys](https://console.groq.com/keys) |
| Cerebras | `CEREBRAS_API_KEY` | ~1M tokens/day | [cloud.cerebras.ai](https://cloud.cerebras.ai) |
| OpenRouter | `OPENROUTER_API_KEY` | varies by `:free` model | [openrouter.ai/keys](https://openrouter.ai/keys) |
| Claude | `ANTHROPIC_API_KEY` | paid | [console.anthropic.com](https://console.anthropic.com) |
| *(none)* | — | rule-based router, works offline | — |

Force one explicitly with `AGENT_PROVIDER=gemini|groq|cerebras|openrouter|claude|rules`,
override the model with `GEMINI_MODEL=...`, or point at a local/self-hosted
OpenAI-compatible server (Ollama, LM Studio) with `AGENT_BASE_URL=...`.

**Resilience:** if the provider is unreachable, rate-limited, or the key is bad, the agent
degrades to the rule-based router instead of erroring — the demo never dies mid-presentation.
Rate limits and 5xx are retried on the next question; auth failures switch over for the session.
The header pill always shows which mode is live.

## Deploy

**→ Step-by-step Render free-tier guide: [DEPLOY.md](DEPLOY.md)** — gives judges a
public URL where the AI works without them needing any key.

Any Node host works — the app is a single process with no database.

**Docker (works on Render, Railway, Fly.io, AWS App Runner, Azure Container Apps…):**

```bash
docker build -t portsense .
docker run -p 3000:3000 -e GEMINI_API_KEY=your-key portsense
```

**Render/Railway without Docker:** point at this folder, build command `npm install`, start command `npm start`, add `GEMINI_API_KEY` as an environment variable.

## Demo script (suggested)

1. **Arrivals** — ask *"Which vessels are predicted to arrive late, and why is Temasek Glory delayed?"* → agent lists delayed vessels with delay factors; UI shows the Arrivals panel.
2. **Yard** — ask *"What should we reshuffle before tonight?"* then *"Plan the dig-out for CNTR-0042"* → recommendations + a visual dig plan.
3. **Maintenance** — wait ~1 minute: RTG-02's gearbox vibration climbs, a **warning then critical alert** fires live (toast + operator page). Ask *"Any anomalies?"* and *"Sample the sensors every 5 seconds"* → the agent reconfigures the monitoring cadence.
4. **Alerts** — ask *"Acknowledge AL-001"*.

Two demo faults are scripted so alerts always appear: QC-03 runs hot (warning) and RTG-02 vibration climbs to critical ~1–2 min after startup. You can also ask the agent to *"simulate a fault on AGV-02"*.

## Notes

- Terminal data (vessels, yard, sensors) is simulated in-memory; swap `server/state.js` + `server/simulator.js` for real TOS / IoT feeds — the agent and tool layer stay unchanged.
- The agent uses the stable Anthropic Messages API (`claude-opus-4-8`, adaptive thinking) with prompt caching on the system prompt.
