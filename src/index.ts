import "dotenv/config";
import fs from "fs";
import path from "path";
import express, { Request, Response } from "express";
import { chat } from "./lib/openrouter";
import { sendText, sendVoice, sendSeen, startTyping, stopTyping, getMediaUrl } from "./lib/waha";
import { textToSpeech } from "./lib/tts";
import { searchWeb, fetchPageContent } from "./lib/search";
import { transcribeAudio } from "./lib/transcribe";
import { notifyError } from "./lib/discord";
import { saveQA, queryMemory, saveKnowledge as saveKnowledgeToVector, setBaseKnowledge } from "./lib/memory";

const app = express();
app.use(express.json());

// In-memory conversation history per chat
const conversations = new Map<string, Array<{ role: string; content: unknown }>>();
const MAX_HISTORY = 20;

// --- Knowledge Management ---
const KNOWLEDGE_DIR = path.join(__dirname, "..", "knowledge");
const KNOWLEDGE_FILE = path.join(KNOWLEDGE_DIR, "base.md");

function loadKnowledge(): string {
  if (!fs.existsSync(KNOWLEDGE_DIR)) return "";
  const files = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith(".md"));
  return files
    .map((f) => fs.readFileSync(path.join(KNOWLEDGE_DIR, f), "utf-8"))
    .join("\n\n---\n\n");
}

function getKnowledgeEntries(): string[] {
  if (!fs.existsSync(KNOWLEDGE_FILE)) return [];
  const content = fs.readFileSync(KNOWLEDGE_FILE, "utf-8").trim();
  if (!content) return [];
  return content.split("\n\n").filter((e) => e.trim());
}

function saveKnowledgeEntries(entries: string[]): void {
  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  fs.writeFileSync(KNOWLEDGE_FILE, entries.join("\n\n") + "\n");
}

let currentKnowledge = loadKnowledge();
console.log(`Loaded knowledge: ${currentKnowledge.length} characters`);
setBaseKnowledge(currentKnowledge);

function buildSystemPrompt(): string {
  return `${
    process.env.SYSTEM_PROMPT ||
    `Kamu adalah teman chat di WhatsApp. Bayangin kamu lagi balesin chat temen deket.
- Singkat, 1-3 kalimat. Kayak chat biasa, bukan essay.
- Santai dan gaul, boleh bercanda, roasting ringan, pake slang. Tapi jangan lebay.
- Variasikan gaya jawaban. Kadang serius, kadang becanda, kadang singkat banget. Jangan monoton.
- JANGAN selalu pake pembuka yang sama. Beda-bedain tiap jawaban.
- MURNI bahasa Indonesia. DILARANG campur bahasa asing (China/中文, Rusia, Arab, Jepang, Korea). English umum boleh (OK, thanks, dll).
- Jangan pake bullet point kecuali diminta.
- Kalau kamu tau jawabannya, jawab natural seolah emang udah tau. Jangan bilang "aku ingat", "dari catatan", atau semacamnya.
- JANGAN copy-paste. Selalu paraphrase pakai kata-kata sendiri.`
  }

FORMAT BALASAN: Setiap jawaban HARUS diawali dengan tag format balasan di baris pertama, sebelum isi jawaban:
- [TEXT] — jika user tidak minta dibalas pakai suara (DEFAULT, gunakan ini kalau ragu)
- [VOICE] — HANYA jika user secara eksplisit minta dibalas pakai suara/voice/vn/audio
Contoh: user bilang "jawab pake vn dong" → baris pertama: [VOICE], lalu jawaban. User bilang "halo" → baris pertama: [TEXT], lalu jawaban.

FITUR SEARCH: Kamu PUNYA akses internet. Kalau kamu butuh info yang tidak kamu tau atau user minta cari sesuatu, jawab HANYA dengan format [SEARCH: kata kunci]. Jangan tambah teks lain. Jangan pernah bilang "ga bisa akses internet". Kalau bisa jawab sendiri (knowledge base, pengetahuan umum, matematika), jawab langsung tanpa search.

Berikut adalah knowledge base tambahan. Jika pertanyaan user berkaitan dengan informasi di bawah ini, PRIORITASKAN jawaban dari knowledge base. Untuk pertanyaan umum seperti matematika, sains, sejarah, bahasa, dan pengetahuan umum lainnya, jawab dengan pengetahuanmu sendiri secara normal. Hanya arahkan ke pembuat bot jika pertanyaan benar-benar di luar kemampuanmu.

=== KNOWLEDGE BASE ===
${currentKnowledge}
=== END KNOWLEDGE BASE ===`;
}

