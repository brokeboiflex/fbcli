/**
 * Browser engine for fbcli — drives the real Facebook web UI via Playwright with
 * your account cookies injected. This replaces the retired mbasic HTML scraper:
 * because it runs Facebook's actual JavaScript, it is immune to the GraphQL
 * `doc_id` churn that breaks request-only tools.
 *
 * Cookie input is the same set of formats FBSession accepted, but here we prefer
 * the rich browser-extension export (name/value/domain/path/expiry/sameSite),
 * which maps directly onto Playwright's addCookies().
 */

import { existsSync, readFileSync } from "node:fs";
import {
  chromium,
  errors as pwErrors,
  type Browser as PWBrowser,
  type BrowserContext,
  type Page,
} from "playwright-core";

import { cookiesFromBrowser, isBrowserKeyword } from "./browser-cookies.ts";

export const FB = "https://www.facebook.com";
const ESSENTIAL = ["c_user", "xs"] as const;
export const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class FBError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FBError";
  }
}

export class NotLoggedIn extends FBError {
  constructor(message: string) {
    super(message);
    this.name = "NotLoggedIn";
  }
}

/** True when Playwright gave up waiting — the Python code's `PWTimeout`. */
export function isTimeout(err: unknown): boolean {
  return err instanceof pwErrors.TimeoutError;
}

export type SameSite = "Strict" | "Lax" | "None";

/** A cookie exactly as Playwright's `context.addCookies()` wants it. */
export interface PWCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite;
  expires?: number;
}

/** A loosely-typed cookie record as it comes out of any of the four formats. */
interface RawCookie {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: unknown;
  httpOnly?: unknown;
  sameSite?: unknown;
  expirationDate?: unknown;
  expires?: unknown;
}

function sameSiteOf(v: unknown): SameSite {
  const m: Record<string, SameSite> = {
    no_restriction: "None",
    lax: "Lax",
    strict: "Strict",
    none: "None",
    unspecified: "Lax",
  };
  if (v === null || v === undefined) return "Lax";
  return m[String(v).toLowerCase()] ?? "Lax";
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Parse a Netscape/Mozilla `cookies.txt` jar the way Python's MozillaCookieJar
 * does with ignore_discard/ignore_expires: 7 tab-separated fields per line,
 * `#HttpOnly_` prefixes stripped, everything else beginning with `#` ignored.
 */
function parseNetscapeCookies(text: string): RawCookie[] {
  const out: RawCookie[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    else if (line.trimStart().startsWith("#")) continue;
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 7) continue;
    const [domain, , path, secure, expires, rawName, rawValue] = f as [
      string, string, string, string, string, string, string,
    ];
    // MozillaCookieJar's quirk: a jar line with an empty name field encodes a
    // valueless cookie, so the "value" column is really the name.
    const name = rawName === "" ? rawValue : rawName;
    const value = rawName === "" ? "" : rawValue;
    out.push({
      name,
      value,
      domain,
      path,
      secure: secure.toUpperCase() === "TRUE",
      expires,
    });
  }
  return out;
}

/**
 * Warn (but don't fail) when an essential cookie has already expired — turns a
 * confusing mid-run login redirect into an actionable "re-export your cookies".
 */
export function staleCookies(cookies: PWCookie[], now = Date.now() / 1000): string[] {
  return cookies
    .filter((c) => ESSENTIAL.includes(c.name as (typeof ESSENTIAL)[number]))
    .filter((c) => c.expires !== undefined && c.expires > 0 && c.expires < now)
    .map((c) => c.name);
}

/** Return a Playwright-ready cookie list from a file, inline string, or browser. */
export function loadCookies(source: string): PWCookie[] {
  // A bare browser name ("brave", "chrome:Profile 1") means: read that browser's
  // encrypted cookie store directly. Opt-in only — never auto-detected.
  if (isBrowserKeyword(source)) {
    const out = cookiesFromBrowser(source);
    const names = new Set(out.map((c) => c.name));
    const missing = ESSENTIAL.filter((n) => !names.has(n));
    if (missing.length) {
      throw new NotLoggedIn(
        `Missing essential cookie(s): ${missing.join(", ")}. ` +
          `Log in to Facebook in that browser first.`,
      );
    }
    return out;
  }

  let raw: RawCookie[] = [];
  let isFile = false;
  try {
    isFile = existsSync(source);
  } catch {
    isFile = false; // e.g. an inline cookie string too long to be a path
  }

  if (isFile) {
    const text = readFileSync(source, "utf8").trim();
    if (
      text.startsWith("# Netscape") ||
      text.startsWith("# HTTP Cookie") ||
      (text.includes("\t") && text.toLowerCase().includes("facebook"))
    ) {
      raw = parseNetscapeCookies(text)
        .filter((c) => (c.domain ?? "").includes("facebook"))
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || ".facebook.com",
          path: c.path || "/",
        }));
    } else {
      const data: unknown = JSON.parse(text);
      if (Array.isArray(data)) {
        raw = data as RawCookie[];
      } else if (data && typeof data === "object") {
        raw = Object.entries(data as Record<string, unknown>).map(([k, v]) => ({
          name: k,
          value: String(v),
        }));
      }
    }
  } else {
    for (const chunk of source.replace(/\n/g, ";").split(";")) {
      const part = chunk.trim();
      const eq = part.indexOf("=");
      if (eq !== -1) {
        raw.push({
          name: part.slice(0, eq).trim(),
          value: part.slice(eq + 1).trim(),
        });
      }
    }
  }

  const out: PWCookie[] = [];
  for (const c of raw) {
    if (c == null || c.name === undefined || c.value === undefined) continue;
    const ck: PWCookie = {
      name: c.name,
      value: c.value,
      domain: c.domain ?? ".facebook.com",
      path: c.path ?? "/",
      secure: c.secure === undefined ? true : Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly ?? false),
      sameSite: sameSiteOf(c.sameSite),
    };
    const exp = asNumber(c.expirationDate ?? c.expires);
    if (exp !== null && exp > 0) ck.expires = exp;
    out.push(ck);
  }
  const names = new Set(out.map((c) => c.name));
  const missing = ESSENTIAL.filter((n) => !names.has(n));
  if (missing.length) {
    throw new NotLoggedIn(`Missing essential cookie(s): ${missing.join(", ")}.`);
  }
  return out;
}

