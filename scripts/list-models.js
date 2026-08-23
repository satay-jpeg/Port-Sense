// Lists the models your API key can actually reach, so you don't have to guess
// which model IDs are live on the free tier this month.
//   npm run models
import "dotenv/config";
import OpenAI from "openai";

const PROVIDERS = {
  gemini: ["GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai/"],
  groq: ["GROQ_API_KEY", "https://api.groq.com/openai/v1"],
  cerebras: ["CEREBRAS_API_KEY", "https://api.cerebras.ai/v1"],
  openrouter: ["OPENROUTER_API_KEY", "https://openrouter.ai/api/v1"],
};

const wanted = (process.env.AGENT_PROVIDER || "").toLowerCase().trim();

// Anthropic has a fixed model set and no discovery endpoint in this flow, so
// there is nothing to list — say so instead of failing with "no provider key".
if (wanted === "claude" || wanted === "anthropic") {
  console.log(
    "\nAGENT_PROVIDER is set to Anthropic, which uses a fixed model " +
    "(claude-opus-4-8) — there's no model list to discover.\n\n" +
    "This script is for the OpenAI-compatible providers (Gemini, Groq, " +
    "Cerebras, OpenRouter).\nTo check those, temporarily comment out " +
    "AGENT_PROVIDER in .env and re-run.\n"
  );
  process.exit(0);
}

const entry = Object.entries(PROVIDERS).find(
  ([name, [keyEnv]]) => (wanted ? name === wanted : process.env[keyEnv])
);

if (!entry) {
  console.error(
    "No provider key found. Set GEMINI_API_KEY (or GROQ_/CEREBRAS_/OPENROUTER_) in .env first.\n" +
    "Get a free Gemini key at https://aistudio.google.com/apikey"
  );
  process.exit(1);
}

const [name, [keyEnv, baseURL]] = entry;
if (!process.env[keyEnv]) {
  console.error(`AGENT_PROVIDER=${name} but ${keyEnv} is not set in .env`);
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env[keyEnv],
  baseURL: process.env.AGENT_BASE_URL || baseURL,
});

// Mirrors modelScore() in server/agent.js — kept as a local copy so this script
// doesn't pull in the whole server module graph. Tuned for free-tier quota
// rather than raw capability: on Gemini's free tier, Flash-Lite allows 15
// req/min and 1,000/day while preview models are far tighter, and a model that
// answers every time beats a stronger one that spends the demo rate-limited.
function score(id) {
  let s = 0;
  if (/flash/i.test(id)) s += 100;
  if (/lite/i.test(id)) s += 12;
  if (/pro/i.test(id)) s -= 60;
  if (/exp|preview|thinking/i.test(id)) s -= 40;
  const ver = parseFloat((id.match(/(\d+\.?\d*)/) || [])[1] || "0");
  s += ver <= 2.9 ? ver * 2 : -ver;
  return s;
}

try {
  const res = await client.models.list();
  const ids = res.data.map((m) => String(m.id).replace(/^models\//, "")).sort();
  const chat = ids.filter((id) => !/embed|aqa|imagen|veo|tts|image|vision/i.test(id));
  const best = chat.slice().sort((a, b) => score(b) - score(a))[0];

  console.log(`\n${name} — ${ids.length} models reachable with this key\n`);
  console.log("Chat-capable (usable by PortSense):");
  for (const id of chat) console.log(`  ${id === best ? "★" : " "} ${id}`);
  const others = ids.filter((id) => !chat.includes(id));
  if (others.length) console.log(`\nOther (embedding/image/audio — not usable): ${others.length}`);

  if (best) {
    console.log(`\n★ Recommended: ${best}`);
    console.log(`\nPin it locally in .env:\n  ${name.toUpperCase()}_MODEL=${best}`);
    console.log(`On Render, add the same as an environment variable:\n  ${name.toUpperCase()}_MODEL = ${best}\n`);
  } else {
    console.log("\nNo chat-capable models found for this key.\n");
  }
} catch (err) {
  console.error(`Failed to list models for ${name}: ${err.status || ""} ${err.message}`);
  if (err.status === 401 || err.status === 403) {
    console.error("That usually means the API key is wrong or not yet activated.");
  }
  process.exit(1);
}
