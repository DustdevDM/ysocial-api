import assert from "node:assert/strict";
import test from "node:test";
import { notificationPreview } from "../src/notification-content.ts";

test("short previews are collapsed and trimmed", () => {
  assert.equal(notificationPreview("  hello \n\n world  "), "hello world");
  assert.equal(notificationPreview("love it ❤️👨‍👩‍👧‍👦"), "love it ❤️👨‍👩‍👧‍👦");
});

test("long previews never cut an emoji in half", () => {
  const family = "👨‍👩‍👧‍👦";
  const content = family.repeat(200);
  const preview = notificationPreview(content);
  assert.equal(preview, `${family.repeat(159)}…`);
  const flags = notificationPreview(`${"a".repeat(158)}🇩🇪🇩🇪🇩🇪`);
  assert.equal(flags, `${"a".repeat(158)}🇩🇪…`);
});

test("GIF posts use their caption or a GIF fallback", () => {
  assert.equal(notificationPreview("", true), "GIF");
  assert.equal(notificationPreview(""), "");
  assert.equal(notificationPreview(" 👋 ", true), "👋");
});
