#!/usr/bin/env python3
"""
fbcli — drive a normal Facebook account from the terminal using only its cookies.

It injects your exported browser cookies into a headless Chromium (Playwright)
and drives the real Facebook web UI, so it keeps working even though Facebook
retired the no-JavaScript HTML interfaces.

Auth: export your logged-in cookies (a "Cookie-Editor" / "Get cookies.txt"
extension works) to a file and pass --cookies, or set FBCLI_COOKIES.

Examples:
  fbcli whoami
  fbcli feed --limit 15
  fbcli search "climbing gyms nairobi" --kind pages
  fbcli post "Hello from my terminal"
  fbcli post "Hi group" --group 123456789
  fbcli join 123456789
  fbcli comment <post_url> "nice!"
  fbcli react <post_url> --reaction love
  fbcli notifications
  fbcli dm 100000000000000 "hey"
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import __version__
from .browser import Browser, FBError, NotLoggedIn
from . import web_actions as A


def _resolve_cookies(arg):
    src = arg or os.environ.get("FBCLI_COOKIES")
    if not src:
        sys.exit("error: no cookies. Pass --cookies <file|string> or set FBCLI_COOKIES.")
    return src


def _emit(obj, as_json, human):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=2, default=lambda o: o.__dict__))
    else:
        human(obj)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="fbcli", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cookies", help="cookie file (json/netscape) or 'c_user=..; xs=..' string")
    p.add_argument("--headed", action="store_true", help="show the browser window (debug)")
    p.add_argument("--slow", type=float, default=0.0, help="slow_mo ms between UI actions")
    p.add_argument("--json", action="store_true", help="machine-readable JSON output")
    p.add_argument("--verbose", action="store_true", help="log navigation")
    p.add_argument("--version", action="version", version=f"fbcli {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("whoami", help="show the logged-in account")

    sp = sub.add_parser("feed", help="read your news feed"); sp.add_argument("--limit", type=int, default=10)

    sp = sub.add_parser("timeline", help="read a profile timeline")
    sp.add_argument("target", nargs="?", default="me"); sp.add_argument("--limit", type=int, default=10)

    sp = sub.add_parser("search", help="search Facebook")
    sp.add_argument("query")
    sp.add_argument("--kind", default="top", choices=["top", "posts", "people", "pages", "groups"])
    sp.add_argument("--limit", type=int, default=15)

    sp = sub.add_parser("read", help="read a single post + comments"); sp.add_argument("post")

    sp = sub.add_parser("post", help="publish a text status (optionally to a group)")
    sp.add_argument("text"); sp.add_argument("--group", help="group id/URL to post into")

    sp = sub.add_parser("group", help="read a group's feed")
    sp.add_argument("group"); sp.add_argument("--limit", type=int, default=10)

    sp = sub.add_parser("creategroup", help="create a group (private by default)")
    sp.add_argument("name")
    sp.add_argument("--privacy", default="private", choices=["private", "public"])

    sp = sub.add_parser("join", help="join a group"); sp.add_argument("group")
    sp = sub.add_parser("leave", help="leave a group"); sp.add_argument("group")

    sp = sub.add_parser("comment", help="comment on a post")
    sp.add_argument("post"); sp.add_argument("text")

    sp = sub.add_parser("react", help="react to a post")
    sp.add_argument("post")
    sp.add_argument("--reaction", default="like",
                    choices=["like", "love", "care", "haha", "wow", "sad", "angry"])

    sp = sub.add_parser("notifications", help="list recent notifications"); sp.add_argument("--limit", type=int, default=15)

    sp = sub.add_parser("dm", help="send a direct message")
    sp.add_argument("thread"); sp.add_argument("text")
    return p


def run(args) -> int:
    feed_show = lambda ps: print("\n\n".join(p.brief() for p in ps) or "(nothing to show)")
    with Browser(_resolve_cookies(args.cookies), headed=args.headed,
                 slow=args.slow, verbose=args.verbose) as b:
        c = args.cmd
        if c == "whoami":
            me = A.whoami(b)
            _emit(me, args.json, lambda m: print(f"{m['name']}  (uid {m['uid']})\n{m['profile']}"))
        elif c == "feed":
            _emit(A.feed(b, args.limit), args.json, feed_show)
        elif c == "timeline":
            _emit(A.timeline(b, args.target, args.limit), args.json, feed_show)
        elif c == "group":
            _emit(A.group_feed(b, args.group, args.limit), args.json, feed_show)
        elif c == "search":
            res = A.search(b, args.query, args.kind, args.limit)
            _emit(res, args.json, lambda rs: print("\n".join(f"• {r.text}\n  {r.url}" for r in rs) or "(no results)"))
        elif c == "read":
            main, comments = A.read_post(b, args.post)
            if args.json:
                print(json.dumps({"post": main.__dict__, "comments": comments}, ensure_ascii=False, indent=2))
            else:
                print(main.brief(width=4000))
                if comments:
                    print("\n-- comments --")
                    for cm in comments:
                        print(f"  · {cm.splitlines()[0][:120]}")
        elif c == "post":
            post = A.post_status(b, args.text, group=args.group)
            _emit(post, args.json, lambda p: print("posted ✓\n" + p.brief()))
        elif c == "creategroup":
            g = A.create_group(b, args.name, args.privacy)
            _emit(g, args.json, lambda x: print(f"created group '{x['name']}'\n  id:  {x['id']}\n  url: {x['url']}"))
        elif c == "join":
            print(A.join_group(b, args.group))
        elif c == "leave":
            print(A.leave_group(b, args.group))
        elif c == "comment":
            print(A.comment(b, args.post, args.text))
        elif c == "react":
            print(A.react(b, args.post, args.reaction))
        elif c == "notifications":
            _emit(A.notifications(b, args.limit), args.json,
                  lambda ns: print("\n".join(f"• {n.text}\n  {n.url}" for n in ns) or "(none)"))
        elif c == "dm":
            print(A.send_message(b, args.thread, args.text))
        else:
            return 2
    return 0


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except NotLoggedIn as e:
        print(f"auth error: {e}", file=sys.stderr); return 1
    except FBError as e:
        print(f"error: {e}", file=sys.stderr); return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
