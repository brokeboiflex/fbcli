/**
 * fbcli — drive a normal Facebook account from the terminal using only its cookies.
 *
 * It injects your exported browser cookies into a headless Chromium (Playwright)
 * and drives the real Facebook web UI, so it keeps working even though Facebook
 * retired the no-JavaScript HTML interfaces.
 */

import { VERSION } from "./version.ts";
import { Browser, FBError, NotLoggedIn } from "./browser.ts";
import * as A from "./web-actions.ts";
import { ExitSignal, parseArgs, type Option, type ParsedArgs, type ParserSpec } from "./argparse.ts";

const DESCRIPTION = `
fbcli — drive a normal Facebook account from the terminal using only its cookies.

It injects your exported browser cookies into a headless Chromium (Playwright)
and drives the real Facebook web UI, so it keeps working even though Facebook
retired the no-JavaScript HTML interfaces.

Auth: export your logged-in cookies (a "Cookie-Editor" / "Get cookies.txt"
extension works) to a file and pass --cookies, or set FBCLI_COOKIES.

Examples:
  fbcli whoami
  fbcli --cookies brave whoami
  fbcli feed --limit 15
  fbcli search "climbing gyms nairobi" --kind pages
  fbcli --channel chrome post "Hello from my terminal"
  fbcli post "Hi group" --group 123456789 --yes
  fbcli post "friends only" --audience friends
  fbcli join 123456789
  fbcli comment <post_url> "nice!" --dry-run
  fbcli react <post_url> --reaction love
  fbcli notifications
  fbcli dm 100000000000000 "hey" --yes

Cookie source: a file, a 'c_user=..; xs=..' string, or a browser name
(brave, chrome, chromium, edge, arc) to read that browser's own login.
`.trim();

function resolveCookies(arg: unknown): string {
  const src = (typeof arg === "string" && arg) || process.env.FBCLI_COOKIES;
  if (!src) {
    console.error("error: no cookies. Pass --cookies <file|string> or set FBCLI_COOKIES.");
    throw new ExitSignal(1);
  }
  return src;
}

function emit<T>(obj: T, asJson: boolean, human: (value: T) => void): void {
  if (asJson) {
    console.log(JSON.stringify(obj, null, 2));
  } else {
    human(obj);
  }
}

const limitOption = (defaultValue: number): Option => ({
  flags: ["--limit"],
  dest: "limit",
  valueType: "int",
  default: defaultValue,
});

