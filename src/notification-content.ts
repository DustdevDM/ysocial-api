export function notificationPreview(content: string) {
  const characters = Array.from(content.replace(/\s+/gu, " ").trim());
  return characters.length > 160
    ? `${characters.slice(0, 159).join("")}…`
    : characters.join("");
}
