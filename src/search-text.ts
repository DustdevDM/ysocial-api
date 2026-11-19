export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;
const MAX_WORDS = 8;
const MAX_WORD_LENGTH = 64;

export type SearchQuery = {
  term: string;
  words: string[];
  usable: boolean;
  tsquery: string | null;
};

export function parseSearchQuery(raw: string): SearchQuery {
  const term = raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[@#\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = term
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, MAX_WORDS)
    .map((word) => word.slice(0, MAX_WORD_LENGTH));
  const usable = Array.from(term).length >= SEARCH_MIN_LENGTH && words.length > 0;
  return {
    term,
    words,
    usable,
    tsquery: usable
      ? words.map((word, index) => (index === words.length - 1 ? `${word}:*` : word)).join(" & ")
      : null,
  };
}