export function buildParser(): ParserSpec {
  return {
    prog: "fbcli",
    description: DESCRIPTION,
    options: [
      {
        flags: ["--cookies"],
        dest: "cookies",
        help: "cookie file (json/netscape), 'c_user=..; xs=..' string, or a browser name (brave/chrome/edge/arc)",
      },
      {
        flags: ["--headed"],
        dest: "headed",
        action: "storeTrue",
        help: "show the browser window (debug)",
      },
      {
        flags: ["--channel"],
        dest: "channel",
        help: "launch a system browser by channel (chrome, msedge, …) instead of a download",
      },
      {
        flags: ["--browser-path"],
        dest: "browserPath",
        help: "launch a specific browser binary",
      },
      {
        flags: ["--dry-run"],
        dest: "dryRun",
        action: "storeTrue",
        help: "for write actions: show what would happen, then exit without doing it",
      },
      {
        flags: ["-y", "--yes"],
        dest: "yes",
        action: "storeTrue",
        help: "skip the confirmation prompt for write actions",
      },
      {
        flags: ["--slow"],
        dest: "slow",
        valueType: "float",
        default: 0.0,
        help: "slowMo ms between UI actions",
      },
      {
        flags: ["--json"],
        dest: "json",
        action: "storeTrue",
        help: "machine-readable JSON output",
      },
      {
        flags: ["--verbose"],
        dest: "verbose",
        action: "storeTrue",
        help: "log navigation",
      },
      {
        flags: ["--version"],
        dest: "version",
        action: "version",
        version: `fbcli ${VERSION}`,
        help: "show program's version number and exit",
      },
    ],
    subcommands: [
      { name: "whoami", help: "show the logged-in account" },
      {
        name: "feed",
        help: "read your news feed",
        options: [limitOption(10)],
      },
      {
        name: "timeline",
        help: "read a profile timeline",
        positionals: [{ dest: "target", optional: true, default: "me" }],
        options: [limitOption(10)],
      },
      {
        name: "search",
        help: "search Facebook",
        positionals: [{ dest: "query" }],
        options: [
          {
            flags: ["--kind"],
            dest: "kind",
            default: "top",
            choices: ["top", "posts", "people", "pages", "groups"],
          },
          limitOption(15),
        ],
      },
      {
        name: "read",
        help: "read a single post + comments",
        positionals: [{ dest: "post" }],
      },
      {
        name: "post",
        help: "publish a text status (optionally to a group)",
        positionals: [{ dest: "text" }],
        options: [
          { flags: ["--group"], dest: "group", help: "group id/URL to post into" },
          {
            flags: ["--audience"],
            dest: "audience",
            choices: ["public", "friends", "only_me"],
            help: "refuse to publish unless the composer audience matches (timeline posts only)",
          },
        ],
      },
      {
        name: "group",
        help: "read a group's feed",
        positionals: [{ dest: "group" }],
        options: [limitOption(10)],
      },
      {
        name: "creategroup",
        help: "create a group (private by default)",
        positionals: [{ dest: "name" }],
        options: [
          {
            flags: ["--privacy"],
            dest: "privacy",
            default: "private",
            choices: ["private", "public"],
          },
        ],
      },
      { name: "join", help: "join a group", positionals: [{ dest: "group" }] },
      { name: "leave", help: "leave a group", positionals: [{ dest: "group" }] },
      {
        name: "comment",
        help: "comment on a post",
        positionals: [{ dest: "post" }, { dest: "text" }],
      },
      {
        name: "react",
        help: "react to a post",
        positionals: [{ dest: "post" }],
        options: [
          {
            flags: ["--reaction"],
            dest: "reaction",
            default: "like",
            choices: ["like", "love", "care", "haha", "wow", "sad", "angry"],
          },
        ],
      },
      {
        name: "notifications",
        help: "list recent notifications",
        options: [limitOption(15)],
      },
      {
        name: "dm",
        help: "send a direct message",
        positionals: [{ dest: "thread" }, { dest: "text" }],
      },
    ],
  };
}

/** Write actions get a dry-run preview and a confirmation gate. */
const MUTATIONS = new Set(["post", "comment", "react", "dm", "creategroup"]);

/** A one-line human description of the write action about to run. */
function describeMutation(args: ParsedArgs): string {
  const s = (k: string): string => String(args[k] ?? "");
  switch (args.cmd) {
    case "post":
      return args.group
        ? `publish a post to group ${s("group")}`
        : `publish a post to your timeline${args.audience ? ` (audience: ${s("audience")})` : ""}`;
    case "comment":
      return `comment on ${s("post")}`;
    case "react":
      return `react '${s("reaction")}' to ${s("post")}`;
    case "dm":
      return `send a direct message to ${s("thread")}`;
    case "creategroup":
      return `create a ${s("privacy")} group '${s("name")}'`;
    default:
      return `run ${args.cmd}`;
  }
}

/** Return true to proceed. On a TTY, prompt; otherwise require --yes. */
function confirmMutation(args: ParsedArgs): boolean {
  if (args.yes === true) return true;
  const desc = describeMutation(args);
  if (!process.stdin.isTTY) {
    console.error(
      `refusing to ${desc} without confirmation — re-run with --yes ` +
        `(or --dry-run to preview). This guard prevents accidental posts.`,
    );
    return false;
  }
  const ans = prompt(`About to ${desc}. Continue? [y/N]`);
  return /^y(es)?$/i.test((ans ?? "").trim());
}

