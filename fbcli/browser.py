"""
Browser engine for fbcli — drives the real Facebook web UI via Playwright with
your account cookies injected. This replaces the retired mbasic HTML scraper:
because it runs Facebook's actual JavaScript, it is immune to the GraphQL
`doc_id` churn that breaks request-only tools.

Cookie input is the same set of formats FBSession accepted, but here we prefer
the rich browser-extension export (name/value/domain/path/expiry/sameSite),
which maps directly onto Playwright's add_cookies().
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Dict, List, Optional

from playwright.sync_api import sync_playwright, Page, TimeoutError as PWTimeout

FB = "https://www.facebook.com"
ESSENTIAL = ("c_user", "xs")
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class FBError(RuntimeError):
    pass


class NotLoggedIn(FBError):
    pass


def _samesite(v) -> str:
    m = {"no_restriction": "None", "lax": "Lax", "strict": "Strict",
         "none": "None", "unspecified": "Lax"}
    if v is None:
        return "Lax"
    return m.get(str(v).lower(), "Lax")


def load_cookies(source: str) -> List[dict]:
    """Return a Playwright-ready cookie list from a file or inline string."""
    p = Path(source)
    raw: List[dict] = []
    if p.exists():
        text = p.read_text(encoding="utf-8", errors="replace").strip()
        if text.startswith("# Netscape") or text.startswith("# HTTP Cookie") or (
            "\t" in text and "facebook" in text.lower()
        ):
            jar = MozillaCookieJar()
            jar.load(str(p), ignore_discard=True, ignore_expires=True)
            raw = [{"name": c.name, "value": c.value,
                    "domain": c.domain or ".facebook.com", "path": c.path or "/"}
                   for c in jar if "facebook" in (c.domain or "")]
        else:
            data = json.loads(text)
            if isinstance(data, dict):
                raw = [{"name": k, "value": v} for k, v in data.items()]
            else:
                raw = data
    else:
        for part in source.replace("\n", ";").split(";"):
            part = part.strip()
            if "=" in part:
                n, _, v = part.partition("=")
                raw.append({"name": n.strip(), "value": v.strip()})

    out: List[dict] = []
    for c in raw:
        if "name" not in c or "value" not in c:
            continue
        ck = {
            "name": c["name"],
            "value": c["value"],
            "domain": c.get("domain", ".facebook.com"),
            "path": c.get("path", "/"),
            "secure": bool(c.get("secure", True)),
            "httpOnly": bool(c.get("httpOnly", False)),
            "sameSite": _samesite(c.get("sameSite")),
        }
        exp = c.get("expirationDate") or c.get("expires")
        if exp and float(exp) > 0:
            ck["expires"] = float(exp)
        out.append(ck)
    names = {c["name"] for c in out}
    missing = [c for c in ESSENTIAL if c not in names]
    if missing:
        raise NotLoggedIn(f"Missing essential cookie(s): {', '.join(missing)}.")
    return out


class Browser:
    """Context-managed Playwright browser with FB cookies pre-loaded."""

    def __init__(self, source: str, headed: bool = False, ua: str = DEFAULT_UA,
                 slow: float = 0.0, verbose: bool = False, timeout: int = 30000):
        self.cookies = load_cookies(source)
        self.uid = next(c["value"] for c in self.cookies if c["name"] == "c_user")
        self.headed = headed
        self.ua = ua
        self.slow = slow
        self.verbose = verbose
        self.timeout = timeout
        self._pw = None
        self._browser = None
        self.ctx = None
        self.page: Optional[Page] = None

    def __enter__(self) -> "Browser":
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(
            headless=not self.headed,
            args=["--no-sandbox", "--disable-dev-shm-usage",
                  "--disable-blink-features=AutomationControlled"],
            slow_mo=self.slow,
        )
        self.ctx = self._browser.new_context(
            user_agent=self.ua, viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        self.ctx.set_default_timeout(self.timeout)
        self.ctx.add_cookies(self.cookies)
        self.page = self.ctx.new_page()
        return self

    def __exit__(self, *exc):
        try:
            if self.ctx:
                self.ctx.close()
            if self._browser:
                self._browser.close()
        finally:
            if self._pw:
                self._pw.stop()

    # -- navigation ----------------------------------------------------------
    def goto(self, path: str, wait: str = "domcontentloaded"):
        url = path if path.startswith("http") else FB + (path if path.startswith("/") else "/" + path)
        if self.verbose:
            print(f"[nav] {url}")
        self.page.goto(url, wait_until=wait)
        self._guard_login()

    def _guard_login(self):
        u = self.page.url.lower()
        if "/login" in u or "/checkpoint" in u or "login.php" in u:
            raise NotLoggedIn(
                "Facebook redirected to login/checkpoint — cookies expired or a "
                "security check is required. Re-export fresh cookies."
            )

    def settle(self, ms: int = 1500):
        try:
            self.page.wait_for_load_state("networkidle", timeout=ms)
        except PWTimeout:
            pass
