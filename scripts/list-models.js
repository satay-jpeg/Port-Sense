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

const client = new OpenAI({ apiKey: process.env[keyEnv], baseURL });

try {
  const res = await client.models.list();
  const ids = res.data.map((m) => m.id).sort();
  console.log(`\n${name} — ${ids.length} models reachable with this key:\n`);
  for (const id of ids) console.log("  " + id);
  console.log(
    `\nSet the one you want in .env, e.g. ${name.toUpperCase()}_MODEL=${ids[0] || "<model-id>"}\n`
  );
} catch (err) {
  console.error(`Failed to list models for ${name}: ${err.status || ""} ${err.message}`);
  if (err.status === 401 || err.status === 403) {
    console.error("That usually means the API key is wrong or not yet activated.");
  }
  process.exit(1);
}
