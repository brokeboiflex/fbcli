import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCookies, NotLoggedIn } from "../src/browser.ts";

const dir = mkdtempSync(join(tmpdir(), "fbcli-cookies-"));

function fixture(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("loadCookies", () => {
  test("reads a browser-extension JSON array with all the rich fields", () => {
    const p = fixture(
      "ext.json",
      JSON.stringify([
        {
          name: "c_user",
          value: "100000000000000",
          domain: ".facebook.com",
          path: "/",
          secure: true,
          httpOnly: false,
          sameSite: "no_restriction",
          expirationDate: 1893456000,
        },
        { name: "xs", value: "42%3Aabc", domain: ".facebook.com", sameSite: "lax" },
        { name: "datr", value: "d", domain: ".facebook.com", httpOnly: true },
      ]),
    );
    const cookies = loadCookies(p);
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toEqual({
      name: "c_user",
      value: "100000000000000",
      domain: ".facebook.com",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "None",
      expires: 1893456000,
    });
    // Missing fields fall back to the same defaults the Python version used.
    expect(cookies[1]).toMatchObject({ path: "/", secure: true, sameSite: "Lax" });
    expect(cookies[1]).not.toHaveProperty("expires");
    expect(cookies[2]).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  });

  test("reads a simple JSON object", () => {
    const p = fixture("simple.json", '{"c_user":"100","xs":"abc","fr":"x"}');
    expect(loadCookies(p)).toEqual([
      { name: "c_user", value: "100", domain: ".facebook.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax" },
      { name: "xs", value: "abc", domain: ".facebook.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax" },
      { name: "fr", value: "x", domain: ".facebook.com", path: "/", secure: true, httpOnly: false, sameSite: "Lax" },
    ]);
  });

  test("reads a Netscape cookies.txt jar and drops non-facebook domains", () => {
    const p = fixture(
      "cookies.txt",
      [
        "# Netscape HTTP Cookie File",
        "# This is a generated file!  Do not edit.",
        "",
        ".facebook.com\tTRUE\t/\tTRUE\t1893456000\tc_user\t100000000000000",
        "#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t1893456000\txs\t42%3Aabc",
        ".example.com\tTRUE\t/\tFALSE\t0\tsession\tnope",
        "malformed line with too few fields",
      ].join("\n"),
    );
    const cookies = loadCookies(p);
    expect(cookies.map((c) => c.name)).toEqual(["c_user", "xs"]);
    // MozillaCookieJar drops secure/expiry when fbcli re-reads it, so defaults apply.
    expect(cookies[0]).toEqual({
      name: "c_user",
      value: "100000000000000",
      domain: ".facebook.com",
      path: "/",
      secure: true,
      httpOnly: false,
      sameSite: "Lax",
    });
  });

  test("detects a tab-separated jar even without the Netscape banner", () => {
    const p = fixture(
      "bare.txt",
      ".facebook.com\tTRUE\t/\tTRUE\t0\tc_user\t100\n.facebook.com\tTRUE\t/\tTRUE\t0\txs\tabc\n",
    );
    expect(loadCookies(p).map((c) => c.name)).toEqual(["c_user", "xs"]);
  });

  test("reads a raw Cookie header string", () => {
    const cookies = loadCookies("c_user=100000000000000; xs=42%3Aabc; datr=zzz");
    expect(cookies.map((c) => [c.name, c.value])).toEqual([
      ["c_user", "100000000000000"],
      ["xs", "42%3Aabc"],
      ["datr", "zzz"],
    ]);
  });

  test("accepts newline-separated inline cookies and skips junk segments", () => {
    const cookies = loadCookies("c_user=100\nxs=abc;; garbage ;");
    expect(cookies.map((c) => c.name)).toEqual(["c_user", "xs"]);
  });

  test("keeps the first '=' as the separator so encoded values survive", () => {
    const cookies = loadCookies("c_user=100; xs=a=b=c");
    expect(cookies[1]!.value).toBe("a=b=c");
  });

  test("rejects a jar without the essential session cookies", () => {
    expect(() => loadCookies("datr=zzz; sb=yyy")).toThrow(NotLoggedIn);
    expect(() => loadCookies("datr=zzz; sb=yyy")).toThrow(
      "Missing essential cookie(s): c_user, xs.",
    );
    expect(() => loadCookies("c_user=100")).toThrow("Missing essential cookie(s): xs.");
  });

  test("ignores zero and negative expiry values", () => {
    const p = fixture(
      "exp.json",
      JSON.stringify([
        { name: "c_user", value: "1", expirationDate: 0 },
        { name: "xs", value: "2", expirationDate: -1 },
      ]),
    );
    for (const c of loadCookies(p)) expect(c).not.toHaveProperty("expires");
  });
});
