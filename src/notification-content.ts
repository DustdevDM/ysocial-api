const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function notificationPreview(content: string) {
  const text = content.replace(/\s+/gu, " ").trim();
  const characters = Array.from(graphemes.segment(text), (part) => part.segment);
  return characters.length > 160
    ? `${characters.slice(0, 159).join("")}…`
    : text;
}
