const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODELS = (process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

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

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (res.ok) {
    const data: OpenRouterResponse = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.error(`[OpenRouter] ${model} returned empty response`);
      return null;
    }
    console.log(`[OpenRouter] Success with model: ${model}`);
    return content;
  }

  // Rate limited — wait once then retry
  if (res.status === 429) {
    const text = await res.text();
    const retryMatch = text.match(/"retry_after_seconds":(\d+)/);
    const waitSec = retryMatch ? parseInt(retryMatch[1]) : 10;
    console.log(`[OpenRouter] ${model} rate limited, retrying in ${waitSec}s`);
    await sleep(waitSec * 1000);

    const res2 = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (res2.ok) {
      const data: OpenRouterResponse = await res2.json();
      console.log(`[OpenRouter] Success with model: ${model} (retry)`);
      return data.choices[0].message.content;
    }

    console.log(`[OpenRouter] ${model} still failed after retry, switching model`);
    return null;
  }

  // Other error
  const text = await res.text();
  console.error(`[OpenRouter] ${model} failed (${res.status}): ${text.slice(0, 200)}`);
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
