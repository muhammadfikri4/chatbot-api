import fs from "fs";
import path from "path";
import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

const COLLECTION_NAME = "chat_memory";
const VECTOR_SIZE = 1536; // text-embedding-3-small

// --- Embedding ---

async function embed(texts: string[]): Promise<number[][]> {
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

function hashEmbed(text: string, dims = VECTOR_SIZE): number[] {
  const vec = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    const idx = i % dims;
    vec[idx] += text.charCodeAt(i) / 255;
  }
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / magnitude);
}

// --- Qdrant Client ---

let client: QdrantClient;
let initialized = false;

async function init(): Promise<void> {
  if (initialized) return;

  client = new QdrantClient({
    url: QDRANT_URL,
    ...(QDRANT_API_KEY ? { apiKey: QDRANT_API_KEY } : {}),
  });

  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: VECTOR_SIZE,
        distance: "Cosine",
      },
    });
  }

  initialized = true;
  console.log("[Memory] Qdrant connected");
}

function generatePointId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// --- Base Knowledge Overlap Detection ---

let baseKnowledgePhrases: string[] = [];

export function setBaseKnowledge(content: string): void {
  const lower = content.toLowerCase();

  const lines = lower
    .split("\n")
    .map((l) => l.replace(/^[#\-*>\s]+/, "").trim())
    .filter((l) => l.length > 3 && !l.startsWith("http"));

  const phrases = new Set<string>();

  for (const line of lines) {
    if (line.length > 5 && line.length < 80) {
      phrases.add(line);
    }

    const nameMatches = content.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/g) || [];
    for (const name of nameMatches) {
      phrases.add(name.toLowerCase());
    }

    const parenMatches = content.match(/\(([^)]+)\)/g) || [];
    for (const p of parenMatches) {
      const inner = p.slice(1, -1).toLowerCase();
      inner.split(/[,/]/).forEach((part) => {
        const clean = part.replace(/panggilan:|julukan:/gi, "").trim();
        if (clean.length > 2) phrases.add(clean);
      });
    }
  }

  baseKnowledgePhrases = [...phrases];
  console.log(`[Memory] Base knowledge phrases: ${baseKnowledgePhrases.length}`);
}

function overlapsBaseKnowledge(question: string, answer: string): boolean {
  if (baseKnowledgePhrases.length === 0) return false;

  const combined = (question + " " + answer).toLowerCase();

  let matchCount = 0;
  for (const phrase of baseKnowledgePhrases) {
    if (combined.includes(phrase)) {
      matchCount++;
    }
  }

  return matchCount >= 2;
}

// --- Knowledge Training (file → Qdrant) ---

function chunkMarkdown(content: string, source: string): Array<{ text: string; source: string }> {
  const chunks: Array<{ text: string; source: string }> = [];
  const lines = content.split("\n");

  let currentH1 = "";
  let currentH2 = "";
  let buffer: string[] = [];

  const flushBuffer = () => {
    const text = buffer.join("\n").trim();
    if (text.length > 10) {
      // Prepend header context
      let header = "";
      if (currentH1) header += currentH1;
      if (currentH2) header += (header ? " > " : "") + currentH2;

      const fullText = header ? `[${header}]\n${text}` : text;
      chunks.push({ text: fullText, source });
    }
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushBuffer();
      currentH2 = line.replace(/^##\s+/, "").trim();
    } else if (line.startsWith("# ")) {
      flushBuffer();
      currentH1 = line.replace(/^#\s+/, "").trim();
      currentH2 = "";
    } else {
      buffer.push(line);
    }
  }

  flushBuffer();
  return chunks;
}

/**
 * Train knowledge: read all .md files from knowledgeDir, chunk, embed, and index to Qdrant.
 * Replaces all existing knowledge_base entries.
 */
export async function trainKnowledge(knowledgeDir: string): Promise<number> {
  try {
    await init();

    if (!fs.existsSync(knowledgeDir)) return 0;

    const files = fs.readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return 0;

    // Collect all chunks from all files
    const allChunks: Array<{ text: string; source: string }> = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(knowledgeDir, file), "utf-8");
      const chunks = chunkMarkdown(content, file);
      allChunks.push(...chunks);
    }

    if (allChunks.length === 0) return 0;

    // Delete all existing knowledge_base entries
    try {
      await client.delete(COLLECTION_NAME, {
        filter: {
          must: [{ key: "type", match: { value: "knowledge_base" } }],
        },
      });
    } catch {
      // Collection might be empty
    }

    // Embed all chunks in batches of 20
    const BATCH_SIZE = 20;
    let indexed = 0;

    for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
      const batch = allChunks.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.text);
      const vectors = await embed(texts);

      const points = batch.map((chunk, j) => ({
        id: generatePointId(),
        vector: vectors[j],
        payload: {
          document: chunk.text,
          source: chunk.source,
          type: "knowledge_base",
          timestamp: new Date().toISOString(),
        },
      }));

      await client.upsert(COLLECTION_NAME, { points });
      indexed += batch.length;
    }

    console.log(`[Memory] Trained ${indexed} knowledge chunks from ${files.length} files`);
    return indexed;
  } catch (err) {
    console.error("[Memory] Failed to train knowledge:", err);
    return 0;
  }
}

// --- Manual Knowledge (via !knowledge add, stored in Qdrant only) ---

