/**
 * Text-to-Speech using Google Translate TTS (free, Indonesian)
 */

export async function textToSpeech(text: string): Promise<string> {
  // Limit total text to prevent too many requests
  const limitedText = text.length > 500 ? text.slice(0, 500) + "." : text;
  const chunks = splitText(limitedText, 180);
  const audioBuffers: ArrayBuffer[] = [];

  for (const chunk of chunks) {
    const encoded = encodeURIComponent(chunk);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=id&client=tw-ob&q=${encoded}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Referer: "https://translate.google.com/",
      },
    });

    if (!res.ok) throw new Error(`Google TTS error ${res.status}`);
    audioBuffers.push(await res.arrayBuffer());
  }

  const totalLength = audioBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of audioBuffers) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  return Buffer.from(combined).toString("base64");
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const sentences = text.split(/(?<=[.!?。，,])\s*/);
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > maxLen && current) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence + " ";
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}
