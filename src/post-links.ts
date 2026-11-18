import { find } from "linkifyjs";

export function postLinks(content: string) {
  return find(content, "url", { defaultProtocol: "https" }).flatMap(
    ({ href }) => {
      const url = URL.parse(href);
      return url && (url.protocol === "http:" || url.protocol === "https:")
        ? [url]
        : [];
    },
  );
}
