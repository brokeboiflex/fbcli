import { describe, expect, test } from "bun:test";

import { ExitSignal, parseArgs } from "../src/argparse.ts";
import { buildParser } from "../src/cli.ts";

const spec = buildParser();
const parse = (line: string) => parseArgs(spec, line.split(" ").filter(Boolean));

describe("the command surface", () => {
  test("every subcommand from the Python argparse tree is present", () => {
    expect(spec.subcommands.map((s) => s.name)).toEqual([
      "whoami", "feed", "timeline", "search", "read", "post", "group",
      "creategroup", "join", "leave", "comment", "react", "notifications", "dm",
    ]);
  });

  test("global flags default the way the Python parser did", () => {
    expect(parse("whoami")).toEqual({
      cookies: null,
      headed: false,
      channel: null,
      browserPath: null,
      dryRun: false,
      yes: false,
      slow: 0.0,
      json: false,
      verbose: false,
      cmd: "whoami",
    });
  });

  test("global flags are collected before and after the subcommand", () => {
    const args = parse("--headed --slow 250 --json --verbose --cookies ./c.json feed --limit 20");
    expect(args).toMatchObject({
      headed: true, slow: 250, json: true, verbose: true,
      cookies: "./c.json", cmd: "feed", limit: 20,
    });
    expect(parse("feed --json --limit 3")).toMatchObject({ json: true, limit: 3 });
  });

  test("--flag=value is accepted", () => {
    expect(parse("search gyms --kind=groups --limit=7")).toMatchObject({
      kind: "groups", limit: 7, query: "gyms",
    });
  });

  test.each([
    ["feed", { limit: 10 }],
    ["timeline", { target: "me", limit: 10 }],
    ["search q", { query: "q", kind: "top", limit: 15 }],
    ["read u", { post: "u" }],
    ["post hello", { text: "hello", group: null }],
    ["group 123", { group: "123", limit: 10, sort: "new" }],
    ["creategroup sandbox", { name: "sandbox", privacy: "private" }],
    ["join 123", { group: "123" }],
    ["leave 123", { group: "123" }],
    ["comment u nice", { post: "u", text: "nice" }],
    ["react u", { post: "u", reaction: "like" }],
    ["notifications", { limit: 15 }],
    ["dm 100 hey", { thread: "100", text: "hey" }],
  ])("`%s` parses with the documented defaults", (line, expected) => {
    expect(parse(line)).toMatchObject(expected as Record<string, unknown>);
  });

  test("timeline's optional positional can be overridden", () => {
    expect(parse("timeline zuck --limit 5")).toMatchObject({ target: "zuck", limit: 5 });
  });

  test("choices are enforced for --kind, --reaction and --privacy", () => {
    for (const kind of ["top", "posts", "people", "pages", "groups"]) {
      expect(parse(`search q --kind ${kind}`)).toMatchObject({ kind });
    }
    for (const r of ["like", "love", "care", "haha", "wow", "sad", "angry"]) {
      expect(parse(`react u --reaction ${r}`)).toMatchObject({ reaction: r });
    }
    for (const p of ["private", "public"]) {
      expect(parse(`creategroup g --privacy ${p}`)).toMatchObject({ privacy: p });
    }
    for (const sort of ["new", "activity"]) {
      expect(parse(`group 123 --sort ${sort}`)).toMatchObject({ sort });
    }
  });

  test("`--` stops flag parsing so text can start with a dash", () => {
    expect(parse("post -- --not-a-flag")).toMatchObject({ text: "--not-a-flag" });
  });

  test("usage errors exit 2, like argparse", () => {
    for (const line of [
      "", "bogus", "search", "comment a", "whoami extra",
      "feed --limit abc", "search q --kind nope", "feed --nope", "feed --limit",
      "group 123 --sort oldest",
    ]) {
      let code: number | null = null;
      try {
        parse(line);
      } catch (err) {
        code = err instanceof ExitSignal ? err.code : null;
      }
      expect(code).toBe(2);
    }
  });

  test("-h and --version exit 0", () => {
    for (const line of ["-h", "--help", "feed -h", "post --help", "--version"]) {
      let code: number | null = null;
      try {
        parse(line);
      } catch (err) {
        code = err instanceof ExitSignal ? err.code : null;
      }
      expect(code).toBe(0);
    }
  });
});

describe("the fbcli executable", () => {
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawn(["bun", "run", "fbcli.ts", ...args], {
      cwd: import.meta.dir + "/..",
      env: { ...process.env, FBCLI_COOKIES: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  };

  test("--version prints the package version", async () => {
    const { stdout, exitCode } = await run(["--version"]);
    expect(stdout.trim()).toBe("fbcli 0.2.0");
    expect(exitCode).toBe(0);
  });

  test("--help lists every command", async () => {
    const { stdout, exitCode } = await run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("usage: fbcli");
    for (const s of spec.subcommands) expect(stdout).toContain(s.help);
  });

  test("a usage error goes to stderr with exit 2", async () => {
    const { stdout, stderr, exitCode } = await run(["bogus"]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("fbcli: error: argument cmd: invalid choice: 'bogus'");
  });

  test("a missing cookie source exits 1 with a hint", async () => {
    const { stderr, exitCode } = await run(["whoami"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error: no cookies. Pass --cookies <file|string> or set FBCLI_COOKIES.");
  });

  test("an unusable cookie source surfaces as an auth error, exit 1", async () => {
    const { stderr, exitCode } = await run(["whoami", "--cookies", "datr=onlythis"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("auth error: Missing essential cookie(s): c_user, xs.");
  });

  test("--dry-run previews a write action and exits 0 without a browser", async () => {
    const { stdout, exitCode } = await run(["post", "hello there", "--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[dry-run] would publish a post to your timeline");
  });

  test("--dry-run names the group and audience when given", async () => {
    const g = await run(["post", "hi", "--group", "123", "--dry-run"]);
    expect(g.stdout).toContain("group 123");
    const a = await run(["post", "hi", "--audience", "friends", "--dry-run"]);
    expect(a.stdout).toContain("audience: friends");
  });

  test("a write action refuses to run non-interactively without --yes", async () => {
    const { stderr, exitCode } = await run(["dm", "100", "hey"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("refusing to send a direct message to 100");
    expect(stderr).toContain("aborted.");
  });

  test("read actions are never gated by the write guard", async () => {
    // feed isn't a mutation, so it skips the guard and fails only for lack of cookies.
    const { stderr, exitCode } = await run(["feed"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("error: no cookies.");
  });
});
