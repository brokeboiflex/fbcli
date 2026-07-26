"""
Facebook actions driven through the real web UI (Playwright).

Selectors favour stable, semantic hooks — ARIA roles (article/dialog/textbox/
button) and accessible names — over Facebook's obfuscated class soup, and every
interaction has generous waits because the UI hydrates asynchronously.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional
from urllib.parse import quote_plus

from .browser import Browser, FBError


@dataclass
class Post:
    author: str = ""
    text: str = ""
    permalink: str = ""

    def brief(self, width: int = 300) -> str:
        body = self.text if len(self.text) <= width else self.text[:width] + "…"
        out = [f"● {self.author or '(post)'}"]
        if body:
            out.append("  " + body.replace("\n", "\n  "))
        if self.permalink:
            out.append(f"  → {self.permalink}")
        return "\n".join(out)


@dataclass
class Item:
    text: str = ""
    url: str = ""


def _group_url(group: str) -> str:
    if group.startswith("http"):
        return group
    g = group.strip("/")
    return f"/groups/{g.split('groups/')[-1]}"


# -- identity ----------------------------------------------------------------
def whoami(b: Browser) -> dict:
    b.goto("/")
    b.settle(2500)
    # The account name is embedded in the page's Relay bootstrap data; this is
    # far more stable than the DOM, where the profile name isn't a plain heading.
    m = re.search(r'"NAME":"([^"]{2,40})"', b.page.content())
    name = m.group(1).encode().decode("unicode_escape") if m else "(unknown)"
    return {"uid": b.uid, "name": name,
            "profile": f"https://www.facebook.com/profile.php?id={b.uid}"}


# -- reading -----------------------------------------------------------------
def _collect_articles(b: Browser, limit: int, scrolls: int = 6) -> List[Post]:
    posts: List[Post] = []
    seen = set()
    for _ in range(scrolls):
        arts = b.page.locator('div[role="article"]')
        n = arts.count()
        for i in range(n):
            a = arts.nth(i)
            try:
                txt = a.inner_text(timeout=1500).strip()
            except Exception:
                continue
            if not txt or len(txt) < 3:
                continue
            perma = ""
            links = a.locator(
                'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], '
                'a[href*="/videos/"], a[href*="/groups/"][href*="/posts/"]'
            )
            if links.count():
                perma = links.first.get_attribute("href") or ""
            key = perma or txt[:80]
            if key in seen:
                continue
            seen.add(key)
            author = txt.split("\n", 1)[0][:80]
            posts.append(Post(author=author, text=txt, permalink=perma))
            if len(posts) >= limit:
                return posts
        b.page.mouse.wheel(0, 3000)
        b.page.wait_for_timeout(1200)
    return posts


def feed(b: Browser, limit: int = 10) -> List[Post]:
    b.goto("/")
    b.settle(3500)
    return _collect_articles(b, limit)


def timeline(b: Browser, target: str = "me", limit: int = 10) -> List[Post]:
    if target in ("me", "self"):
        path = "/me"
    elif target.isdigit():
        path = f"/profile.php?id={target}"
    else:
        path = f"/{target.lstrip('/')}"
    b.goto(path)
    b.settle(3500)
    return _collect_articles(b, limit)


def group_feed(b: Browser, group: str, limit: int = 10) -> List[Post]:
    b.goto(_group_url(group))
    b.settle(3500)
    return _collect_articles(b, limit)


def read_post(b: Browser, url: str):
    b.goto(url)
    b.settle(3500)
    b.page.wait_for_timeout(1500)
    # The post body renders in a dir="auto" block (the article inner_text is
    # often empty). Take the longest such block inside the post dialog/main.
    scope = b.page.locator('[role="dialog"]').last
    if not scope.count():
        scope = b.page.locator('[role="main"]').first
    text = ""
    blocks = scope.locator('div[dir="auto"]')
    for i in range(min(blocks.count(), 40)):
        try:
            t = blocks.nth(i).inner_text(timeout=800).strip()
        except Exception:
            continue
        if len(t) > len(text):
            text = t
    # Author = the post's heading link (e.g. "Jane Doe's post" → the name).
    author = ""
    try:
        author = scope.get_by_role("link").first.inner_text(timeout=1500).strip().split("\n")[0]
    except Exception:
        pass
    comments: List[str] = []
    cnodes = b.page.locator('div[aria-label*="Comment by"], div[role="article"]')
    for i in range(min(cnodes.count(), 30)):
        try:
            t = cnodes.nth(i).inner_text(timeout=800).strip()
        except Exception:
            continue
        if t and t != text and t not in comments and len(t) > 3:
            comments.append(t)
    return Post(author=author, text=text, permalink=b.page.url), comments[:25]


def search(b: Browser, query: str, kind: str = "top", limit: int = 15) -> List[Item]:
    kinds = {"top": "top", "posts": "posts", "people": "people",
             "pages": "pages", "groups": "groups"}
    seg = kinds.get(kind, "top")
    b.goto(f"/search/{seg}/?q={quote_plus(query)}")
    b.settle(4000)
    for _ in range(3):
        b.page.mouse.wheel(0, 2500)
        b.page.wait_for_timeout(1000)
    # Result names aren't in the anchor text — they're in the avatar link's
    # aria-label ("Profile photo of <Name>"). Harvest per unique href.
    best: dict = {}
    links = b.page.locator('[role="main"] a[role="link"][href]')
    for i in range(min(links.count(), 250)):
        a = links.nth(i)
        try:
            href = a.get_attribute("href") or ""
            aria = a.get_attribute("aria-label") or ""
            txt = (a.inner_text(timeout=250) or "").strip().split("\n")[0]
        except Exception:
            continue
        if not href or href.startswith("#"):
            continue
        if any(k in href for k in ("/search/", "/hashtag/", "/photo", "/reactions/")):
            continue
        key = href.split("?")[0]
        if "profile.php" in href:
            mid = re.search(r"[?&]id=(\d+)", href)
            if mid:
                key = key + "?id=" + mid.group(1)  # keep the numeric id
        if not key.startswith(("http", "/")):
            continue
        name = txt
        if not name and aria:
            name = re.sub(r"^(Profile (photo|picture) of |)", "", aria).strip()
            name = re.sub(r"'s (profile|timeline).*$", "", name).strip()
        if len(name) > len(best.get(key, "")):
            best[key] = name
    results: List[Item] = []
    for key, name in best.items():
        if not name:
            slug = key.rstrip("/").split("/")[-1]
            name = slug.replace(".", " ").replace("-", " ") if "profile.php" not in slug else "(profile)"
        url = key if key.startswith("http") else "https://www.facebook.com" + key
        results.append(Item(text=name[:80], url=url))
        if len(results) >= limit:
            break
    return results


def notifications(b: Browser, limit: int = 15) -> List[Item]:
    b.goto("/notifications")
    b.settle(4000)
    b.page.wait_for_timeout(2000)
    out: List[Item] = []
    seen = set()
    # Notifications render as role="listitem" rows (there is no role="main" here).
    rows = b.page.locator('[role="listitem"]')
    for i in range(min(rows.count(), 60)):
        row = rows.nth(i)
        try:
            t = row.inner_text(timeout=800).strip()
        except Exception:
            continue
        if not t or len(t) < 8:
            continue
        href = ""
        links = row.locator("a[href]")
        if links.count():
            href = links.first.get_attribute("href") or ""
        key = t[:60]
        if key in seen:
            continue
        seen.add(key)
        out.append(Item(text=" ".join(t.split())[:200],
                        url=(href if href.startswith("http") else
                             ("https://www.facebook.com" + href) if href else "")))
        if len(out) >= limit:
            break
    return out


# -- writing -----------------------------------------------------------------
# Composer opener text differs by surface: timeline says "What's on your mind",
# group pages say "Write something" / "Start a discussion" / "Discuss something".
_OPENER = re.compile(r"What'?s on your mind|Write something|"
                     r"Start a discussion|Discuss something|Say something", re.I)


def _compose_and_publish(b: Browser, text: str):
    """Open the 'Create post' dialog, type text, and click Post."""
    # Pick the first *visible* opener (group pages have hidden/overlaid matches),
    # scroll it clear of sticky panels, then force-click through any overlay.
    openers = b.page.get_by_text(_OPENER)
    opener = openers.first
    for i in range(min(openers.count(), 8)):
        el = openers.nth(i)
        try:
            if el.is_visible():
                opener = el
                break
        except Exception:
            continue
    try:
        opener.scroll_into_view_if_needed(timeout=5000)
    except Exception:
        pass
    b.page.wait_for_timeout(400)
    # Open the "Create post" modal; retry until a dialog with a live editor mounts.
    # Both the timeline and group composers open the same modal — a plain inline
    # textbox exists behind it, so everything below is scoped to the dialog to
    # avoid typing into the wrong (background) editor.
    def _find_composer():
        # Among the (possibly several) open dialogs, return the one whose editor
        # is actually visible — that's the Create-post modal, not a stray dialog.
        dialogs = b.page.locator('[role="dialog"]')
        for i in range(dialogs.count()):
            d = dialogs.nth(i)
            ed = d.locator('div[role="textbox"], div[contenteditable="true"]').first
            try:
                if ed.count() and ed.is_visible():
                    return d, ed
            except Exception:
                continue
        return None, None

    dialog = box = None
    for _ in range(3):
        try:
            opener.click(timeout=6000)
        except Exception:
            try:
                opener.click(force=True, timeout=4000)
            except Exception:
                pass
        b.page.wait_for_timeout(1800)
        dialog, box = _find_composer()
        if box is not None:
            break
    if box is None:
        raise FBError("Could not open the post composer (layout changed?).")
    try:
        box.click(timeout=4000)
    except Exception:
        box.evaluate("el => el.focus()")
    b.page.keyboard.type(text, delay=15)
    b.page.wait_for_timeout(1000)
    # The Post button (inside the dialog) enables once the editor has content.
    btn = dialog.get_by_role("button", name=re.compile(r"^Post$", re.I)).last
    btn.wait_for(state="visible", timeout=8000)
    for _ in range(15):
        if btn.is_enabled():
            break
        b.page.wait_for_timeout(400)
    try:
        btn.click(timeout=6000)
    except Exception:
        btn.evaluate("el => el.click()")
    # Publication closes the dialog; wait for the editor to detach.
    try:
        box.wait_for(state="detached", timeout=15000)
    except Exception:
        b.page.wait_for_timeout(4000)


def _permalink_from_graphql(bodies: List[str], uid: str,
                            group_id: Optional[str] = None) -> str:
    """Parse a fresh post's permalink/id out of captured GraphQL responses.

    Group posts live at /groups/<gid>/posts/<id>; timeline posts at /<uid>/posts/<id>.
    """
    base = f"https://www.facebook.com/groups/{group_id}" if group_id \
        else f"https://www.facebook.com/{uid}"
    for body in bodies:
        u = body.replace("\\/", "/")
        pf = re.search(r"(pfbid[A-Za-z0-9]+)", u)   # canonical share token
        if pf:
            return f"{base}/posts/{pf.group(1)}"
        sf = re.search(r'"story_fbid":"?(\d+)"?', u)
        if sf:
            return f"{base}/posts/{sf.group(1)}"
        pid = re.search(r'"post_id":"(\d+)"', u)
        if pid:
            return f"{base}/posts/{pid.group(1)}"
    return ""


def post_status(b: Browser, text: str, group: Optional[str] = None) -> Post:
    if group:
        b.goto(_group_url(group))
    else:
        b.goto("/")
    b.settle(3500)

    # Capture the create-post mutation response, which carries the new post id.
    bodies: List[str] = []

    def _on_resp(resp):
        try:
            fn = resp.request.headers.get("x-fb-friendly-name", "")
            if "/api/graphql" in resp.url and (
                "Composer" in fn or "StoryCreate" in fn or "Feed" in fn or not fn
            ):
                bodies.append(resp.text())
        except Exception:
            pass

    b.page.on("response", _on_resp)
    _compose_and_publish(b, text)
    b.page.wait_for_timeout(3500)
    b.page.remove_listener("response", _on_resp)

    gid = None
    if group:
        gid = _group_url(group).rstrip("/").split("/")[-1]
    permalink = _permalink_from_graphql(bodies, b.uid, group_id=gid)
    if not permalink:
        # Fallback: point at the group / profile where the post now lives.
        permalink = (f"https://www.facebook.com/groups/{gid}" if gid
                     else f"https://www.facebook.com/profile.php?id={b.uid}")
    return Post(author="you", text=text, permalink=permalink)


def comment(b: Browser, url: str, text: str) -> str:
    b.goto(url)
    b.settle(3500)
    box = b.page.locator(
        'div[aria-label^="Comment"], div[aria-label*="Write a comment"], '
        'form div[role="textbox"], div[contenteditable="true"]'
    ).first
    box.wait_for(state="visible", timeout=10000)
    box.click()
    box.type(text, delay=15)
    b.page.wait_for_timeout(600)
    box.press("Enter")
    b.page.wait_for_timeout(2500)
    return "commented"


def react(b: Browser, url: str, reaction: str = "like") -> str:
    b.goto(url)
    b.settle(3500)
    like = b.page.get_by_role("button", name=re.compile(r"^Like$", re.I)).first
    like.wait_for(state="visible", timeout=10000)
    if reaction.lower() in ("like", ""):
        like.click()
        b.page.wait_for_timeout(1500)
        return "reacted: like"
    # Hover to reveal the reaction picker, then click the named reaction.
    like.hover()
    b.page.wait_for_timeout(1200)
    r = b.page.get_by_role("button", name=re.compile(rf"^{reaction}$", re.I)).first
    try:
        r.click(timeout=4000)
        b.page.wait_for_timeout(1500)
        return f"reacted: {reaction}"
    except Exception:
        like.click()
        return "reacted: like (fallback)"


def create_group(b: Browser, name: str, privacy: str = "private") -> dict:
    """Create a group and return {name, id, url}. Handy for a self-contained
    place to test group posting without touching a public community."""
    b.goto("/groups/create")
    b.settle(4000)
    b.page.wait_for_timeout(1500)
    # The Group-name field auto-focuses on load — type into the focused element
    # (locator('input').first would wrongly grab the nav search box).
    b.page.keyboard.type(name, delay=25)
    b.page.wait_for_timeout(600)
    # Privacy combobox (force-click through FB's overlay), then pick the option.
    cbs = b.page.get_by_role("combobox")
    target = cbs.first
    for i in range(cbs.count()):
        if "privacy" in (cbs.nth(i).inner_text() or "").lower():
            target = cbs.nth(i)
            break
    target.click(force=True, timeout=6000)
    b.page.wait_for_timeout(1200)
    b.page.get_by_role("option", name=re.compile(privacy, re.I)).first.click(timeout=6000)
    b.page.wait_for_timeout(1000)
    btn = b.page.get_by_role("button", name=re.compile(r"^Create", re.I)).first
    for _ in range(15):
        if btn.is_enabled():
            break
        b.page.wait_for_timeout(400)
    btn.click(force=True, timeout=8000)
    try:
        b.page.wait_for_url(re.compile(r"/groups/\d+"), timeout=25000)
    except Exception:
        b.page.wait_for_timeout(6000)
    m = re.search(r"/groups/(\d+)", b.page.url)
    gid = m.group(1) if m else ""
    return {"name": name, "id": gid,
            "url": f"https://www.facebook.com/groups/{gid}" if gid else b.page.url}


def join_group(b: Browser, group: str) -> str:
    b.goto(_group_url(group))
    b.settle(3500)
    btn = b.page.get_by_role("button", name=re.compile(r"^(Join group|Join)$", re.I)).first
    try:
        btn.click(timeout=8000)
        b.page.wait_for_timeout(2500)
        return "join clicked (request sent or joined)"
    except Exception:
        if b.page.get_by_role("button", name=re.compile(r"Joined|Leave group", re.I)).count():
            return "already a member"
        raise FBError("No Join button found (group may be secret/invite-only).")


def leave_group(b: Browser, group: str) -> str:
    b.goto(_group_url(group))
    b.settle(3500)
    joined = b.page.get_by_role("button", name=re.compile(r"Joined|Leave group", re.I)).first
    joined.click(timeout=8000)
    b.page.wait_for_timeout(1200)
    confirm = b.page.get_by_role("menuitem", name=re.compile(r"Leave group", re.I)).first
    try:
        confirm.click(timeout=4000)
    except Exception:
        pass
    b.page.get_by_role("button", name=re.compile(r"^Leave", re.I)).first.click(timeout=6000)
    b.page.wait_for_timeout(2000)
    return "left group"


def send_message(b: Browser, thread: str, text: str) -> str:
    dest = thread if thread.isdigit() else thread.lstrip("/")
    b.goto(f"/messages/t/{dest}")
    b.settle(4000)
    box = b.page.get_by_role("textbox", name=re.compile(r"Message|Aa", re.I)).first
    box.wait_for(state="visible", timeout=12000)
    box.click()
    box.type(text, delay=15)
    b.page.wait_for_timeout(500)
    box.press("Enter")
    b.page.wait_for_timeout(2000)
    return "sent"
