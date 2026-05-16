const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const MAX_RETRIES = 3;

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

export async function chat(
  systemPrompt: string,
  messages: ChatMessage[]
): Promise<string> {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: parseInt(process.env.MAX_TOKENS || "1024"),
    temperature: parseFloat(process.env.TEMPERATURE || "0.8"),
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
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
      return data.choices[0].message.content;
    }

    // Rate limited — wait and retry
    if (res.status === 429 && attempt < MAX_RETRIES - 1) {
      const text = await res.text();
      const retryMatch = text.match(/"retry_after_seconds":(\d+)/);
      const waitSec = retryMatch ? parseInt(retryMatch[1]) : 20;
      console.log(`[OpenRouter] Rate limited, retrying in ${waitSec}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitSec * 1000);
      continue;
    }

    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  throw new Error("OpenRouter: max retries reached");
}