export async function run(args: ParsedArgs): Promise<number> {
  const asJson = args.json === true;
  const str = (key: string): string => String(args[key] ?? "");
  const num = (key: string): number => Number(args[key]);
  const optional = (key: string): string | null =>
    typeof args[key] === "string" && args[key] ? (args[key] as string) : null;

  const feedShow = (ps: A.Post[]): void =>
    console.log(ps.map((p) => p.brief()).join("\n\n") || "(nothing to show)");

  // Gate write actions before we even launch a browser.
  if (MUTATIONS.has(args.cmd)) {
    if (args.dryRun === true) {
      console.log(`[dry-run] would ${describeMutation(args)} — nothing sent.`);
      return 0;
    }
    if (!confirmMutation(args)) {
      console.error("aborted.");
      return 1;
    }
  }

  const b = await Browser.start(resolveCookies(args.cookies), {
    headed: args.headed === true,
    slow: num("slow"),
    verbose: args.verbose === true,
    channel: optional("channel") ?? undefined,
    executablePath: optional("browserPath") ?? undefined,
  });
  try {
    switch (args.cmd) {
      case "whoami": {
        const me = await A.whoami(b);
        emit(me, asJson, (m) => console.log(`${m.name}  (uid ${m.uid})\n${m.profile}`));
        break;
      }
      case "feed":
        emit(await A.feed(b, num("limit")), asJson, feedShow);
        break;
      case "timeline":
        emit(await A.timeline(b, str("target"), num("limit")), asJson, feedShow);
        break;
      case "group":
        emit(await A.groupFeed(b, str("group"), num("limit")), asJson, feedShow);
        break;
      case "search": {
        const res = await A.search(b, str("query"), str("kind"), num("limit"));
        emit(res, asJson, (rs) =>
          console.log(rs.map((r) => `• ${r.text}\n  ${r.url}`).join("\n") || "(no results)"),
        );
        break;
      }
      case "read": {
        const [mainPost, comments] = await A.readPost(b, str("post"));
        if (asJson) {
          console.log(JSON.stringify({ post: mainPost, comments }, null, 2));
        } else {
          console.log(mainPost.brief(4000));
          if (comments.length) {
            console.log("\n-- comments --");
            for (const cm of comments) {
              console.log(`  · ${A.cut(cm.split("\n")[0] ?? "", 120)}`);
            }
          }
        }
        break;
      }
      case "post": {
        const post = await A.postStatus(b, str("text"), optional("group"), optional("audience"));
        emit(post, asJson, (p) => console.log("posted ✓\n" + p.brief()));
        break;
      }
      case "creategroup": {
        const g = await A.createGroup(b, str("name"), str("privacy"));
        emit(g, asJson, (x) =>
          console.log(`created group '${x.name}'\n  id:  ${x.id}\n  url: ${x.url}`),
        );
        break;
      }
      case "join":
        console.log(await A.joinGroup(b, str("group")));
        break;
      case "leave":
        console.log(await A.leaveGroup(b, str("group")));
        break;
      case "comment":
        console.log(await A.comment(b, str("post"), str("text")));
        break;
      case "react":
        console.log(await A.react(b, str("post"), str("reaction")));
        break;
      case "notifications":
        emit(await A.notifications(b, num("limit")), asJson, (ns) =>
          console.log(ns.map((n) => `• ${n.text}\n  ${n.url}`).join("\n") || "(none)"),
        );
        break;
      case "dm":
        console.log(await A.sendMessage(b, str("thread"), str("text")));
        break;
      default:
        return 2;
    }
  } finally {
    await b.close();
  }
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(buildParser(), argv);
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    throw err;
  }
  try {
    return await run(args);
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    if (err instanceof NotLoggedIn) {
      console.error(`auth error: ${err.message}`);
      return 1;
    }
    if (err instanceof FBError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

if (import.meta.main) {
  process.on("SIGINT", () => process.exit(130));
  process.exitCode = await main();
}
