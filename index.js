require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const { chat } = require("./lib/openrouter");
const { sendText, downloadMedia } = require("./lib/waha");

const app = express();
app.use(express.json());

// In-memory conversation history per chat (chatId -> messages[])
const conversations = new Map();
const MAX_HISTORY = 20; // keep last 20 messages per chat

// Load knowledge from all .md files in knowledge/ folder
function loadKnowledge() {
  const knowledgeDir = path.join(__dirname, "knowledge");
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
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "waha-chatbot" });
});

// WAHA webhook endpoint
app.post("/webhook", async (req, res) => {
  // Respond immediately so WAHA doesn't retry
  res.json({ ok: true });

  try {
    const { event, payload } = req.body;

    // Only process incoming messages (not from ourselves)
    if (event !== "message" || !payload || payload.fromMe) return;

    const chatId = payload.from;
    const userMessage = payload.body || "";
    const hasMedia = payload.hasMedia && payload.mediaUrl;
    const isImage = hasMedia && payload._data?.mimetype?.startsWith("image/");

    // Skip if no text and no image
    if (!userMessage.trim() && !isImage) return;

    const isGroup = chatId.endsWith("@g.us");
    const botNumber = process.env.BOT_NUMBER || "";

    // Debug: log group message details
    if (isGroup) {
      console.log(`[GROUP DEBUG] chatId: ${chatId}`);
      console.log(`[GROUP DEBUG] mentionedIds:`, payload.mentionedIds);
      console.log(`[GROUP DEBUG] _data.mentionedJidList:`, payload._data?.mentionedJidList);
      console.log(`[GROUP DEBUG] body: ${userMessage}`);
      console.log(`[GROUP DEBUG] botNumber: ${botNumber}`);
    }

    // In groups, only reply when bot is mentioned (@tagged)
    if (isGroup) {
      const botNumbers = (process.env.BOT_MENTIONS || "").split(",").map((s) => s.trim()).filter(Boolean);
      const mentions = payload.mentionedIds || payload._data?.mentionedJidList || [];
      const isMentioned =
        botNumbers.some((num) =>
          mentions.some((id) => id.includes(num)) ||
          userMessage.includes(`@${num}`)
        );
      if (!isMentioned) return;
    }

    // Identify sender
    const senderRaw = payload.participant || payload.from || "";
    const ownerId = process.env.OWNER_MENTION_ID || "";
    console.log(`[SENDER DEBUG] senderRaw: ${senderRaw}, ownerId: ${ownerId}`);
    const isFikri = ownerId && senderRaw.includes(ownerId);
    const senderName = isFikri ? "Fikri (Muhammad Fikrianto Aji, pembuat bot)" : "";

    // Clean mention tags from message (remove @12345 patterns)
    const cleanMessage = userMessage.replace(/@\d+/g, "").trim();

    console.log(`[${chatId}] ${isFikri ? "[FIKRI]" : ""} User: ${cleanMessage || "[image]"}`);

    // Build conversation history
    if (!conversations.has(chatId)) {
      conversations.set(chatId, []);
    }
    const history = conversations.get(chatId);

    // Build user message content (text, image, or both)
    if (isImage) {
      try {
        const mediaUrl = payload.mediaUrl;
        console.log(`[${chatId}] Downloading image: ${mediaUrl}`);

        const content = [];
        if (cleanMessage) {
          content.push({ type: "text", text: cleanMessage });
        } else {
          content.push({ type: "text", text: "Jelaskan gambar ini." });
        }
        content.push({
          type: "image_url",
          image_url: { url: mediaUrl },
        });
        history.push({ role: "user", content });
      } catch (err) {
        console.error(`[${chatId}] Failed to process image:`, err.message);
        history.push({ role: "user", content: cleanMessage || "Ada gambar yang tidak bisa diproses." });
      }
    } else {
      history.push({ role: "user", content: cleanMessage });
    }

    // Trim history to prevent token overflow
    while (history.length > MAX_HISTORY) {
      history.shift();
    }

    // Build dynamic system prompt with sender context
    let dynamicPrompt = SYSTEM_PROMPT;
    if (isGroup && ownerId) {
      dynamicPrompt += `\n\nINFO GRUP:
- Kalau mau refer ke Fikri di grup, tulis @${ownerId} supaya ke-tag. Jangan pakai link wa.me.
- Contoh: "tanya aja ke @${ownerId}" bukan "hubungi https://wa.me/..."`;
    }
    if (senderName) {
      dynamicPrompt += `\n\nPengirim pesan ini adalah: ${senderName}. Sapa dia sesuai konteks.`;
    }

    // Call OpenRouter
    const reply = await chat(dynamicPrompt, history);

    // Save assistant reply to history
    history.push({ role: "assistant", content: reply });

    console.log(`[${chatId}] Bot: ${reply}`);

    // Check if reply mentions Fikri, add to mentions list for WAHA
    const mentions = [];
    if (reply.includes(`@${ownerId}`)) {
      mentions.push(`${ownerId}@lid`);
    }

    // Send reply via WAHA
    await sendText(chatId, reply, mentions);
  } catch (err) {
    console.error("Error handling webhook:", err.message);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Chatbot server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
