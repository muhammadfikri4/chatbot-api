import "dotenv/config";
import fs from "fs";
import path from "path";
import express, { Request, Response } from "express";
import { chat, lastUsedModel } from "./lib/llm";
import { sendText, sendVoice, sendSeen, startTyping, stopTyping, getMediaUrl, getGroupInfo } from "./lib/waha";
import { textToSpeech } from "./lib/tts";
import { searchWeb, fetchPageContent } from "./lib/search";
import { transcribeAudio } from "./lib/transcribe";
import { notifyError, notifyChat } from "./lib/discord";
import { saveQA, queryMemory, setBaseKnowledge, trainKnowledge, addManualKnowledge, listManualKnowledge, deleteManualKnowledge, clearManualKnowledge } from "./lib/memory";
import { startDiscordBot, setSystemPromptProvider } from "./lib/discord-bot";

const app = express();
app.use(express.json());

// In-memory conversation history per chat
const conversations = new Map<string, Array<{ role: string; content: unknown }>>();
const MAX_HISTORY = 20;

// --- Knowledge Management ---
const KNOWLEDGE_DIR = path.join(__dirname, "..", "knowledge");

function loadKnowledge(): string {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return "";
  const files = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md"));
  return files
    .map((f) => fs.readFileSync(path.join(KNOWLEDGE_DIR, f), "utf-8"))
    .join("\n\n---\n\n");
}

// Load base knowledge for overlap detection + system prompt
let currentKnowledge = loadKnowledge();
console.log(`Loaded knowledge: ${currentKnowledge.length} characters`);
setBaseKnowledge(currentKnowledge);

// Train knowledge files into Qdrant on startup
trainKnowledge(KNOWLEDGE_DIR).then((count) => {
  console.log(`[Startup] Indexed ${count} knowledge chunks into Qdrant`);
}).catch((err) => {
  console.error("[Startup] Failed to train knowledge:", err);
});

function buildSystemPrompt(): string {
  return `${
    process.env.SYSTEM_PROMPT ||
    `Kamu teman chat WhatsApp. Bales kayak temen deket, BUKAN asisten formal.
Pake "gue/lo/lu", JANGAN "saya/Anda". Singkat 1-3 kalimat, santai, gaul. Bahasa Indonesia.

Contoh gaya jawaban yang BENAR:
User: "halo bro"
Bot: "[TEXT] Yo wazzup bro, ada apa nih?"
User: "lo bisa apa aja?"
Bot: "[TEXT] Banyak bro, mau nanya apa aja gas. Mau cari info juga bisa."
User: "jawab pake vn dong"
Bot: "[VOICE] Oke siap bro, gue jawab pake suara ya."`
  }

Awali jawaban dengan [TEXT] atau [VOICE] (kalau diminta suara).
Kalau butuh cari info dari internet, jawab [SEARCH: kata kunci] saja.

Kemampuan lo: jawab pertanyaan umum, cari info di internet, kasih rekomendasi tempat, ngobrol santai, roasting temen, dan bantuin hal-hal sehari-hari.

=== INFO ===
${currentKnowledge}
=== END ===`;
}

let systemPrompt = buildSystemPrompt();

function reloadKnowledge(): void {
  currentKnowledge = loadKnowledge();
  setBaseKnowledge(currentKnowledge);
  systemPrompt = buildSystemPrompt();
  console.log(`Knowledge reloaded: ${currentKnowledge.length} characters`);
}

