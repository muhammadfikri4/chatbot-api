const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://localhost:3002/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_AUTH_USER = process.env.LLM_AUTH_USER || "";
const LLM_AUTH_PASS = process.env.LLM_AUTH_PASS || "";
const MODELS = (process.env.LLM_MODELS || "llama3")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MAX_ATTEMPTS = 2;
const TIMEOUT_MS = 120000;

export let lastUsedModel = "";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface ChatResponse {
  choices: { message: { content: string } }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(body: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (LLM_AUTH_USER) {
    headers["Authorization"] = "Basic " + Buffer.from(`${LLM_AUTH_USER}:${LLM_AUTH_PASS}`).toString("base64");
  } else if (LLM_API_KEY) {
    headers["Authorization"] = `Bearer ${LLM_API_KEY}`;
  }

  try {
    const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function tryModel(
  model: string,
  messages: ChatMessage[],
  systemPrompt: string
): Promise<string | null> {
  const body = JSON.stringify({
    model,
    max_tokens: parseInt(process.env.MAX_TOKENS || "1024"),
    temperature: parseFloat(process.env.TEMPERATURE || "0.8"),
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const start = Date.now();
      console.log(`[LLM] ${model} attempt ${attempt + 1}/${MAX_ATTEMPTS}, fetching...`);
      const res = await fetchWithTimeout(body);
      console.log(`[LLM] ${model} response received in ${Date.now() - start}ms, status: ${res.status}`);

      if (res.ok) {
        const data: ChatResponse = await res.json();
        console.log(`[LLM] ${model} body parsed in ${Date.now() - start}ms`);
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          console.error(`[LLM] ${model} returned empty response`);
          return null;
        }
        console.log(`[LLM] Success with model: ${model}${attempt > 0 ? " (retry)" : ""}`);
        lastUsedModel = model;
        return content;
      }

      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const text = await res.text();
        const retryMatch = text.match(/"retry_after_seconds":(\d+)/);
        const waitSec = retryMatch ? parseInt(retryMatch[1]) : 10;
        console.log(`[LLM] ${model} rate limited, retrying in ${waitSec}s`);
        await sleep(waitSec * 1000);
        continue;
      }

      const text = await res.text();
      console.error(`[LLM] ${model} failed (${res.status}): ${text.slice(0, 200)}`);
      return null;
    } catch (err) {
      const elapsed = Date.now();
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.error(`[LLM] ${model} error after attempt ${attempt + 1}: ${msg}`);
      if (attempt < MAX_ATTEMPTS - 1) continue;
      return null;
    }
  }

  return null;
}

export async function chat(
  systemPrompt: string,
  messages: ChatMessage[]
): Promise<string> {
  for (const model of MODELS) {
    console.log(`[LLM] Trying model: ${model}`);
    const result = await tryModel(model, messages, systemPrompt);
    if (result) return result;
  }

  throw new Error(`LLM: all models failed (${MODELS.join(", ")})`);
}
