const ERROR_WEBHOOK = process.env.DISCORD_ERROR_WEBHOOK || "";
const LOG_WEBHOOK = process.env.DISCORD_LOG_WEBHOOK || "";

export async function notifyError(
  context: string,
  error: string
): Promise<void> {
  if (!ERROR_WEBHOOK) return;

  try {
    await fetch(ERROR_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "Chatbot Error",
            description: `**Context:** ${context}\n\n**Error:**\n\`\`\`\n${error.slice(0, 1000)}\n\`\`\``,
            color: 15158332,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch {
    console.error("[Discord] Failed to send error notification");
  }
}

export async function notifyChat(opts: {
  sender: string;
  senderId: string;
  chatId: string;
  groupName?: string;
  message: string;
  reply: string;
  model: string;
  isGroup: boolean;
  isOwner: boolean;
  isVoice?: boolean;
  isImage?: boolean;
  isAudio?: boolean;
  searchQuery?: string;
}): Promise<void> {
  if (!LOG_WEBHOOK) return;

  try {
    const chatLabel = opts.isGroup ? `Group: ${opts.groupName || opts.chatId}` : "Private";
    const fields = [
      { name: "Sender", value: `${opts.sender}${opts.isOwner ? " (Owner)" : ""}`, inline: true },
      { name: "Chat", value: chatLabel, inline: true },
      { name: "Model", value: opts.model || "unknown", inline: true },
    ];

    if (opts.isImage) fields.push({ name: "Media", value: "Image", inline: true });
    if (opts.isAudio) fields.push({ name: "Media", value: "Voice Note", inline: true });
    if (opts.isVoice) fields.push({ name: "Reply", value: "Voice", inline: true });
    if (opts.searchQuery) fields.push({ name: "Search", value: opts.searchQuery, inline: true });

    await fetch(LOG_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "Chat Log",
            color: opts.isOwner ? 3447003 : 5763719, // blue for owner, green for others
            fields,
            description: `**Q:** ${opts.message.slice(0, 500)}\n\n**A:** ${opts.reply.slice(0, 500)}`,
            footer: { text: `${opts.senderId} | ${opts.chatId}` },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch {
    console.error("[Discord] Failed to send chat log");
  }
}
