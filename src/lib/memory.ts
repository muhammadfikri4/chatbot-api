import { ChromaClient, Collection, EmbeddingFunction } from "chromadb";

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8000";
const CHROMA_USERNAME = process.env.CHROMA_USERNAME || "";
const CHROMA_PASSWORD = process.env.CHROMA_PASSWORD || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

class OpenRouterEmbedding implements EmbeddingFunction {
  async generate(texts: string[]): Promise<number[][]> {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/text-embedding-3-small",
          input: texts,
        }),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          data: Array<{ embedding: number[] }>;
        };
        return data.data.map((d) => d.embedding);
      }
    } catch {
      // fallback below
    }

    return texts.map((text) => hashEmbed(text));
  }
}

function hashEmbed(text: string, dims = 1536): number[] {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    const idx = i % dims;
    vec[idx] += text.charCodeAt(i) / 255;
  }
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / magnitude);
}

let client: ChromaClient;
let collection: Collection;
let initialized = false;
const embeddingFn = new OpenRouterEmbedding();

async function init(): Promise<void> {
  if (initialized) return;

  const clientOptions: Record<string, unknown> = {};

  // Parse URL into host/port/ssl
  const url = new URL(CHROMA_URL);
  clientOptions.host = url.hostname;
  clientOptions.port = parseInt(url.port || (url.protocol === "https:" ? "443" : "8000"));
  clientOptions.ssl = url.protocol === "https:";

  if (CHROMA_USERNAME && CHROMA_PASSWORD) {
    clientOptions.headers = {
      Authorization: "Basic " + Buffer.from(`${CHROMA_USERNAME}:${CHROMA_PASSWORD}`).toString("base64"),
    };
  }

  client = new ChromaClient(clientOptions);

  collection = await client.getOrCreateCollection({
    name: "chat_memory",
    metadata: { description: "WhatsApp chat history for RAG" },
    embeddingFunction: embeddingFn,
  });

  initialized = true;
  console.log("[Memory] ChromaDB connected");
}

/**
 * Save a Q&A pair to ChromaDB — only if question is not similar to existing ones
 */
export async function saveQA(
  chatId: string,
  question: string,
  answer: string,
  sender: string
): Promise<void> {
  try {
    if (!question || question.length < 5) return;

    await init();

    // Check if similar question already exists
    try {
      const existing = await collection.query({
        queryTexts: [question],
        nResults: 1,
      });

      const existingId = existing?.ids?.[0]?.[0];
      const existingQ = existing?.documents?.[0]?.[0];
      const existingAnswer = existing?.metadatas?.[0]?.[0]?.answer;
      const distance = existing?.distances?.[0]?.[0];

      if (existingId && existingQ && typeof distance === "number" && distance < 0.3) {
        // Same question exists — update answer if different
        if (existingAnswer === answer) {
          console.log(`[Memory] Skip identical Q&A: "${question.slice(0, 40)}..."`);
          return;
        }

        // Update: delete old, save new with updated answer
        await collection.delete({ ids: [existingId] });
        console.log(`[Memory] Updating Q&A: "${question.slice(0, 40)}..."`);
      }
    } catch {
      // Collection might be empty, continue saving
    }

    const id = `qa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await collection.add({
      ids: [id],
      documents: [question],
      metadatas: [
        {
          chatId,
          sender,
          answer,
          timestamp: new Date().toISOString(),
          type: "qa",
        },
      ],
    });

    console.log(`[Memory] Saved Q&A: "${question.slice(0, 50)}..."`);
  } catch (err) {
    console.error("[Memory] Failed to save Q&A:", err);
  }
}

/**
 * Query relevant Q&A pairs from ChromaDB
 */
export async function queryMemory(
  query: string,
  limit = 5
): Promise<string[]> {
  try {
    await init();

    const results = await collection.query({
      queryTexts: [query],
      nResults: limit,
    });

    if (!results.documents?.[0]) return [];

    return results.documents[0]
      .filter((doc): doc is string => doc !== null)
      .map((doc, i) => {
        const meta = results.metadatas?.[0]?.[i];
        const answer = meta?.answer || "";
        const sender = meta?.sender || "unknown";
        return `Q (${sender}): ${doc}\nA: ${answer}`;
      });
  } catch (err) {
    console.error("[Memory] Failed to query:", err);
    return [];
  }
}

/**
 * Save knowledge entry to ChromaDB
 */
export async function saveKnowledge(content: string): Promise<void> {
  try {
    await init();

    const id = `knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await collection.add({
      ids: [id],
      documents: [content],
      metadatas: [
        {
          sender: "system",
          chatId: "knowledge",
          timestamp: new Date().toISOString(),
          type: "knowledge",
        },
      ],
    });
  } catch (err) {
    console.error("[Memory] Failed to save knowledge:", err);
  }
}
