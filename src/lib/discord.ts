const DISCORD_WEBHOOK = process.env.DISCORD_ERROR_WEBHOOK || "";

export async function notifyError(
  context: string,
  error: string
): Promise<void> {
  if (!DISCORD_WEBHOOK) return;

  try {
    const timestamp = new Date().toISOString();

    await fetch(DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: "Chatbot Error",
            description: `**Context:** ${context}\n\n**Error:**\n\`\`\`\n${error.slice(0, 1000)}\n\`\`\``,
            color: 15158332, // red
            timestamp,
          },
        ],
      }),
    });
  } catch {
    console.error("[Discord] Failed to send error notification");
  }
}
