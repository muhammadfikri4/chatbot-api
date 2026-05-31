import { Client, GatewayIntentBits, Message, Partials } from "discord.js";
import { chat, lastUsedModel } from "./llm";
import { searchWeb, fetchPageContent } from "./search";
import { queryMemory, saveQA } from "./memory";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const MAX_HISTORY = 20;

// In-memory conversation history per channel/DM
const conversations = new Map<string, Array<{ role: string; content: unknown }>>();

let systemPromptFn: (() => string) | null = null;

export function setSystemPromptProvider(fn: () => string): void {
  systemPromptFn = fn;
}

export function startDiscordBot(): void {
  if (!DISCORD_BOT_TOKEN) {
    console.log("[Discord Bot] DISCORD_BOT_TOKEN not set, skipping...");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel], // needed for DM support
  });

  client.once("ready", () => {
    console.log(`[Discord Bot] Logged in as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMentioned = message.mentions.has(client.user!);

    // Only respond to DMs or when mentioned in a server
    if (!isDM && !isMentioned) return;

    // Must be a text-based channel
    if (!message.channel.isSendable()) return;

    // Clean mention from message
    const cleanMessage = message.content
      .replace(/<@!?\d+>/g, "")
      .trim();

    if (!cleanMessage) return;

    const channel = message.channel;
    const channelId = channel.id;
    const senderName = message.author.displayName || message.author.username;

    console.log(`[Discord Bot] [${isDM ? "DM" : message.guild?.name}] ${senderName}: ${cleanMessage}`);

    try {
      // Show typing indicator
      await channel.sendTyping();

      // Build conversation history
      if (!conversations.has(channelId)) {
        conversations.set(channelId, []);
      }
      const history = conversations.get(channelId)!;

      // Add reply context if replying to a message
      let messageWithContext = cleanMessage;
      if (message.reference?.messageId) {
        try {
          const repliedMsg = await channel.messages.fetch(message.reference.messageId);
          if (repliedMsg) {
            messageWithContext = `[Membalas pesan: "${repliedMsg.content.slice(0, 200)}"]\n\n${cleanMessage}`;
          }
        } catch {
          // Failed to fetch replied message, continue without context
        }
      }

      history.push({ role: "user", content: messageWithContext });

      // Trim history
      while (history.length > MAX_HISTORY) {
        history.shift();
      }

      // Query relevant context from Qdrant
      let memoryContext = "";
      try {
        const memories = await queryMemory(cleanMessage, 5);
        if (memories.length > 0) {
          memoryContext = `\n\n=== MEMORY ===
Pengirim: ${senderName}
${memories.join("\n")}
=== END ===`;
        }
      } catch {
        // Memory query failed, continue without it
      }

      // Build system prompt
      const basePrompt = systemPromptFn ? systemPromptFn() : "Kamu asisten yang helpful. Jawab singkat dan jelas.";
      let dynamicPrompt = basePrompt + memoryContext;
      dynamicPrompt += `\n\nPengirim pesan ini: ${senderName} (via Discord)`;
      // Discord doesn't use voice, strip voice instructions
      dynamicPrompt += `\n\nINFO: Ini chat Discord, JANGAN pakai tag [VOICE]. Selalu jawab dengan [TEXT].`;

      // If message contains a URL, scrape it
      const urlMatch = cleanMessage.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        try {
          const pageContent = await fetchPageContent(urlMatch[0]);
          if (pageContent) {
            const lastEntry = history[history.length - 1];
            if (typeof lastEntry?.content === "string") {
              lastEntry.content = `${lastEntry.content}\n\n[Isi halaman ${urlMatch[0]}]:\n${pageContent}`;
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
        console.log(`[Discord Bot] Searching: ${searchQuery}`);

        const results = await searchWeb(searchQuery);
        if (results.length > 0) {
          const pages = await Promise.all(
            results.map(async (r) => {
              const content = await fetchPageContent(r.url);
              return `Sumber: ${r.title} (${r.url})\n${r.snippet}\n${content}`;
            })
          );

          const searchContext = pages.join("\n\n---\n\n");

          history.push({ role: "assistant", content: reply });
          history.push({
            role: "user",
            content: `Berikut hasil pencarian untuk "${searchQuery}":\n\n${searchContext}\n\nJawab pertanyaan user berdasarkan hasil pencarian di atas. Jawab singkat dan natural. JANGAN output [SEARCH:] lagi. Langsung jawab.`,
          });

          reply = await chat(dynamicPrompt, history as never);
          history.pop();
          history.pop();

          if (reply.includes("[SEARCH:")) {
            reply = reply.replace(/\[SEARCH:[^\]]*\]/g, "").trim();
            if (!reply) reply = "Aku udah cari tapi belum nemu info yang pas. Coba tanya dengan cara lain ya.";
          }
        } else {
          reply = "Wah, gak nemu hasil pencarian nih. Coba tanya dengan kata kunci lain ya.";
        }
      }

      // Strip format tags
      reply = reply.replace(/\[(TEXT|VOICE)\]/gi, "").trim();

      history.push({ role: "assistant", content: reply });
      console.log(`[Discord Bot] Bot: ${reply.slice(0, 100)}...`);

      // Save Q&A to memory
      saveQA(channelId, cleanMessage, reply, senderName).catch(() => {});

      // Discord has 2000 char limit per message
      if (reply.length <= 2000) {
        await message.reply(reply);
      } else {
        // Split into chunks
        const chunks: string[] = [];
        let remaining = reply;
        while (remaining.length > 0) {
          chunks.push(remaining.slice(0, 2000));
          remaining = remaining.slice(2000);
        }
        for (let i = 0; i < chunks.length; i++) {
          if (i === 0) {
            await message.reply(chunks[i]);
          } else {
            await channel.send(chunks[i]);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Discord Bot] Error:`, msg);
      await message.reply("Maaf, ada error nih. Coba lagi ya.").catch(() => {});
    }
  });

  client.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error(`[Discord Bot] Failed to login: ${err.message}`);
    console.error("[Discord Bot] Pastikan DISCORD_BOT_TOKEN di .env sudah benar.");
  });
}
