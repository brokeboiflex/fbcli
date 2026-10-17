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
  fbcli group 123456789 --sort activity
  fbcli --channel chrome post "Hello from my terminal"
  fbcli post "Hi group" --group 123456789 --yes
  fbcli post "friends only" --audience friends
  fbcli join 123456789
  fbcli comment <post_url> "nice!" --dry-run
  fbcli react <post_url> --reaction love
  fbcli notifications
  fbcli dm 100000000000000 "hey" --yes
  fbcli schema                      # the whole command surface, as JSON

Cookie source: a file, a 'c_user=..; xs=..' string, or a browser name
(brave, chrome, chromium, edge, arc) to read that browser's own login.
`.trim();

/** The failure classes a caller can branch on, reported by `--json`. */
type ErrorKind = "cookies" | "confirmation_required" | "auth" | "facebook";

/**
 * Report a failure. With `--json` it lands on stderr as
 * `{"ok":false,"error":{"kind","message"}}` so an agent can branch on `kind`
 * instead of pattern-matching English.
 */
function reportError(kind: ErrorKind, message: string, asJson: boolean): void {
  if (asJson) {
    console.error(JSON.stringify({ ok: false, error: { kind, message } }));
  } else {
    console.error(message);
  }
}

function resolveCookies(arg: unknown, asJson: boolean): string {
  const src = (typeof arg === "string" && arg) || process.env.FBCLI_COOKIES;
  if (!src) {
    reportError(
      "cookies",
      "error: no cookies. Pass --cookies <file|string> or set FBCLI_COOKIES.",
      asJson,
    );
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
  help: "how many items to return",
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
        options: [
          limitOption(10),
          {
            flags: ["--sort"],
            dest: "sort",
            default: "new",
            choices: ["new", "activity"],
            help: "newest posts first (default), or Facebook's recent-activity order",
          },
        ],
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
      { name: "schema", help: "print the whole command surface as JSON (for agents)" },
    ],
  };
}

/** The JSON shape each command prints under `--json`, reported by `schema`. */
const OUTPUT_SHAPES: Record<string, string> = {
  whoami: "WhoAmI",
  feed: "Post[]",
  timeline: "Post[]",
  group: "Post[]",
  search: "Item[]",
  read: "PostWithComments",
  notifications: "Item[]",
  post: "Post",
  creategroup: "CreatedGroup",
  join: "ActionResult",
  leave: "ActionResult",
  comment: "ActionResult",
  react: "ActionResult",
  dm: "ActionResult",
  schema: "Schema",
};

/** Field-by-field description of every shape above. */
const SHAPES: Record<string, Record<string, string>> = {
  WhoAmI: { uid: "string", name: "string", profile: "string (url)" },
  Post: { author: "string", text: "string", permalink: "string (url, may be empty)" },
  Item: { text: "string", url: "string (url)" },
  PostWithComments: { post: "Post", comments: "string[]" },
  CreatedGroup: { name: "string", id: "string", url: "string (url)" },
  ActionResult: { ok: "true", action: "string (the command)", result: "string (what happened)" },
  DryRun: {
    dryRun: "true",
    action: "string (the command)",
    description: "string (what it would do)",
    sent: "false",
  },
  Schema: {
    prog: "string",
    version: "string",
    exitCodes: "object (code -> meaning)",
    errorShape: "object (the --json error envelope)",
    env: "object (env var -> meaning)",
    globals: "Option[]",
    commands: "Command[]",
    shapes: "object (shape name -> fields)",
  },
};

function optionSchema(o: Option): Record<string, unknown> {
  const storeTrue = o.action === "storeTrue";
  return {
    flags: o.flags,
    dest: o.dest,
    type: storeTrue ? "boolean" : (o.valueType ?? "string"),
    default: storeTrue ? false : (o.default ?? null),
    choices: o.choices ?? null,
    help: o.help ?? null,
  };
}

/**
 * The command surface as data, so an agent can discover every command, flag,
 * default and output shape without parsing `--help` prose.
 */
export function schema(): Record<string, unknown> {
  const spec = buildParser();
  return {
    prog: spec.prog,
    version: VERSION,
    exitCodes: {
      "0": "success",
      "1": "runtime error — see the error envelope on stderr",
      "2": "usage error (argparse-style message on stderr, never JSON)",
      "130": "interrupted (SIGINT)",
    },
    errorShape: { ok: false, error: { kind: "cookies|confirmation_required|auth|facebook", message: "string" } },
    /** What a `mutates` command prints instead of its own shape under `--dry-run`. */
    dryRunOutput: "DryRun",
    env: {
      FBCLI_COOKIES: "default --cookies value: a file, a 'c_user=..; xs=..' string, or a browser name",
      FBCLI_BROWSER: "default --browser-path value",
      FBCLI_BROWSER_CHANNEL: "default --channel value",
      FBCLI_SELECTORS: "JSON file overriding entries of the selector registry",
    },
    globals: spec.options.map(optionSchema),
    commands: spec.subcommands.map((sub) => ({
      name: sub.name,
      help: sub.help,
      mutates: MUTATIONS.has(sub.name),
      needsConfirmation: MUTATIONS.has(sub.name)
        ? "pass --yes to run non-interactively, or --dry-run to preview"
        : null,
      positionals: (sub.positionals ?? []).map((p) => ({
        dest: p.dest,
        required: p.optional !== true,
        default: p.default ?? null,
      })),
      options: (sub.options ?? []).map(optionSchema),
      output: OUTPUT_SHAPES[sub.name] ?? null,
    })),
    shapes: SHAPES,
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
function confirmMutation(args: ParsedArgs, asJson: boolean): boolean {
  if (args.yes === true) return true;
  const desc = describeMutation(args);
  if (!process.stdin.isTTY) {
    reportError(
      "confirmation_required",
      `refusing to ${desc} without confirmation — re-run with --yes ` +
        `(or --dry-run to preview). This guard prevents accidental posts.`,
      asJson,
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

  // Actions whose only outcome is "it happened": prose for humans, an
  // ActionResult for `--json`.
  const action = (cmd: string, result: string): void =>
    emit({ ok: true, action: cmd, result }, asJson, (r) => console.log(r.result));

  // `schema` is pure introspection: no cookies, no browser, always JSON.
  if (args.cmd === "schema") {
    console.log(JSON.stringify(schema(), null, 2));
    return 0;
  }

  // Gate write actions before we even launch a browser.
  if (MUTATIONS.has(args.cmd)) {
    if (args.dryRun === true) {
      const description = describeMutation(args);
      emit({ dryRun: true, action: args.cmd, description, sent: false }, asJson, (d) =>
        console.log(`[dry-run] would ${d.description} — nothing sent.`),
      );
      return 0;
    }
    if (!confirmMutation(args, asJson)) {
      if (!asJson) console.error("aborted.");
      return 1;
    }
  }

  const b = await Browser.start(resolveCookies(args.cookies, asJson), {
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
        emit(
          await A.groupFeed(b, str("group"), num("limit"), str("sort") as A.GroupSort),
          asJson,
          feedShow,
        );
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
        action("join", await A.joinGroup(b, str("group")));
        break;
      case "leave":
        action("leave", await A.leaveGroup(b, str("group")));
        break;
      case "comment":
        action("comment", await A.comment(b, str("post"), str("text")));
        break;
      case "react":
        action("react", await A.react(b, str("post"), str("reaction")));
        break;
      case "notifications":
        emit(await A.notifications(b, num("limit")), asJson, (ns) =>
          console.log(ns.map((n) => `• ${n.text}\n  ${n.url}`).join("\n") || "(none)"),
        );
        break;
      case "dm":
        action("dm", await A.sendMessage(b, str("thread"), str("text")));
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
  const asJson = args.json === true;
  try {
    return await run(args);
  } catch (err) {
    if (err instanceof ExitSignal) return err.code;
    if (err instanceof NotLoggedIn) {
      reportError("auth", `auth error: ${err.message}`, asJson);
      return 1;
    }
    if (err instanceof FBError) {
      reportError("facebook", `error: ${err.message}`, asJson);
      return 1;
    }
    throw err;
  }
}

if (import.meta.main) {
  process.on("SIGINT", () => process.exit(130));
  process.exitCode = await main();
}
