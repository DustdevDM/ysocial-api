import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import satori from "satori";
import sharp from "sharp";
import { excerpt, stripUnrenderable, type OgPost } from "./text.ts";

const WIDTH = 1200;
const HEIGHT = 630;
const subsets = ["latin", "latin-ext", "cyrillic", "greek", "vietnamese"];
const font = (subset: string) =>
  readFile(
    fileURLToPath(
      import.meta.resolve(
        `@fontsource/inter/files/inter-${subset}-700-normal.woff`,
      ),
    ),
  );
const resources = (async () => {
  const [template, ...faces] = await Promise.all([
    readFile(new URL("./assets/post-template.png", import.meta.url)),
    ...subsets.map(font),
  ]);
  return {
    templateUri: `data:image/png;base64,${template.toString("base64")}`,
    fonts: faces.map((data, index) => ({
      name: `Inter-${subsets[index]}`,
      data,
      weight: 700 as const,
      style: "normal" as const,
    })),
  };
})();

type Node = { type: string; props: Record<string, unknown> };
const h = (
  type: string,
  style: Record<string, unknown>,
  children?: unknown,
): Node => ({ type, props: { style: { display: "flex", ...style }, children } });

const bodySize = (text: string) =>
  text.length < 80 ? 60 : text.length < 160 ? 48 : 40;

function card(post: OgPost, templateUri: string, avatar: string | null): Node {
  const name = stripUnrenderable(post.author.displayName) || post.author.handle;
  const text =
    excerpt(stripUnrenderable(post.content), 260) ||
    (post.poll
      ? excerpt(stripUnrenderable(post.poll.title), 150)
      : post.gif
        ? "Shared a GIF"
        : post.voice
          ? "Voice message"
          : `${post.parentId ? "Reply" : "Post"} by @${post.author.handle}`);
  const initial = [...name][0]?.toUpperCase() ?? "?";
  return h(
    "div",
    { width: WIDTH, height: HEIGHT, position: "relative", fontFamily: subsets.map((subset) => `Inter-${subset}`).join(", "), color: "#f5f5f5" },
    [
      {
        type: "img",
        props: {
          src: templateUri,
          width: WIDTH,
          height: HEIGHT,
          style: { position: "absolute", top: 0, left: 0 },
        },
      },
      h(
        "div",
        {
          position: "absolute",
          top: 150,
          left: 56,
          width: 1088,
          height: 410,
          flexDirection: "column",
          justifyContent: "space-between",
        },
        [
          h(
            "div",
            {
              flex: 1,
              fontSize: bodySize(text),
              fontWeight: 700,
              lineHeight: 1.2,
              letterSpacing: -1,
              overflow: "hidden",
              wordBreak: "break-word",
            },
            text,
          ),
          h("div", { alignItems: "center", marginTop: 24 }, [
            avatar
              ? {
                  type: "img",
                  props: { src: avatar, width: 64, height: 64, style: { borderRadius: 32 } },
                }
              : h(
                  "div",
                  {
                    width: 64,
                    height: 64,
                    borderRadius: 32,
                    background: "#16dc64",
                    color: "#101010",
                    fontSize: 32,
                    fontWeight: 700,
                    alignItems: "center",
                    justifyContent: "center",
                  },
                  initial,
                ),
            h("div", { flexDirection: "column", marginLeft: 18 }, [
              h("div", { fontSize: 30, fontWeight: 700 }, excerpt(name, 40)),
              h(
                "div",
                { fontSize: 24, color: "#a3a3a3", fontWeight: 700 },
                `@${post.author.handle}${post.parentId ? " · reply" : ""}`,
              ),
            ]),
          ]),
        ],
      ),
    ],
  );
}

export async function renderPostCard(post: OgPost, avatar: string | null = null) {
  const { templateUri, fonts } = await resources;
  const svg = await satori(card(post, templateUri, avatar) as never, {
    width: WIDTH,
    height: HEIGHT,
    fonts,
  });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function avatarDataUri(bytes: Uint8Array) {
  const png = await sharp(bytes)
    .resize(128, 128, { fit: "cover" })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}