let systemPrompt = buildSystemPrompt();

function reloadKnowledge(): void {
  currentKnowledge = loadKnowledge();
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
    const entries = getKnowledgeEntries();
    entries.push(arg);
    saveKnowledgeEntries(entries);
    reloadKnowledge();
    saveKnowledgeToVector(arg).catch(() => {});
    await sendText(chatId, `✅ Knowledge ditambahkan:\n"${arg}"\n\nTotal: ${entries.length} entries`);
    return true;
  }

  if (action === "list") {
    const entries = getKnowledgeEntries();
    if (entries.length === 0) {
      await sendText(chatId, "📋 Knowledge kosong.");
      return true;
    }
    const list = entries.map((e, i) => `${i + 1}. ${e.slice(0, 100)}${e.length > 100 ? "..." : ""}`).join("\n");
    await sendText(chatId, `📋 Knowledge (${entries.length} entries):\n\n${list}`);
    return true;
  }

  if (action === "delete" && arg) {
    const entries = getKnowledgeEntries();
    const idx = parseInt(arg) - 1;
    if (isNaN(idx) || idx < 0 || idx >= entries.length) {
      await sendText(chatId, `❌ Nomor tidak valid. Range: 1-${entries.length}`);
      return true;
    }
    const removed = entries.splice(idx, 1)[0];
    saveKnowledgeEntries(entries);
    reloadKnowledge();
    await sendText(chatId, `🗑️ Dihapus:\n"${removed.slice(0, 100)}"\n\nSisa: ${entries.length} entries`);
    return true;
  }

  if (action === "clear") {
    saveKnowledgeEntries([]);
    reloadKnowledge();
    await sendText(chatId, "🗑️ Semua knowledge dihapus.");
    return true;
  }

  await sendText(
    chatId,
    `📖 Knowledge Commands:\n\n!knowledge add <teks>\n!knowledge list\n!knowledge delete <nomor>\n!knowledge clear`
  );
  return true;
}

// Health check
app.get("/", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "waha-chatbot" });
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

    // Query relevant memory from ChromaDB
    let memoryContext = "";
    try {
      const memories = await queryMemory(cleanMessage, 5);
      if (memories.length > 0) {
        const currentSenderName = isOwner ? "Fikri" : (payload._data?.pushName || senderRaw);
        memoryContext = `\n\n=== CONTEXT ===
Info yang kamu tau. Aturan:
- Jawab natural, JANGAN bilang "aku ingat/dari catatan". JANGAN copy-paste. Paraphrase.
- Pengirim saat ini: ${currentSenderName}. Prioritaskan info dari dia.
- Info dari orang lain boleh dipakai kalau relevan.
- Kalau ada info yang BERTENTANGAN, pakai yang TERBARU (lihat timestamp).
${memories.join("\n\n")}
=== END CONTEXT ===`;
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

    // Call OpenRouter
    let reply = await chat(dynamicPrompt, history as never);

    // Handle search request from model
    const searchMatch = reply.match(/\[SEARCH:\s*(.+?)\]/);
    if (searchMatch) {
      const query = searchMatch[1].trim();
      console.log(`[${chatId}] Searching: ${query}`);

      const results = await searchWeb(query);
      console.log(`[${chatId}] Search results: ${results.length}`, results.map((r) => r.url));
      if (results.length > 0) {
        // Fetch page content from top results
        const pages = await Promise.all(
          results.map(async (r) => {
            const content = await fetchPageContent(r.url);
            return `Sumber: ${r.title} (${r.url})\n${r.snippet}\n${content}`;
          })
        );

        const searchContext = pages.join("\n\n---\n\n");

        // Send search results back to model
        history.push({ role: "assistant", content: reply });
        history.push({
          role: "user",
          content: `Berikut hasil pencarian untuk "${query}":\n\n${searchContext}\n\nJawab pertanyaan user berdasarkan hasil pencarian di atas. Jawab singkat dan natural.`,
        });

        reply = await chat(dynamicPrompt, history as never);
        // Remove the search context from history to save tokens
        history.pop();
        history.pop();
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
  } catch (err: unknown) {
    if (chatId) await stopTyping(chatId).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Error handling webhook:", msg);
    notifyError(`Webhook (${chatId || "unknown"})`, msg).catch(() => {});
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Chatbot server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook`);
});
