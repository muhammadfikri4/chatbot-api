/**
 * Transcribe audio using Groq Whisper API (free) or OpenAI Whisper.
 * Supports downloading audio from URL and sending to STT service.
 */

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const WAHA_API_KEY = process.env.WAHA_API_KEY || "";

export async function transcribeAudio(audioUrl: string): Promise<string> {
  // Download audio file (with WAHA auth if needed)
  const headers: Record<string, string> = {};
  if (WAHA_API_KEY && audioUrl.includes("/api/")) {
    headers["X-Api-Key"] = WAHA_API_KEY;
  }

  const audioRes = await fetch(audioUrl, { headers });
  if (!audioRes.ok) {
    throw new Error(`Failed to download audio: ${audioRes.status}`);
  }

  const audioBuffer = await audioRes.arrayBuffer();
  const audioBlob = new Blob([audioBuffer], { type: "audio/ogg" });

  // Use Groq Whisper API (free, fast)
  if (GROQ_API_KEY) {
    return transcribeWithGroq(audioBlob);
  }

  throw new Error("No transcription API key configured. Set GROQ_API_KEY.");
}

async function transcribeWithGroq(audioBlob: Blob): Promise<string> {
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.ogg");
  formData.append("model", "whisper-large-v3");
  formData.append("language", "id");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq Whisper error ${res.status}: ${text}`);
  }

  const data = await res.json() as { text: string };
  return data.text;
}