// --- Knowledge Commands (owner only) ---
async function handleKnowledgeCommand(
  chatId: string,
  command: string
): Promise<boolean> {
  const parts = command.replace(/^!knowledge\s*/, "").trim();
  const action = parts.split(/\s+/)[0]?.toLowerCase();
  const arg = parts.slice(action?.length || 0).trim();

  if (action === "add" && arg) {
    await addManualKnowledge(arg);
    const entries = await listManualKnowledge();
    await sendText(chatId, `✅ Knowledge ditambahkan:\n"${arg}"\n\nTotal manual entries: ${entries.length}`);
    return true;
  }

  if (action === "list") {
    const entries = await listManualKnowledge();
    if (entries.length === 0) {
      await sendText(chatId, "📋 Manual knowledge kosong.\n\n(Knowledge dari file base.md tetap aktif di Qdrant)");
      return true;
    }
    const list = entries.map((e, i) => `${i + 1}. ${e.content.slice(0, 100)}${e.content.length > 100 ? "..." : ""}`).join("\n");
    await sendText(chatId, `📋 Manual Knowledge (${entries.length} entries):\n\n${list}\n\n(Knowledge dari file base.md terpisah & tidak bisa dihapus)`);
    return true;
  }

  if (action === "delete" && arg) {
    const idx = parseInt(arg);
    if (isNaN(idx)) {
      await sendText(chatId, "❌ Masukkan nomor yang valid.");
      return true;
    }
    const result = await deleteManualKnowledge(idx);
    if (!result.success) {
      const entries = await listManualKnowledge();
      await sendText(chatId, `❌ Nomor tidak valid. Range: 1-${entries.length}`);
      return true;
    }
    const remaining = await listManualKnowledge();
    await sendText(chatId, `🗑️ Dihapus:\n"${result.content?.slice(0, 100)}"\n\nSisa manual entries: ${remaining.length}`);
    return true;
  }

  if (action === "clear") {
    await clearManualKnowledge();
    await sendText(chatId, "🗑️ Semua manual knowledge dihapus.\n\n(Knowledge dari file base.md tetap aman)");
    return true;
  }

  if (action === "train") {
    await sendText(chatId, "⏳ Re-training knowledge dari file...");
    reloadKnowledge();
    const count = await trainKnowledge(KNOWLEDGE_DIR);
    await sendText(chatId, `✅ Training selesai! ${count} chunks di-index ke Qdrant.`);
    return true;
  }

  await sendText(
    chatId,
    `📖 Knowledge Commands:\n\n!knowledge add <teks> — tambah manual knowledge\n!knowledge list — lihat manual knowledge\n!knowledge delete <nomor> — hapus manual knowledge\n!knowledge clear — hapus semua manual knowledge\n!knowledge train — re-index file knowledge ke Qdrant`
  );
  return true;
}

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "waha-chatbot" });
});

// Knowledge training endpoint
app.post("/api/knowledge/train", async (_req: Request, res: Response) => {
  try {
    reloadKnowledge();
    const count = await trainKnowledge(KNOWLEDGE_DIR);
    res.json({ status: "ok", chunks: count });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ status: "error", message: msg });
  }
});

