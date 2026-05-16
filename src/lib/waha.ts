const WAHA_API_URL = process.env.WAHA_API_URL || "http://localhost:3000";
const WAHA_API_KEY = process.env.WAHA_API_KEY || "";
const WAHA_SESSION = process.env.WAHA_SESSION || "default";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (WAHA_API_KEY) h["X-Api-Key"] = WAHA_API_KEY;
  return h;
}

export async function sendText(
  chatId: string,
  text: string,
  mentions: string[] = []
): Promise<unknown> {
  const body: Record<string, unknown> = {
    session: WAHA_SESSION,
    chatId,
    text,
  };
  if (mentions.length > 0) body.mentions = mentions;

  const res = await fetch(`${WAHA_API_URL}/api/sendText`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WAHA sendText error ${res.status}: ${errBody}`);
  }

  return res.json();
}

export async function startTyping(chatId: string): Promise<void> {
  await fetch(`${WAHA_API_URL}/api/startTyping`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ session: WAHA_SESSION, chatId }),
  }).catch(() => {});
}

export async function stopTyping(chatId: string): Promise<void> {
  await fetch(`${WAHA_API_URL}/api/stopTyping`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ session: WAHA_SESSION, chatId }),
  }).catch(() => {});
}

export async function downloadMedia(messageId: string): Promise<unknown> {
  const res = await fetch(
    `${WAHA_API_URL}/api/${WAHA_SESSION}/messages/${messageId}/download`,
    { method: "GET", headers: headers() }
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`WAHA downloadMedia error ${res.status}: ${errBody}`);
  }

  return res.json();
}
