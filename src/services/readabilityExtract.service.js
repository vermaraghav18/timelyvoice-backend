import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// Fetch a URL and return the Readability-extracted HTML content (main article).
export async function extractReadable(url) {
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return "";
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    return article?.content || "";
  } catch {
    return "";
  }
}
