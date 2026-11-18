import assert from "node:assert/strict";
import { test } from "node:test";
import {
  imgurImageUrl,
  readPreviewMetadata,
  websiteLinks,
} from "../src/link-previews.ts";
import {
  canPreviewUrl,
  isPublicPreviewAddress,
} from "../src/public-preview-fetch.ts";

test("recognizes Imgur images without accepting other image hosts", () => {
  const direct = "https://i.imgur.com/BV56U5T.png";
  assert.equal(imgurImageUrl(new URL(direct))?.href, direct);
  assert.equal(
    imgurImageUrl(new URL("https://imgur.com/BV56U5T"))?.href,
    direct,
  );
  for (const href of [
    "https://example.org/BV56U5T.png",
    "https://i.imgur.com.example.org/BV56U5T.png",
    "https://i.imgur.com:3000/BV56U5T.png",
    "https://imgur.com/a/BV56U5T",
    "https://imgur.com/about",
  ]) {
    assert.equal(imgurImageUrl(new URL(href)), undefined, href);
  }
});

test("reads Open Graph metadata and resolves relative images from the page", () => {
  const page = new URL("https://example.org/projects/one");
  const html = `
    <title>Fallback</title>
    <meta content="Example &amp; Co" property="og:site_name">
    <meta name="og:title" content="Project One">
    <meta name="og:description" content="  First\n project ">
    <meta property="og:image" content="/social.png">
    <link rel="icon" type="image/svg+xml" href="/logo.svg">
    <link rel="alternate icon" href="/icons/favicon.png">
    <body><meta property="og:title" content="Ignored"></body>
  `;
  const metadata = readPreviewMetadata(html, page);
  assert.equal(metadata.title, "Project One");
  assert.equal(metadata.siteName, "Example & Co");
  assert.equal(metadata.description, "First project");
  assert.equal(metadata.image.href, "https://example.org/social.png");
  assert.equal(metadata.icon.href, "https://example.org/icons/favicon.png");
});

test("uses HTML fallbacks and ignores unsuitable images", () => {
  const url = new URL("https://example.org");
  assert.deepEqual(
    readPreviewMetadata(
      `
    <title>Basic page</title>
    <meta name="description" content="A page summary">
    <meta property="og:image" content="data:image/png,example">
    <link rel="icon" href="http://localhost/favicon.png">
  `,
      url,
    ),
    {
      title: "Basic page",
      description: "A page summary",
      siteName: "example.org",
      image: undefined,
      icon: new URL("https://example.org/favicon.ico"),
    },
  );
  assert.equal(
    readPreviewMetadata("<p>Nothing to preview</p>", url),
    undefined,
  );
});

test("selects distinct website links without truncating the list", () => {
  const content = [
    "https://ysocial.cns-preview.de/posts/id",
    "http://localhost:3000/test",
    "https://example.org/a",
    "https://example.org/a",
    "example.org/b",
    "example.org/c",
    "example.org/d",
    "example.org/e",
    "example.org/f",
  ].join(" ");
  assert.deepEqual(
    websiteLinks(content).map((url) => url.pathname),
    ["/a", "/b", "/c", "/d", "/e", "/f"],
  );
  assert.deepEqual(websiteLinks("http://localhost:3000/test"), []);
});

test("requires public DNS destinations and rejects restricted addresses", () => {
  for (const href of [
    "file:///test",
    "http://localhost",
    "http://127.0.0.1",
    "http://[::1]",
    "https://example.org:3000",
    "https://user@example.org",
  ]) {
    assert.equal(canPreviewUrl(new URL(href)), false, href);
  }
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.1.1",
    "192.168.0.1",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "64:ff9b::1",
  ]) {
    assert.equal(isPublicPreviewAddress(address), false, address);
  }
  assert.equal(isPublicPreviewAddress("8.8.8.8"), true);
  assert.equal(isPublicPreviewAddress("2606:4700:4700::1111"), true);
});
