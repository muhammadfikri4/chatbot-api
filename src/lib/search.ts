interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function searchWeb(query: string): Promise<SearchResult[]> {
  // Try DuckDuckGo Lite first, fallback to HTML
  const methods = [searchDDGLite, searchDDGHTML];

  for (const method of methods) {
    try {
      const results = await method(query);
      if (results.length > 0) {
        console.log(`[Search] Found ${results.length} results`);
        return results;
      }
    } catch (err) {
      console.error(`[Search] Method failed:`, err);
    }
  }

  console.log("[Search] All methods returned 0 results");
  return [];
}

async function searchDDGLite(query: string): Promise<SearchResult[]> {
  const res = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    body: `q=${encodeURIComponent(query)}`,
  });

  if (!res.ok) return [];

  const html = await res.text();
  const results: SearchResult[] = [];

  // DDG Lite uses table rows with class "result-link" for titles
  const linkMatches = [...html.matchAll(/<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
  const snippetMatches = [...html.matchAll(/<td class="result-snippet">([^<]+)/g)];

  for (let i = 0; i < Math.min(linkMatches.length, 3); i++) {
    const url = linkMatches[i][1];
    const title = linkMatches[i][2].trim();
    const snippet = snippetMatches[i] ? snippetMatches[i][1].trim() : "";

    if (title && url && url.startsWith("http")) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

async function searchDDGHTML(query: string): Promise<SearchResult[]> {
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

  const resultBlocks = html.split('class="result__body"');
  for (let i = 1; i < resultBlocks.length && results.length < 3; i++) {
    const block = resultBlocks[i];

    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    const title = titleMatch ? titleMatch[1].trim() : "";

    const urlMatch = block.match(/href="([^"]+)".*class="result__a"/);
    let url = "";
    if (urlMatch) {
      const decoded = decodeURIComponent(urlMatch[1]);
      const uddgMatch = decoded.match(/uddg=([^&]+)/);
      url = uddgMatch ? decodeURIComponent(uddgMatch[1]) : decoded;
    }

    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//);
    const snippet = snippetMatch
      ? snippetMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

export async function fetchPageContent(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!res.ok) return "";

    const html = await res.text();

    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length > 2000) text = text.slice(0, 2000) + "...";

    return text;
  } catch {
    return "";
  }
}
