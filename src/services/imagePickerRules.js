"use strict";

/**
 * Rules + dictionaries used by imageStrategy.
 * Keep this file editable so you can tune behavior without touching logic.
 */

// Tags too broad to drive a “tag match” pick
const GENERIC_TAGS = new Set([
  "india",
  "world",
  "general",
  "news",
  "politic",
  "politics",
  "trending",
  "viral",
  "update",
  "breaking",
  "today",
  "latest",
  "report",
  "headline",
  "story",
  "international",
  "national",
  "state",
  "government",
  "govt",
  "election",
  "crime",
  "sport",
  "sports",
  "finance",
  "business",
  "economy",
  "health",
  "technology",
  "tech",
  "entertainment",
  "bollywood",
]);

// Simple English stopwords for title/summary keyword extraction
const STOPWORDS = new Set([
  "a","an","the","and","or","but","to","of","in","on","at","for","from","by","with",
  "as","is","are","was","were","be","been","being","it","this","that","these","those",
  "into","over","under","after","before","between","within","without","about","across",
  "up","down","out","off","near","more","most","new","latest","today","yesterday",
  "says","said","say","report","reports","reported","breaking","live","update","updates",
  "why","what","when","where","who","whom","which","how"
]);

/**
 * Negative tag penalties by article category.
 * Goal: stop obvious mismatches (politics picking sports/space templates etc.)
 * Tune freely.
 */
const NEGATIVE_TAGS_BY_CATEGORY = {
  politics: [
    "sports","cricket","ipl","football","hockey","match","tournament",
    "gaganyaan","isro","space","rocket","aerospace","astronaut",
    "boxoffice","movie","trailer","song","celebrity"
  ],
  sports: [
    "parliament","minister","election","policy","budget","rbi","inflation",
    "gaganyaan","space","rocket","isro",
    "movie","trailer","bollywood","celebrity"
  ],
  finance: [
    "cricket","ipl","football","hockey","match",
    "movie","trailer","bollywood","celebrity",
    "gaganyaan","space","rocket","isro"
  ],
  entertainment: [
    "rbi","inflation","budget","stocks","sensex","nifty","banking",
    "parliament","election","policy",
    "cricket","ipl","football","hockey",
    "gaganyaan","space","rocket","isro"
  ],
  health: [
    "cricket","ipl","football","hockey",
    "movie","trailer","bollywood","celebrity"
  ],
  world: [
    // Keep lighter here; world can span anything.
  ],
  india: [
    // Keep lighter here too.
  ],
};

// A lightweight category keyword map to help categorize when category is messy
const CATEGORY_KEYWORDS = {
  politics: ["parliament","minister","election","policy","bill","party","aap","bjp","congress","government","govt"],
  sports: ["cricket","ipl","football","hockey","match","tournament","league","semifinal","final","score","goal"],
  finance: ["rbi","inflation","sensex","nifty","stocks","market","bank","budget","gdp","oil","tariff","tax"],
  entertainment: ["bollywood","film","movie","trailer","actor","actress","song","boxoffice","celebrity"],
  health: ["cancer","diabetes","hospital","doctor","symptoms","treatment","health","disease"],
  space: ["isro","gaganyaan","rocket","space","satellite","astronaut","mission","launch"],
};

function isGenericTag(t) {
  return GENERIC_TAGS.has(String(t || "").trim().toLowerCase());
}

module.exports = {
  GENERIC_TAGS,
  STOPWORDS,
  NEGATIVE_TAGS_BY_CATEGORY,
  CATEGORY_KEYWORDS,
  isGenericTag,
};
