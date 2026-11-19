import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";

const require = createRequire(import.meta.url);
export const badgeIconDirectory = join(dirname(require.resolve("lucide-static/package.json")), "icons");
const badgeIconNames = new Set(readdirSync(badgeIconDirectory)
  .filter((file) => /^[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/.test(file))
  .map((file) => file.slice(0, -4))
  .sort());

export const badgePresets = [
  { label: "Developer", icon: "terminal", tooltip: "Developed this" },
  { label: "Bug Hunter", icon: "bug", tooltip: "Helped find and report bugs" },
  { label: "Community Contributor", icon: "heart-handshake", tooltip: "Contributed to the community" },
  { label: "Event Winner", icon: "trophy", tooltip: "Won a community event" },
];

export const badgeIcons = [...badgeIconNames];
export const isBadgeIcon = (icon: string) => badgeIconNames.has(icon);
export const badgeDetails = z.strictObject({
  icon: z.string().refine(isBadgeIcon),
  tooltip: z.string().trim().min(1).max(120).refine((text) => !text.includes("\u0000")),
});
export type ProfileBadge = z.infer<typeof badgeDetails> & { id: string };
