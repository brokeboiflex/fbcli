import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";

import {
  chromeTimeToUnix,
  cookiesFromBrowser,
  decryptValue,
  isBrowserKeyword,
} from "../src/browser-cookies.ts";
import { FBError } from "../src/browser.ts";

const KEY = pbkdf2Sync("test-pass", "saltysalt", 1003, 16, "sha1");

/** Build a Chromium-style encrypted blob: v10 + AES-128-CBC(PKCS7(value)), optional domain-hash prefix. */
function encrypt(value: string, hostKey: string, withHash: boolean): Buffer {
  const iv = Buffer.alloc(16, " ");
  const cipher = createCipheriv("aes-128-cbc", KEY, iv);
  const plain = withHash
    ? Buffer.concat([createHash("sha256").update(hostKey).digest(), Buffer.from(value, "utf8")])
    : Buffer.from(value, "utf8");
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), body]);
}

describe("isBrowserKeyword", () => {
  test("recognises known browsers and profile suffixes", () => {
    for (const s of ["brave", "chrome", "chromium", "edge", "arc", "CHROME", "chrome:Profile 1"]) {
      expect(isBrowserKeyword(s)).toBe(true);
    }
  });
  test("rejects files, cookie strings and unknown browsers", () => {
    for (const s of ["./cookies.json", "c_user=1; xs=2", "firefox", "/tmp/x.txt"]) {
      expect(isBrowserKeyword(s)).toBe(false);
    }
  });
});

describe("decryptValue", () => {
  test("round-trips a v10 AES-128-CBC value", () => {
    const blob = encrypt("42%3Aabc", ".facebook.com", false);
    expect(decryptValue(blob, KEY, ".facebook.com")).toBe("42%3Aabc");
  });

  test("strips the Chrome ≥127 SHA-256(host_key) prefix", () => {
    const blob = encrypt("100000000000000", ".facebook.com", true);
    expect(decryptValue(blob, KEY, ".facebook.com")).toBe("100000000000000");
  });

  test("keeps a 32-byte-plus value that is not the host hash", () => {
    // A long value whose first 32 bytes are NOT sha256(host) must survive intact.
    const value = "z".repeat(50);
    const blob = encrypt(value, ".facebook.com", false);
    expect(decryptValue(blob, KEY, ".facebook.com")).toBe(value);
  });

  test("passes through an unencrypted (no v10/v11) blob", () => {
    expect(decryptValue(Buffer.from("plain", "utf8"), KEY, ".facebook.com")).toBe("plain");
  });
});

describe("chromeTimeToUnix", () => {
  test("converts microseconds-since-1601 to unix seconds", () => {
    // 1893456000 unix == (1893456000 + 11644473600) s × 1e6 == 13537929600000000 chrome-µs.
    expect(chromeTimeToUnix(13_537_929_600_000_000)).toBe(1_893_456_000);
  });
  test("treats 0 as a session cookie (undefined)", () => {
    expect(chromeTimeToUnix(0)).toBeUndefined();
  });
});

describe("cookiesFromBrowser", () => {
  test("rejects an unknown browser name", () => {
    expect(() => cookiesFromBrowser("netscape")).toThrow(FBError);
  });
});
