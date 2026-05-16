import "dotenv/config";
import fs from "fs";
import path from "path";
import express, { Request, Response } from "express";
import { chat } from "./lib/openrouter";
import { sendText } from "./lib/waha";

const app = express();
app.use(express.json());

// In-memory conversation history per chat
const conversations = new Map<string, Array<{ role: string; content: unknown }>>();
const MAX_HISTORY = 20;

// Load knowledge from all .md files in knowledge/ folder
function loadKnowledge(): string {
  const knowledgeDir = path.join(__dirname, "..", "knowledge");
  if (!fs.existsSync(knowledgeDir)) return "";

  const files = fs.readdirSync(knowledgeDir).filter((f) => f.endsWith(".md"));
  return files
    .map((f) => fs.readFileSync(path.join(knowledgeDir, f), "utf-8"))
    .join("\n\n---\n\n");
}

const knowledge = loadKnowledge();
console.log(`Loaded knowledge: ${knowledge.length} characters`);

const SYSTEM_PROMPT = `${
  process.env.SYSTEM_PROMPT ||
  `Kamu adalah teman ngobrol di WhatsApp. Aturan penting:
- Jawab SINGKAT, maksimal 1-3 kalimat kayak chat biasa. Jangan panjang lebar.
- JANGAN pernah copy-paste dari knowledge base. Selalu paraphrase pakai kata-kata sendiri.
- Pakai bahasa gaul, santai, kayak ngobrol sama temen. Boleh bercanda dan roasting ringan.
- Jangan pakai bullet point atau format panjang kecuali diminta.
- Jangan mulai jawaban dengan "Oke", "Baik", "Tentu" atau kata formal lainnya.
- Jawab dalam bahasa yang sama dengan pengguna.`
}

Berikut adalah knowledge base tambahan. Jika pertanyaan user berkaitan dengan informasi di bawah ini, PRIORITASKAN jawaban dari knowledge base. Untuk pertanyaan umum seperti matematika, sains, sejarah, bahasa, dan pengetahuan umum lainnya, jawab dengan pengetahuanmu sendiri secara normal. Hanya arahkan ke pembuat bot jika pertanyaan benar-benar di luar kemampuanmu.

=== KNOWLEDGE BASE ===
${knowledge}
=== END KNOWLEDGE BASE ===`;

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "waha-chatbot" });
});

// WAHA webhook endpoint
app.post("/webhook", async (req: Request, res: Response) => {
  res.json({ ok: true });

  try {
    const { event, payload } = req.body;

    if (event !== "message" || !payload || payload.fromMe) return;

    const chatId: string = payload.from;
    const userMessage: string = payload.body || "";
    const hasMedia = payload.hasMedia && payload.mediaUrl;
    const isImage = hasMedia && payload._data?.mimetype?.startsWith("image/");

    if (!userMessage.trim() && !isImage) return;

    const isGroup = chatId.endsWith("@g.us");

    // Debug: log group message details
    if (isGroup) {
      console.log(`[GROUP DEBUG] chatId: ${chatId}`);
      console.log(`[GROUP DEBUG] mentionedIds:`, payload.mentionedIds);
      console.log(`[GROUP DEBUG] _data.mentionedJidList:`, payload._data?.mentionedJidList);
      console.log(`[GROUP DEBUG] body: ${userMessage}`);
    }

    // In groups, only reply when bot is mentioned (@tagged)
    if (isGroup) {
      const botMentions = (process.env.BOT_MENTIONS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const mentionList: string[] =
        payload.mentionedIds || payload._data?.mentionedJidList || [];
      const isMentioned = botMentions.some(
        (num) =>
          mentionList.some((id: string) => id.includes(num)) ||
          userMessage.includes(`@${num}`)
      );
      if (!isMentioned) return;
    }

    // Identify sender (owner detection)
    const senderRaw: string = payload.participant || payload.from || "";
    const ownerId = process.env.OWNER_MENTION_ID || "";
    console.log(`[SENDER DEBUG] senderRaw: ${senderRaw}, ownerId: ${ownerId}`);
    const isOwner = ownerId !== "" && senderRaw.includes(ownerId);
    const senderLabel = isOwner ? "Fikri (Muhammad Fikrianto Aji, pembuat bot)" : "";

    // Clean mention tags from message
    const cleanMessage = userMessage.replace(/@\d+/g, "").trim();

    console.log(`[${chatId}] ${isOwner ? "[OWNER]" : ""} User: ${cleanMessage || "[image]"}`);

    // Build conversation history
    if (!conversations.has(chatId)) {
      conversations.set(chatId, []);
    }
    const history = conversations.get(chatId)!;

    // Build user message content (text, image, or both)
    if (isImage) {
      try {
        const mediaUrl: string = payload.mediaUrl;
        console.log(`[${chatId}] Image: ${mediaUrl}`);

        const content: Array<Record<string, unknown>> = [];
        content.push({ type: "text", text: cleanMessage || "Jelaskan gambar ini." });
        content.push({ type: "image_url", image_url: { url: mediaUrl } });
        history.push({ role: "user", content });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${chatId}] Failed to process image:`, msg);
        history.push({ role: "user", content: cleanMessage || "Ada gambar yang tidak bisa diproses." });
      }
    } else {
      history.push({ role: "user", content: cleanMessage });
    }

    // Trim history
    while (history.length > MAX_HISTORY) {
      history.shift();
    }

    // Build dynamic system prompt
    let dynamicPrompt = SYSTEM_PROMPT;
    if (isGroup && ownerId) {
      dynamicPrompt += `\n\nINFO GRUP:
- Kalau mau refer ke Fikri di grup, tulis @${ownerId} supaya ke-tag. Jangan pakai link wa.me.
- Contoh: "tanya aja ke @${ownerId}" bukan "hubungi https://wa.me/..."`;
    }
    if (senderLabel) {
      dynamicPrompt += `\n\nPengirim pesan ini adalah: ${senderLabel}. Sapa dia sesuai konteks.`;
    }

    // Call OpenRouter
    const reply = await chat(dynamicPrompt, history as never);

    history.push({ role: "assistant", content: reply });
    console.log(`[${chatId}] Bot: ${reply}`);

    // Check if reply mentions owner
    const mentions: string[] = [];
    if (ownerId && reply.includes(`@${ownerId}`)) {
      mentions.push(`${ownerId}@lid`);
    }

    await sendText(chatId, reply, mentions);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error handling webhook:", msg);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Chatbot server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
