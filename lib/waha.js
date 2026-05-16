const WAHA_API_URL = process.env.WAHA_API_URL || "http://localhost:3000";
const WAHA_API_KEY = process.env.WAHA_API_KEY || "";
const WAHA_SESSION = process.env.WAHA_SESSION || "default";

/**
 * Send a text message via WAHA API.
 */
async function sendText(chatId, text, mentions = []) {
  const body = {
    session: WAHA_SESSION,
    chatId,
    text,
  };
  if (mentions.length > 0) {
    body.mentions = mentions;
  }
  const res = await fetch(`${WAHA_API_URL}/api/sendText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(WAHA_API_KEY && { "X-Api-Key": WAHA_API_KEY }),
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WAHA sendText error ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Download media from a message and return as base64 data URL.
 */
async function downloadMedia(messageId) {
  const res = await fetch(
    `${WAHA_API_URL}/api/${WAHA_SESSION}/messages/${messageId}/download`,
    {
      method: "GET",
      headers: {
        ...(WAHA_API_KEY && { "X-Api-Key": WAHA_API_KEY }),
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WAHA downloadMedia error ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data;
}

module.exports = { sendText, downloadMedia };
