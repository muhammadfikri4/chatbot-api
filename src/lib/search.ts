interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(query: string): Promise<SearchResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!res.ok) return [];

    const html = await res.text();
    const results: SearchResult[] = [];

    // Parse DuckDuckGo HTML results
    const resultBlocks = html.split('class="result__body"');
    for (let i = 1; i < resultBlocks.length && results.length < 3; i++) {
      const block = resultBlocks[i];

      // Extract title
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract URL
      const urlMatch = block.match(/href="([^"]+)".*class="result__a"/);
      let url = "";
      if (urlMatch) {
        // DuckDuckGo wraps URLs in redirect
        const decoded = decodeURIComponent(urlMatch[1]);
        const uddgMatch = decoded.match(/uddg=([^&]+)/);
        url = uddgMatch ? decodeURIComponent(uddgMatch[1]) : decoded;
      }

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//);
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, "").trim()
        : "";

      if (title && url) {
        results.push({ title, url, snippet });
      }
    }

    return results;
  } catch (err) {
    console.error("[Search] Error:", err);
    return [];
  }
}

export async function fetchPageContent(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) return "";

    const html = await res.text();

    // Strip HTML tags, scripts, styles
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Limit to 2000 chars
    if (text.length > 2000) text = text.slice(0, 2000) + "...";

    return text;
  } catch {
    return "";
  }
}