// WAHA webhook endpoint
app.post("/webhook", async (req: Request, res: Response) => {
  res.json({ ok: true });

  let chatId = "";

  try {
    const { event, payload } = req.body;

    // Log all incoming events for debugging
    console.log(`[WEBHOOK] event: ${event}, hasPayload: ${!!payload}, fromMe: ${payload?.fromMe}`);

    if (event !== "message" || !payload || payload.fromMe) return;

    chatId = payload.from;
    const userMessage: string = payload.body || "";
    const hasMedia: boolean = payload.hasMedia || false;
    const mediaUrl: string = payload.mediaUrl || payload.media?.url || "";
    const mimetype: string = payload._data?.mimetype || payload.media?.mimetype || payload._data?.message?.audioMessage?.mimetype || payload._data?.message?.imageMessage?.mimetype || "";
    const isImage = hasMedia && mimetype.startsWith("image/");
    const isAudio = hasMedia && (mimetype.startsWith("audio/") || mimetype.includes("ogg") || mimetype.includes("opus"));

    console.log(`[MEDIA DEBUG] hasMedia: ${hasMedia}, mediaUrl: ${mediaUrl}, mimetype: ${mimetype}, isImage: ${isImage}, isAudio: ${isAudio}`);

    if (!userMessage.trim() && !isImage && !isAudio) return;

    const isGroup = chatId.endsWith("@g.us");

    // Debug: log group message details
    if (isGroup) {
      console.log(`[GROUP DEBUG] chatId: ${chatId}`);
      console.log(`[GROUP DEBUG] mentionedIds:`, payload.mentionedIds);
      console.log(`[GROUP DEBUG] _data.mentionedJidList:`, payload._data?.mentionedJidList);
      console.log(`[GROUP DEBUG] body: ${userMessage}`);
      console.log(`[GROUP DEBUG] full payload keys:`, Object.keys(payload));
      console.log(`[GROUP DEBUG] full payload:`, JSON.stringify(payload, null, 2).slice(0, 1500));
    }

    // In groups, only reply when bot is mentioned (@tagged) or replied to
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
      const replyParticipant: string = payload.replyTo?.participant || "";
      const isReplyToBot = botMentions.some((num) => replyParticipant.includes(num));
      if (!isMentioned && !isReplyToBot) return;
    }

    // Identify sender (owner detection)
    const senderRaw: string = payload.participant || payload.from || "";
    const ownerIds = (process.env.OWNER_MENTION_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
    console.log(`[SENDER DEBUG] senderRaw: ${senderRaw}, ownerIds: ${ownerIds}`);
    const isOwner = ownerIds.some((id) => senderRaw.includes(id));
    const senderLabel = isOwner ? "Fikri (Muhammad Fikrianto Aji, pembuat bot)" : "";

    // Clean mention tags from message
    const cleanMessage = userMessage.replace(/@\d+/g, "").trim();

    console.log(`[${chatId}] ${isOwner ? "[OWNER]" : ""} User: ${cleanMessage || "[image]"}`);

    // Handle knowledge commands (owner only)
    if (cleanMessage.startsWith("!knowledge")) {
      if (!isOwner) {
        await sendText(chatId, "⛔ Cuma Fikri yang bisa pake command ini.");
        return;
      }
      await handleKnowledgeCommand(chatId, cleanMessage);
      return;
    }

    // Add reply context if replying to a message
    const replyContext = payload.replyTo?.body
      ? `[Membalas pesan: "${payload.replyTo.body}"]\n\n`
      : "";

    // Build conversation history
    if (!conversations.has(chatId)) {
      conversations.set(chatId, []);
    }
    const history = conversations.get(chatId)!;

    // Prepend reply context to message
    const messageWithContext = replyContext ? `${replyContext}${cleanMessage}` : cleanMessage;

    // Resolve media URL — use from payload or download via WAHA API
    let resolvedMediaUrl = mediaUrl;
    if (hasMedia && !resolvedMediaUrl) {
      try {
        const msgId: string = payload.id || "";
        console.log(`[${chatId}] Media URL missing, downloading via WAHA API (msgId: ${msgId})`);
        resolvedMediaUrl = await getMediaUrl(msgId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${chatId}] Failed to get media URL:`, msg);
      }
    }

    // Build user message content (text, image, audio)
    if (isAudio) {
      try {
        console.log(`[${chatId}] Audio/VN: ${resolvedMediaUrl}`);

        const transcript = await transcribeAudio(resolvedMediaUrl);
        console.log(`[${chatId}] Transcript: ${transcript}`);

        const vnMessage = replyContext
          ? `${replyContext}[Voice Note - transcript: "${transcript}"]`
          : `[Voice Note - transcript: "${transcript}"]`;
        history.push({ role: "user", content: vnMessage });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${chatId}] Failed to transcribe audio:`, msg);
        history.push({ role: "user", content: messageWithContext || "Ada voice note yang tidak bisa diproses." });
      }
    } else if (isImage) {
      try {
        console.log(`[${chatId}] Image: ${resolvedMediaUrl}`);

        const content: Array<Record<string, unknown>> = [];
        content.push({ type: "text", text: messageWithContext || "Jelaskan gambar ini." });
        content.push({ type: "image_url", image_url: { url: resolvedMediaUrl } });
        history.push({ role: "user", content });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${chatId}] Failed to process image:`, msg);
        history.push({ role: "user", content: messageWithContext || "Ada gambar yang tidak bisa diproses." });
      }
    } else {
      history.push({ role: "user", content: messageWithContext });
    }

    // Trim history
    while (history.length > MAX_HISTORY) {
      history.shift();
    }

    // Query relevant context from Qdrant (knowledge + Q&A)
    let memoryContext = "";
    try {
      const memories = await queryMemory(cleanMessage, 5);
      if (memories.length > 0) {
        const currentSenderName = isOwner ? "Fikri" : (payload._data?.pushName || senderRaw);
        memoryContext = `\n\n=== MEMORY ===
Pengirim: ${currentSenderName}
${memories.join("\n")}
=== END ===`;
      }
    } catch {
      // Memory query failed, continue without it
    }

    // Build dynamic system prompt
    let dynamicPrompt = systemPrompt + memoryContext;
    const ownerMentionId = ownerIds[ownerIds.length - 1] || "";
    if (isGroup && ownerMentionId) {
      dynamicPrompt += `\n\nINFO GRUP:
- Kalau mau refer ke Fikri di grup, tulis @${ownerMentionId} supaya ke-tag. Jangan pakai link wa.me.
- Contoh: "tanya aja ke @${ownerMentionId}" bukan "hubungi https://wa.me/..."`;
    }
    const currentSender = isOwner ? "Fikri (Muhammad Fikrianto Aji, pembuat bot)" : (payload._data?.pushName || senderRaw);
    dynamicPrompt += `\n\nPengirim pesan ini: ${currentSender}${isOwner ? ". Dia owner bot." : ""}`;


    // Mark message as read + show typing indicator
    await sendSeen(chatId);
    await startTyping(chatId);

    // If message contains a URL, scrape it and add as context
    const urlMatch = cleanMessage.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      try {
        const url = urlMatch[0];
        console.log(`[${chatId}] Scraping URL: ${url}`);
        const pageContent = await fetchPageContent(url);
        if (pageContent) {
          const lastEntry = history[history.length - 1];
          if (typeof lastEntry?.content === "string") {
            lastEntry.content = `${lastEntry.content}\n\n[Isi halaman ${url}]:\n${pageContent}`;
          }
        }
      } catch {
        // URL scrape failed, continue without it
      }
    }

    let reply = await chat(dynamicPrompt, history as never);

    // Handle search request from model
    let searchQuery = "";
    const searchMatch = reply.match(/\[SEARCH:\s*(.+?)\]/);
    if (searchMatch) {
      searchQuery = searchMatch[1].trim();
      const query = searchQuery;
      console.log(`[${chatId}] Searching: ${query}`);

      const results = await searchWeb(query);
      console.log(`[${chatId}] Search results: ${results.length}`, results.map((r) => r.url));
      if (results.length > 0) {
        // Fetch page content from top 2 results only (keep prompt small for local LLM)
        const topResults = results.slice(0, 2);
        const pages = await Promise.all(
          topResults.map(async (r) => {
            const content = await fetchPageContent(r.url);
            return `Sumber: ${r.title}\n${r.snippet}\n${content}`;
          })
        );

        const searchContext = pages.join("\n\n---\n\n");

        // Send search results back to model
        history.push({ role: "assistant", content: reply });
        history.push({
          role: "user",
          content: `Berikut hasil pencarian untuk "${query}":\n\n${searchContext}\n\nJawab pertanyaan user berdasarkan hasil pencarian di atas. Jawab singkat dan natural. JANGAN output [SEARCH:] lagi. Langsung jawab.`,
        });

        reply = await chat(dynamicPrompt, history as never);
        // Remove the search context from history to save tokens
        history.pop();
        history.pop();

        // Safety: strip any leftover [SEARCH:] tags
        if (reply.includes("[SEARCH:")) {
          reply = reply.replace(/\[SEARCH:[^\]]*\]/g, "").trim();
          if (!reply) reply = "Aku udah cari tapi belum nemu info yang pas. Coba tanya dengan cara lain ya.";
        }
      } else {
        reply = "Wah, gak nemu hasil pencarian nih. Coba tanya dengan kata kunci lain ya.";
      }
    }

    // Parse format tag from model reply (can be at start or end)
    const wantVoice = /\[VOICE\]/i.test(reply);
    reply = reply.replace(/\[(TEXT|VOICE)\]/gi, "").trim();

    history.push({ role: "assistant", content: reply });
    console.log(`[${chatId}] Bot: ${reply}${wantVoice ? " [VOICE]" : ""}`);

    // Save Q&A pair to vector memory
    const senderName = payload._data?.pushName || senderRaw;
    saveQA(chatId, cleanMessage, reply, senderName).catch(() => {});

    // Check if reply mentions owner
    const mentions: string[] = [];
    if (ownerMentionId && reply.includes(`@${ownerMentionId}`)) {
      mentions.push(`${ownerMentionId}@lid`);
    }

    if (wantVoice) {
      try {
        const audioBase64 = await textToSpeech(reply);
        await sendVoice(chatId, audioBase64);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${chatId}] TTS failed, sending text only:`, msg);
        await sendText(chatId, reply, mentions);
      }
    } else {
      await sendText(chatId, reply, mentions);
    }

    await stopTyping(chatId);

    // Log to Discord
    let groupName = "";
    if (isGroup) {
      const info = await getGroupInfo(chatId).catch(() => null);
      groupName = info?.subject || chatId;
    }

    notifyChat({
      sender: payload._data?.pushName || senderRaw,
      senderId: senderRaw,
      chatId,
      groupName,
      message: cleanMessage,
      reply,
      model: lastUsedModel,
      isGroup,
      isOwner,
      isVoice: wantVoice,
      isImage,
      isAudio,
      searchQuery: searchQuery || undefined,
    }).catch(() => {});
  } catch (err: unknown) {
    if (chatId) await stopTyping(chatId).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error handling webhook:", msg);
    notifyError(`Webhook (${chatId || "unknown"})`, msg).catch(() => {});
  }
});

// Start Discord bot
setSystemPromptProvider(() => buildSystemPrompt());
startDiscordBot();

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Chatbot server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
