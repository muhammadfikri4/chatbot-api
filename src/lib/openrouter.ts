const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODELS = (process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
const MAX_ATTEMPTS = 2;
const TIMEOUT_MS = 30000;

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

interface OpenRouterResponse {
  choices: { message: { content: string } }[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(body: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
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
      const res = await fetchWithTimeout(body);

      if (res.ok) {
        const data: OpenRouterResponse = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          console.error(`[OpenRouter] ${model} returned empty response`);
          return null;
        }
        console.log(`[OpenRouter] Success with model: ${model}${attempt > 0 ? " (retry)" : ""}`);
        lastUsedModel = model;
        return content;
      }

      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const text = await res.text();
        const retryMatch = text.match(/"retry_after_seconds":(\d+)/);
        const waitSec = retryMatch ? parseInt(retryMatch[1]) : 10;
        console.log(`[OpenRouter] ${model} rate limited, retrying in ${waitSec}s`);
        await sleep(waitSec * 1000);
        continue;
      }

      const text = await res.text();
      console.error(`[OpenRouter] ${model} failed (${res.status}): ${text.slice(0, 200)}`);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.name : String(err);
      console.error(`[OpenRouter] ${model} error: ${msg}${attempt < MAX_ATTEMPTS - 1 ? ", retrying" : ""}`);
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
    console.log(`[OpenRouter] Trying model: ${model}`);
    const result = await tryModel(model, messages, systemPrompt);
    if (result) return result;
  }

  throw new Error(`OpenRouter: all models failed (${MODELS.join(", ")})`);
}
