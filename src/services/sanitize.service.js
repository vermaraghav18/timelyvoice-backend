import sanitizeHtml from "sanitize-html";

// Remove site chrome and sanitize allowed content.
export function cleanseHtml(html = "") {
  if (!html) return "";

  let cleaned = html
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "");

  const langTokens = [
    "english","हिंदी","தமிழ்","తెలుగు","বাংলা","ગુજરાતી","मराठी","മലയാളം","اردو","ଓଡ଼ିଆ","ಕನ್ನಡ","ਪੰਜਾਬੀ","অসমীয়া"
  ];
  for (const tok of langTokens) {
    const rx = new RegExp(`<[^>]*>${tok}<[^>]*>`, "gi");
    cleaned = cleaned.replace(rx, "");
    cleaned = cleaned.replace(new RegExp(`(>\s*)?${tok}(\s*<)?`, "gi"), "");
  }

  cleaned = sanitizeHtml(cleaned, {
    allowedTags: [
      "p","h2","h3","ul","ol","li","blockquote","strong","em",
      "a","img","figure","figcaption","br","code","pre"
    ],
    allowedAttributes: {
      a: ["href","title","rel","target"],
      img: ["src","alt","width","height","loading"]
    },
    allowedSchemes: ["http","https","data"],
    allowedStyles: {},
    exclusiveFilter: (frame) => {
      if ((frame.tag === "p" || frame.tag === "li") && !frame.text.trim()) return true;
      return false;
    }
  });

  cleaned = cleaned.replace(/<p>\s*<\/p>/g, "").replace(/\n{3,}/g, "\n\n");
  return cleaned;
}