/**
 * Add a manual knowledge entry to Qdrant (does NOT modify base.md)
 */
export async function addManualKnowledge(content: string): Promise<void> {
  try {
    await init();

    const [vector] = await embed([content]);

    await client.upsert(COLLECTION_NAME, {
      points: [
        {
          id: generatePointId(),
          vector,
          payload: {
            document: content,
            type: "knowledge_manual",
            timestamp: new Date().toISOString(),
          },
        },
      ],
    });

    console.log(`[Memory] Saved manual knowledge: "${content.slice(0, 50)}..."`);
  } catch (err) {
    console.error("[Memory] Failed to save manual knowledge:", err);
  }
}

/**
 * List all manual knowledge entries from Qdrant
 */
export async function listManualKnowledge(): Promise<Array<{ id: string; content: string; timestamp: string }>> {
  try {
    await init();

    const result = await client.scroll(COLLECTION_NAME, {
      filter: {
        must: [{ key: "type", match: { value: "knowledge_manual" } }],
      },
      with_payload: true,
      limit: 100,
    });

    return result.points
      .map((p) => {
        const payload = p.payload as Record<string, unknown> | null;
        return {
          id: String(p.id),
          content: String(payload?.document || ""),
          timestamp: String(payload?.timestamp || ""),
        };
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch (err) {
    console.error("[Memory] Failed to list manual knowledge:", err);
    return [];
  }
}

/**
 * Delete a manual knowledge entry by index (1-based)
 */
export async function deleteManualKnowledge(index: number): Promise<{ success: boolean; content?: string }> {
  try {
    const entries = await listManualKnowledge();
    const idx = index - 1;

    if (idx < 0 || idx >= entries.length) {
      return { success: false };
    }

    const entry = entries[idx];
    await client.delete(COLLECTION_NAME, {
      points: [entry.id],
    });

    return { success: true, content: entry.content };
  } catch (err) {
    console.error("[Memory] Failed to delete manual knowledge:", err);
    return { success: false };
  }
}

/**
 * Clear all manual knowledge entries from Qdrant
 */
export async function clearManualKnowledge(): Promise<void> {
  try {
    await init();

    await client.delete(COLLECTION_NAME, {
      filter: {
        must: [{ key: "type", match: { value: "knowledge_manual" } }],
      },
    });

    console.log("[Memory] Cleared all manual knowledge");
  } catch (err) {
    console.error("[Memory] Failed to clear manual knowledge:", err);
  }
}

// --- Q&A Memory ---

/**
 * Save a Q&A pair to Qdrant — only if question is not similar to existing ones
 */
export async function saveQA(
  chatId: string,
  question: string,
  answer: string,
  sender: string
): Promise<void> {
  try {
    if (!question || question.length < 5) return;

    if (overlapsBaseKnowledge(question, answer)) {
      console.log(`[Memory] Skip Q&A (overlaps base knowledge): "${question.slice(0, 40)}..."`);
      return;
    }

    await init();

    const [vector] = await embed([question]);

    // Check if similar question already exists
    try {
      const existing = await client.search(COLLECTION_NAME, {
        vector,
        limit: 1,
        score_threshold: 0.85,
        filter: {
          must: [{ key: "type", match: { value: "qa" } }],
        },
      });

      if (existing.length > 0) {
        const point = existing[0];
        const existingAnswer = point.payload?.answer;

        if (existingAnswer === answer) {
          console.log(`[Memory] Skip identical Q&A: "${question.slice(0, 40)}..."`);
          return;
        }

        await client.delete(COLLECTION_NAME, {
          points: [point.id],
        });
        console.log(`[Memory] Updating Q&A: "${question.slice(0, 40)}..."`);
      }
    } catch {
      // Collection might be empty, continue saving
    }

    await client.upsert(COLLECTION_NAME, {
      points: [
        {
          id: generatePointId(),
          vector,
          payload: {
            document: question,
            chatId,
            sender,
            answer,
            timestamp: new Date().toISOString(),
            type: "qa",
          },
        },
      ],
    });

    console.log(`[Memory] Saved Q&A: "${question.slice(0, 50)}..."`);
  } catch (err) {
    console.error("[Memory] Failed to save Q&A:", err);
  }
}

// --- Query (searches all types: knowledge_base, knowledge_manual, qa) ---

/**
 * Query relevant context from Qdrant (knowledge + Q&A)
 */
export async function queryMemory(
  query: string,
  limit = 5
): Promise<string[]> {
  try {
    await init();

    const [vector] = await embed([query]);

    const results = await client.search(COLLECTION_NAME, {
      vector,
      limit,
      with_payload: true,
    });

    if (!results.length) return [];

    const entries = results
      .map((point) => {
        const p = point.payload as Record<string, unknown> | null;
        if (!p?.document) return null;

        const type = String(p.type || "");
        const doc = String(p.document);

        if (type === "knowledge_base" || type === "knowledge_manual") {
          return {
            formatted: `[Knowledge] ${doc}`,
            timestamp: String(p.timestamp || ""),
          };
        }

        // Q&A type
        return {
          formatted: `Q (${p.sender || "unknown"}, ${p.timestamp || ""}): ${doc}\nA: ${p.answer || ""}`,
          timestamp: String(p.timestamp || ""),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return entries.map((e) => e.formatted);
  } catch (err) {
    console.error("[Memory] Failed to query:", err);
    return [];
  }
}
