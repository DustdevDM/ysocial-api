const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function notificationPreview(content: string, hasGif = false, hasVoice = false) {
  const text = content.replace(/\s+/gu, " ").trim();
  if (!text && hasVoice) return "Voice message";
  if (!text && hasGif) return "GIF";
  const characters = Array.from(graphemes.segment(text), (part) => part.segment);
  return characters.length > 160
    ? `${characters.slice(0, 159).join("")}…`
    : text;
}
