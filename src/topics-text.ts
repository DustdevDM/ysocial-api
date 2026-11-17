// A topic is written as #name inside a top-level post. Names start with a
// letter, continue with letters, digits or underscores, and are case-insensitive.
// The same grammar lives in the web client (src/lib/topics.ts) and in the SQL
// backfill of drizzle/0017_*.sql; keep the three in step.
export const TOPIC_MAX_LENGTH = 32;
export const MAX_TOPICS_PER_POST = 10;
export const TOPIC_NAME_PATTERN = /^\p{L}[\p{L}\p{N}_]{0,31}$/u;

// "#" must not follow a word character (so "a#b" and URL fragments are not
// topics) and a name must not run straight into another "#".
const TOPIC_PATTERN = /(?<![\p{L}\p{N}_&/#])#(\p{L}[\p{L}\p{N}_]{0,31})(?![\p{L}\p{N}_#])/gu;

export function normalizeTopic(name: string) {
  return name.normalize("NFC").toLowerCase();
}

export function isTopicName(name: string) {
  return TOPIC_NAME_PATTERN.test(name);
}

/** Distinct normalized topics of a post, in order of first use. */
export function extractTopics(content: string) {
  const topics = new Set<string>();
  for (const match of content.matchAll(TOPIC_PATTERN)) {
    topics.add(normalizeTopic(match[1]));
    if (topics.size === MAX_TOPICS_PER_POST) break;
  }
  return [...topics];
}