export interface BrowserOptions {
  headed?: boolean;
  ua?: string;
  slow?: number;
  verbose?: boolean;
  timeout?: number;
  /** Launch a system browser by Playwright channel ("chrome", "msedge", …). */
  channel?: string;
  /** Launch a specific browser binary instead of a downloaded Chromium. */
  executablePath?: string;
}

/** A Playwright browser with FB cookies pre-loaded; `open()` then `close()`. */
export class Browser {
  readonly cookies: PWCookie[];
  readonly uid: string;
  readonly headed: boolean;
  readonly ua: string;
  readonly slow: number;
  readonly verbose: boolean;
  readonly timeout: number;
  readonly channel: string | undefined;
  readonly executablePath: string | undefined;

  private pwBrowser: PWBrowser | null = null;
  ctx: BrowserContext | null = null;
  /** Set once `open()` has resolved; every action runs after that. */
  page!: Page;

  constructor(source: string, opts: BrowserOptions = {}) {
    this.cookies = loadCookies(source);
    const me = this.cookies.find((c) => c.name === "c_user");
    // loadCookies() already guaranteed c_user is present.
    this.uid = me!.value;
    this.headed = opts.headed ?? false;
    this.ua = opts.ua ?? DEFAULT_UA;
    this.slow = opts.slow ?? 0;
    this.verbose = opts.verbose ?? false;
    this.timeout = opts.timeout ?? 30000;
    this.channel = opts.channel ?? process.env.FBCLI_BROWSER_CHANNEL ?? undefined;
    this.executablePath = opts.executablePath ?? process.env.FBCLI_BROWSER ?? undefined;

    const stale = staleCookies(this.cookies);
    if (stale.length) {
      console.error(
        `warning: cookie(s) ${stale.join(", ")} look expired — ` +
          `if Facebook bounces you to login, re-export fresh cookies.`,
      );
    }
  }

  /** Resolve a browser (channel / binary / cache), build the cookie-loaded context, open a page. */
  async open(): Promise<this> {
    this.pwBrowser = await this.launch();
    this.ctx = await this.pwBrowser.newContext({
      userAgent: this.ua,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    this.ctx.setDefaultTimeout(this.timeout);
    await this.ctx.addCookies(this.cookies);
    this.page = await this.ctx.newPage();
    return this;
  }

  /** Launch Chromium, preferring a system browser so nothing has to be downloaded. */
  private async launch(): Promise<PWBrowser> {
    const launchOpts: Parameters<typeof chromium.launch>[0] = {
      headless: !this.headed,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
      slowMo: this.slow,
    };
    if (this.executablePath) launchOpts.executablePath = this.executablePath;
    else if (this.channel) launchOpts.channel = this.channel;
    try {
      return await chromium.launch(launchOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Executable doesn'?t exist|looks like .*not been downloaded|channel/i.test(msg)) {
        throw new FBError(
          "No browser found to drive Facebook. Point fbcli at one with " +
            "--channel chrome (or --browser-path <binary>), set FBCLI_BROWSER, " +
            "or install one with `bunx playwright install chromium`.\n" +
            `(underlying: ${msg.split("\n")[0]})`,
        );
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    try {
      if (this.ctx) await this.ctx.close();
      if (this.pwBrowser) await this.pwBrowser.close();
    } finally {
      this.ctx = null;
      this.pwBrowser = null;
    }
  }

  /** Lets callers write `await using b = await Browser.start(...)`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Construct + open in one step (the Python `with Browser(...)` entry). */
  static async start(source: string, opts: BrowserOptions = {}): Promise<Browser> {
    return await new Browser(source, opts).open();
  }

  // -- navigation ----------------------------------------------------------
  async goto(path: string, wait: "load" | "domcontentloaded" | "networkidle" | "commit" = "domcontentloaded"): Promise<void> {
    const url = path.startsWith("http")
      ? path
      : FB + (path.startsWith("/") ? path : "/" + path);
    if (this.verbose) console.log(`[nav] ${url}`);
    await this.page.goto(url, { waitUntil: wait });
    this.guardLogin();
  }

  private guardLogin(): void {
    const u = this.page.url().toLowerCase();
    const markers = [
      "/login",
      "login.php",
      "/checkpoint",
      "/two_step_verification",
      "two_factor",
      "/recover",
    ];
    if (markers.some((m) => u.includes(m))) {
      throw new NotLoggedIn(
        "Facebook redirected to login/checkpoint — cookies expired or a " +
          "security check is required. Re-export fresh cookies.",
      );
    }
  }

  async settle(ms = 1500): Promise<void> {
    try {
      await this.page.waitForLoadState("networkidle", { timeout: ms });
    } catch (err) {
      if (!isTimeout(err)) throw err;
    }
  }
}

/** Run `fn` with an open browser, always closing it afterwards. */
export async function withBrowser<T>(
  source: string,
  opts: BrowserOptions,
  fn: (b: Browser) => Promise<T>,
): Promise<T> {
  const b = await Browser.start(source, opts);
  try {
    return await fn(b);
  } finally {
    await b.close();
  }
}
