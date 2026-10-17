import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSelectors, DEFAULT_SELECTORS, SEL } from "../src/selectors.ts";

const dir = mkdtempSync(join(tmpdir(), "fbcli-sel-"));

afterEach(() => {
  delete process.env.FBCLI_SELECTORS;
});

describe("the selector registry", () => {
  test("compiles CSS entries as strings and name entries as case-insensitive RegExps", () => {
    expect(typeof SEL.article).toBe("string");
    expect(SEL.article).toBe('div[role="article"]');
    expect(SEL.postButton).toBeInstanceOf(RegExp);
    expect(SEL.postButton.flags).toContain("i");
    expect(SEL.postButton.test("Post")).toBe(true);
    expect(SEL.postButton.test("Posting")).toBe(false);
  });

  test("every key in the defs is resolved", () => {
    const sel = buildSelectors();
    for (const k of Object.keys(DEFAULT_SELECTORS)) {
      expect(sel[k as keyof typeof sel]).toBeDefined();
    }
  });

  test("FBCLI_SELECTORS overrides only the named entries", () => {
    const p = join(dir, "override.json");
    writeFileSync(p, JSON.stringify({ article: "div[data-foo]", postButton: "^Publish$" }));
    process.env.FBCLI_SELECTORS = p;
    const sel = buildSelectors();
    expect(sel.article).toBe("div[data-foo]");
    expect(sel.postButton.test("Publish")).toBe(true);
    expect(sel.postButton.test("Post")).toBe(false);
    // Untouched entries keep their defaults.
    expect(sel.likeButton.test("Like")).toBe(true);
  });

  test("a missing override file falls back to defaults", () => {
    process.env.FBCLI_SELECTORS = join(dir, "does-not-exist.json");
    const sel = buildSelectors();
    expect(sel.article).toBe(DEFAULT_SELECTORS.article);
  });

  test("the composer opener matches each surface's wording", () => {
    for (const t of ["What's on your mind", "Write something", "Start a discussion"]) {
      expect(SEL.composerOpener.test(t)).toBe(true);
    }
  });
});
