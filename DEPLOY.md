# Deploying PortSense to Render (free tier)

Goal: a public URL judges can open where **the AI agent already works** — they
need no API key, no signup, and no local setup.

The repo is already committed and `render.yaml` is in place, so Render
configures itself. Your part is four steps, about 10 minutes.

---

## Step 1 — Get a free Gemini API key (2 min)

This is the one credential the deployment needs. It lives **only** in Render's
environment settings, never in the repo, and judges never see or need it.

1. Go to **https://aistudio.google.com/apikey**
2. Sign in with any Google account
3. Click **Create API key** → **Create API key in new project**
4. Copy the key (starts with `AIza...`)

No credit card. Free tier is ~15 requests/minute and 1,500/day — far more than
a judging session uses.

> There is no way to host an LLM-backed agent with *no* key at all. What this
> setup does is put **your** key server-side so that **judges don't need one**.

---

## Step 2 — Push the repo to GitHub (3 min)

The code is already committed locally. Create an empty repo on GitHub
(**https://github.com/new** — name it `portsense`, don't add a README), then:

```bash
cd "PSA Code Sprint/portsense"
git remote add origin https://github.com/<your-username>/portsense.git
git branch -M main
git push -u origin main
```

Confirm on GitHub that **`.env` is NOT in the file list** (it's gitignored — but
check, because a leaked key gets scraped and auto-revoked within minutes).

---

## Step 3 — Deploy on Render (3 min)

1. Sign up at **https://render.com** (free, GitHub login is easiest)
2. Click **New +** → on the "Create a new Service" page choose **Web Services**
   → **New Web Service**
3. Connect your GitHub account and pick the `portsense` repo
4. Fill in the settings:

   | Field | Value |
   |---|---|
   | Language / Runtime | `Node` |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | **Instance Type** | **Free** — Render often preselects a paid plan, so check this |
   | Health Check Path (under Advanced) | `/healthz` |

5. Expand **Environment Variables** and add:
   - `GEMINI_API_KEY` → the key from Step 1
   - `AGENT_PROVIDER` → `gemini`
6. Click **Create Web Service**

First build takes ~2–3 minutes. When it finishes you get a URL like
`https://portsense.onrender.com`.

> **Blueprint alternative.** `render.yaml` in this repo does all of the above
> automatically, but Blueprints are a separate flow from the "Create a new
> Service" page — find them at **https://dashboard.render.com/blueprints** →
> **New Blueprint Instance**. Either route produces the same result; the manual
> Web Service form above is fine and only takes a minute longer.

---

## Step 4 — Verify the AI is live

Open your URL and check the header pill:

| Pill reads | Meaning |
|---|---|
| `agent: Gemini · gemini-2.5-flash` | ✅ AI is live — this is what judges should see |
| `agent: rule-based (no API key)` | ❌ key missing or rejected — see below |

Then ask the chat: *"Why is Kota Harmoni delayed?"* You should get a written
answer citing delay factors, and the dashboard should switch to Vessel Arrivals.

You can also hit `https://<your-url>/healthz` — it returns the active provider
and session count without needing the UI.

**If the pill says rule-based:** open Render → your service → **Logs**. A line
starting `[portsense] Gemini unavailable` gives the reason. Most common causes
are a mistyped key, or the key's Google Cloud project not having the Generative
Language API enabled (AI Studio normally does this for you).

---

## Important: free-tier cold starts

Render free services **spin down after ~15 minutes of inactivity**. The next
visitor waits **~50 seconds** for the container to wake — they'll see a blank
tab, which looks broken during judging.

Two mitigations:

**A. Keep it warm during the judging window (recommended).** Set up a free
uptime pinger against your `/healthz` endpoint:

- **https://uptimerobot.com** or **https://cron-job.org** (both free)
- Monitor type: HTTPS, URL `https://<your-url>/healthz`, interval **10 minutes**

Note this consumes your free instance hours: staying awake 24/7 uses roughly
744 of Render's 750 free hours per month. That's fine if PortSense is your only
free service — otherwise enable the pinger only for the days judging happens.

**B. Warm it yourself before the demo.** Open the URL ~2 minutes before
presenting and leave the tab open.

Either way, add a line to your submission: *"First load may take up to a minute
while the free instance wakes."*

---

## What judges experience

- Open the URL — no login, no key, no install
- Full dashboard: vessel arrivals, yard reshuffling, equipment health, alerts
- Live sensor stream; RTG-02 climbs into a critical vibration alert ~1–2 minutes
  after the instance starts, with the operator paged
- Working AI chat, on your key
- Each judge gets their **own** conversation thread (sessions are isolated), while
  sharing the same live terminal state — which is realistic for an ops console
- If the Gemini quota is ever exhausted mid-demo, the agent degrades to the
  built-in rule-based router and keeps answering instead of erroring

---

## Alternative: judges run it locally with no key

Worth putting in the submission as a fallback — it needs no credentials at all:

```bash
git clone https://github.com/<your-username>/portsense.git
cd portsense && npm install && npm start   # http://localhost:3000
```

Every panel, the live sensor stream, alerts, and the chat all work; the agent
uses the deterministic router instead of Gemini.
