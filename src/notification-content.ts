export function notificationPreview(content: string, hasGif: boolean) {
  if (!content && hasGif) return "GIF";
  const characters = Array.from(content.replace(/\s+/gu, " ").trim());
  return characters.length > 160
    ? `${characters.slice(0, 159).join("")}…`
    : characters.join("");
}
