/**
 * Read Facebook session cookies straight out of a local Chromium browser's
 * encrypted cookie store (Brave / Chrome / Chromium / Edge / Arc …), so you can
 * run `fbcli --cookies brave whoami` without exporting a file by hand.
 *
 * This is deliberately opt-in: it is only reached when you pass a browser name
 * as the cookie source. It decrypts your live Facebook session, which is exactly
 * what the browser itself holds — treat the output like a password.
 *
 * Platforms:
 *   macOS   — key from the login Keychain ("<Browser> Safe Storage"), PBKDF2
 *             SHA1 × 1003, AES-128-CBC. The Keychain shows an access prompt the
 *             first time; that is the OS asking permission, which is correct.
 *   Linux   — "basic" storage only (password "peanuts", PBKDF2 × 1). A keyring-
 *             backed profile (gnome-keyring / kwallet) needs a manual export.
 *   Windows — App-Bound Encryption resists this by design; we tell you to export.
 */

import { createHash, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { FBError, type PWCookie, type SameSite } from "./browser.ts";

/** Browser keywords accepted as a cookie source, mapped to their quirks. */
interface BrowserSpec {
  /** macOS Keychain service name and the app-support subpath. */
  macService: string;
  macDir: string;
  /** Linux ~/.config subpath. */
  linuxDir: string;
}

const BROWSERS: Record<string, BrowserSpec> = {
  brave: {
    macService: "Brave Safe Storage",
    macDir: "BraveSoftware/Brave-Browser",
    linuxDir: "BraveSoftware/Brave-Browser",
  },
  chrome: {
    macService: "Chrome Safe Storage",
    macDir: "Google/Chrome",
    linuxDir: "google-chrome",
  },
  chromium: {
    macService: "Chromium Safe Storage",
    macDir: "Chromium",
    linuxDir: "chromium",
  },
  edge: {
    macService: "Microsoft Edge Safe Storage",
    macDir: "Microsoft Edge",
    linuxDir: "microsoft-edge",
  },
  arc: {
    macService: "Arc Safe Storage",
    macDir: "Arc/User Data",
    linuxDir: "Arc/User Data",
  },
  vivaldi: {
    macService: "Vivaldi Safe Storage",
    macDir: "Vivaldi",
    linuxDir: "vivaldi",
  },
  opera: {
    macService: "Opera Safe Storage",
    macDir: "com.operasoftware.Opera",
    linuxDir: "opera",
  },
};

/** A cookie source like "brave" or "chrome:Profile 1" names a browser, not a file. */
export function isBrowserKeyword(source: string): boolean {
  return BROWSERS[source.split(":")[0]!.trim().toLowerCase()] !== undefined;
}

/** A row as Chromium stores it. */
interface CookieRow {
  host_key: string;
  name: string;
  encrypted_value: Uint8Array;
  path: string;
  is_secure: number;
  is_httponly: number;
  expires_utc: number;
  samesite: number;
}

function keychainPassword(service: string): string {
  try {
    // `-w` prints only the secret; `-s` selects the generic-password service.
    return execFileSync("security", ["find-generic-password", "-w", "-s", service], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new FBError(
      `Could not read "${service}" from the macOS Keychain (denied or not found). ` +
        `Approve the prompt, or export cookies to a file and use --cookies <file>.`,
    );
  }
}

/** Find the SQLite cookie DB for a profile, checking the Network/ subdir Chromium moved to. */
function cookieDbPath(base: string, profile: string): string {
  const candidates = [
    join(base, profile, "Network", "Cookies"),
    join(base, profile, "Cookies"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  throw new FBError(
    `No cookie database for profile "${profile}" under ${base}. ` +
      `Is the browser installed and has it been run?`,
  );
}

/** AES-128-CBC with the fixed 16-space IV, PKCS7-stripped, domain-hash-stripped. */
export function decryptValue(blob: Uint8Array, key: Buffer, hostKey: string): string {
  const buf = Buffer.from(blob);
  if (buf.length === 0) return "";
  const prefix = buf.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") {
    // Unencrypted (old profiles) — the stored bytes are the value verbatim.
    return buf.toString("utf8");
  }
  const iv = Buffer.alloc(16, " ");
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  let out = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
  // Strip PKCS7 padding by hand (we disabled auto-padding to also handle the hash).
  const pad = out.length ? out[out.length - 1]! : 0;
  if (pad > 0 && pad <= 16 && pad <= out.length) out = out.subarray(0, out.length - pad);
  // Chrome/Brave ≥ v127 prepend SHA-256(host_key) to the plaintext; drop it if present.
  if (out.length >= 32) {
    const want = createHash("sha256").update(hostKey).digest();
    if (out.subarray(0, 32).equals(want)) out = out.subarray(32);
  }
  return out.toString("utf8");
}

function sameSiteOf(n: number): SameSite {
  if (n === 2) return "Strict";
  if (n === 0) return "None";
  return "Lax"; // 1 = Lax, -1 = unspecified → Lax, matching the file path's default
}

/** Chromium stores expiry as microseconds since 1601-01-01; 0 means a session cookie. */
export function chromeTimeToUnix(utc: number): number | undefined {
  if (!utc) return undefined;
  const secs = Math.floor(utc / 1_000_000 - 11_644_473_600);
  return secs > 0 ? secs : undefined;
}

/**
 * Pull Facebook cookies from a named browser. `source` is "<browser>" or
 * "<browser>:<profile>" (default profile is "Default").
 */
export function cookiesFromBrowser(source: string): PWCookie[] {
  const [rawName, rawProfile] = source.split(":");
  const name = rawName!.trim().toLowerCase();
  const profile = (rawProfile ?? "Default").trim() || "Default";
  const spec = BROWSERS[name];
  if (!spec) throw new FBError(`Unknown browser "${name}".`);

  const os = platform();
  if (os === "win32") {
    throw new FBError(
      `Reading ${name} cookies on Windows is not supported (App-Bound Encryption). ` +
        `Export cookies with a browser extension and pass --cookies <file>.`,
    );
  }

  let dbSrc: string;
  let key: Buffer;
  if (os === "darwin") {
    const base = join(homedir(), "Library", "Application Support", spec.macDir);
    dbSrc = cookieDbPath(base, profile);
    key = pbkdf2Sync(keychainPassword(spec.macService), "saltysalt", 1003, 16, "sha1");
  } else {
    // Linux (and other Unixes) — basic storage only.
    const base = join(homedir(), ".config", spec.linuxDir);
    dbSrc = cookieDbPath(base, profile);
    key = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  }

  // The live profile keeps the DB locked (WAL); read a throwaway copy instead.
  const tmp = mkdtempSync(join(tmpdir(), "fbcli-ck-"));
  const dbCopy = join(tmp, "Cookies");
  try {
    copyFileSync(dbSrc, dbCopy);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(dbSrc + suffix)) copyFileSync(dbSrc + suffix, dbCopy + suffix);
    }
    const db = new Database(dbCopy, { readonly: true });
    let rows: CookieRow[];
    try {
      rows = db
        .query(
          "SELECT host_key, name, encrypted_value, path, is_secure, " +
            "is_httponly, expires_utc, samesite FROM cookies " +
            "WHERE host_key LIKE '%facebook.com'",
        )
        .all() as unknown as CookieRow[];
    } finally {
      db.close();
    }

    const out: PWCookie[] = [];
    for (const r of rows) {
      let value: string;
      try {
        value = decryptValue(r.encrypted_value, key, r.host_key);
      } catch {
        continue; // one undecryptable cookie shouldn't sink the whole session
      }
      if (!value) continue;
      const ck: PWCookie = {
        name: r.name,
        value,
        domain: r.host_key,
        path: r.path || "/",
        secure: r.is_secure !== 0,
        httpOnly: r.is_httponly !== 0,
        sameSite: sameSiteOf(r.samesite),
      };
      const exp = chromeTimeToUnix(r.expires_utc);
      if (exp !== undefined) ck.expires = exp;
      out.push(ck);
    }
    if (!out.length) {
      throw new FBError(
        `No Facebook cookies found in ${name} (profile "${profile}"). ` +
          `Log in to Facebook in that browser/profile first.`,
      );
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
