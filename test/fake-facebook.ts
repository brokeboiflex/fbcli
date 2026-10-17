/**
 * A tiny stand-in for facebook.com so the Playwright flows can be exercised
 * end-to-end in a real Chromium without touching the network or an account.
 *
 * Every request from the browser context is intercepted: paths are looked up in
 * `html` (served as a document) or `json` (served as an API response), with `*`
 * as the catch-all. Pages can record what the automation did on `window.__fb`,
 * which `probe()` reads back.
 */

import { Browser } from "../src/browser.ts";

export interface FakeSite {
  html?: Record<string, string>;
  json?: Record<string, string>;
  /** Paths that should 302 somewhere else — used for the login guard. */
  redirect?: Record<string, string>;
}

export const COOKIES = "c_user=100000000000000; xs=secret; datr=zzz";

export function page(body: string, head = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}

/** Start a cookie-loaded Browser whose every request is served by `site`. */
export async function withFakeFB<T>(
  site: FakeSite,
  fn: (b: Browser) => Promise<T>,
): Promise<T> {
  const b = await Browser.start(COOKIES, { timeout: 8000 });
  try {
    await b.ctx!.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const to = site.redirect?.[path];
      if (to !== undefined) {
        return await route.fulfill({ status: 302, headers: { location: to }, body: "" });
      }
      const json = site.json?.[path];
      if (json !== undefined) {
        return await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: json,
        });
      }
      const html = site.html?.[path] ?? site.html?.["*"];
      if (html === undefined) {
        return await route.fulfill({
          status: 404,
          contentType: "text/html; charset=utf-8",
          body: page("<p>not found</p>"),
        });
      }
      return await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: html,
      });
    });
    return await fn(b);
  } finally {
    await b.close();
  }
}

/** Read a value the fixture page stashed on `window.__fb`. */
export async function probe(b: Browser, key: string): Promise<unknown> {
  return await b.page.evaluate(
    (k) => (window as unknown as { __fb?: Record<string, unknown> }).__fb?.[k],
    key,
  );
}

/** Boilerplate every fixture page includes to record automation activity. */
export const RECORDER = `<script>window.__fb = {};</script>`;
