/**
 * A small argparse-shaped command-line parser.
 *
 * Python's `argparse` is in the standard library; Bun has nothing equivalent, so
 * this module reimplements just the slice fbcli used: global options, a required
 * subcommand, per-subcommand options with `choices`/`type`, optional positionals,
 * `-h/--help` at both levels, `--version`, and argparse's exit-2-on-usage-error
 * contract. Help output is formatted to match argparse closely enough that the
 * README's examples still read true.
 */

export type ValueType = "string" | "int" | "float";

export interface Option {
  /** e.g. `["-h", "--help"]` — long flags are what callers normally use. */
  flags: string[];
  /** Key the parsed value lands on. */
  dest: string;
  action?: "store" | "storeTrue" | "version" | "help";
  valueType?: ValueType;
  default?: unknown;
  choices?: readonly string[];
  help?: string;
  metavar?: string;
  /** Text printed by `action: "version"`. */
  version?: string;
}

export interface Positional {
  dest: string;
  optional?: boolean;
  default?: string;
  metavar?: string;
  help?: string;
}

export interface SubCommand {
  name: string;
  help: string;
  positionals?: Positional[];
  options?: Option[];
}

export interface ParserSpec {
  prog: string;
  description?: string;
  options: Option[];
  subcommands: SubCommand[];
}

/** Thrown when the parser has finished the process's work (help/version/error). */
export class ExitSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "ExitSignal";
    this.code = code;
  }
}

export type ParsedArgs = Record<string, unknown> & { cmd: string };

const HELP_OPTION: Option = {
  flags: ["-h", "--help"],
  dest: "help",
  action: "help",
  help: "show this help message and exit",
};

const WIDTH = 80;
const MAX_HELP_POSITION = 24;

function metavarOf(opt: Option): string {
  if (opt.metavar) return opt.metavar;
  const long = opt.flags.find((f) => f.startsWith("--")) ?? opt.flags[0]!;
  return long.replace(/^-+/, "").replace(/-/g, "_").toUpperCase();
}

function takesValue(opt: Option): boolean {
  return (opt.action ?? "store") === "store";
}

function invocationOf(opt: Option): string {
  if (takesValue(opt)) {
    const mv = metavarOf(opt);
    return opt.flags.map((f) => `${f} ${mv}`).join(", ");
  }
  return opt.flags.join(", ");
}

function usageTokens(opts: Option[]): string[] {
  return opts.map((o) => {
    const flag = o.flags[0]!;
    return takesValue(o) ? `[${flag} ${metavarOf(o)}]` : `[${flag}]`;
  });
}

function positionalToken(p: Positional): string {
  const mv = p.metavar ?? p.dest;
  return p.optional ? `[${mv}]` : mv;
}

/** Wrap `tokens` under a `usage: ` prefix the way argparse does. */
function formatUsage(prefix: string, tokens: string[]): string {
  const head = `usage: ${prefix}`;
  const indent = " ".repeat(head.length + 1);
  const lines: string[] = [];
  let line = head;
  for (const t of tokens) {
    if (line.length + 1 + t.length > WIDTH && line !== head) {
      lines.push(line);
      line = indent + t;
    } else {
      line += " " + t;
    }
  }
  lines.push(line);
  return lines.join("\n");
}

/** Render one `  invocation   help` row, wrapping long help text. */
function formatRow(invocation: string, help: string | undefined, indent: number, helpPos: number): string {
  const left = " ".repeat(indent) + invocation;
  if (!help) return left;
  const pad = " ".repeat(helpPos);
  const avail = Math.max(WIDTH - helpPos, 20);
  const words = help.split(/\s+/).filter(Boolean);
  const wrapped: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > avail) {
      wrapped.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) wrapped.push(cur);
  const body = wrapped.map((l, i) => (i === 0 ? l : pad + l)).join("\n");
  if (left.length + 2 > helpPos) {
    return left + "\n" + pad + body;
  }
  return left + " ".repeat(helpPos - left.length) + body;
}

function helpPositionFor(invocations: string[]): number {
  const longest = invocations.reduce((m, s) => Math.max(m, s.length + 2), 0);
  return Math.min(Math.max(longest + 2, 14), MAX_HELP_POSITION);
}

function topUsage(spec: ParserSpec): string {
  const opts = [HELP_OPTION, ...spec.options];
  const choices = `{${spec.subcommands.map((s) => s.name).join(",")}}`;
  return formatUsage(spec.prog, [...usageTokens(opts), choices, "..."]);
}

function subUsage(spec: ParserSpec, sub: SubCommand): string {
  const opts = [HELP_OPTION, ...(sub.options ?? [])];
  const positionals = (sub.positionals ?? []).map(positionalToken);
  return formatUsage(`${spec.prog} ${sub.name}`, [...usageTokens(opts), ...positionals]);
}

export function formatTopHelp(spec: ParserSpec): string {
  const opts = [HELP_OPTION, ...spec.options];
  const choices = `{${spec.subcommands.map((s) => s.name).join(",")}}`;
  const invocations = [
    ...opts.map(invocationOf),
    ...spec.subcommands.map((s) => "  " + s.name),
  ];
  const helpPos = helpPositionFor(invocations);

  const out = [topUsage(spec), ""];
  if (spec.description) out.push(spec.description.trimEnd(), "");
  out.push("positional arguments:");
  out.push("  " + choices);
  for (const s of spec.subcommands) {
    out.push(formatRow(s.name, s.help, 4, helpPos));
  }
  out.push("", "options:");
  for (const o of opts) {
    out.push(formatRow(invocationOf(o), o.help, 2, helpPos));
  }
  return out.join("\n");
}

export function formatSubHelp(spec: ParserSpec, sub: SubCommand): string {
  const opts = [HELP_OPTION, ...(sub.options ?? [])];
  const positionals = sub.positionals ?? [];
  const invocations = [
    ...opts.map(invocationOf),
    ...positionals.map((p) => p.metavar ?? p.dest),
  ];
  const helpPos = helpPositionFor(invocations);

  const out = [subUsage(spec, sub), ""];
  if (sub.help) out.push(sub.help, "");
  if (positionals.length) {
    out.push("positional arguments:");
    for (const p of positionals) {
      out.push(formatRow(p.metavar ?? p.dest, p.help, 2, helpPos));
    }
    out.push("");
  }
  out.push("options:");
  for (const o of opts) {
    out.push(formatRow(invocationOf(o), o.help, 2, helpPos));
  }
  return out.join("\n");
}

function fail(usage: string, prog: string, message: string): never {
  console.error(usage);
  console.error(`${prog}: error: ${message}`);
  throw new ExitSignal(2);
}

function convert(opt: Option, raw: string, usage: string, prog: string): unknown {
  const flag = opt.flags.find((f) => f.startsWith("--")) ?? opt.flags[0]!;
  if (opt.choices && !opt.choices.includes(raw)) {
    const list = opt.choices.map((c) => `'${c}'`).join(", ");
    fail(usage, prog, `argument ${flag}: invalid choice: '${raw}' (choose from ${list})`);
  }
  if (opt.valueType === "int") {
    if (!/^[+-]?\d+$/.test(raw.trim())) {
      fail(usage, prog, `argument ${flag}: invalid int value: '${raw}'`);
    }
    return Number.parseInt(raw, 10);
  }
  if (opt.valueType === "float") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      fail(usage, prog, `argument ${flag}: invalid float value: '${raw}'`);
    }
    return n;
  }
  return raw;
}

/**
 * Parse `argv` against `spec`.
 *
 * Throws `ExitSignal` when the process should stop (help, `--version`, or a
 * usage error, which exits 2 like argparse).
 */
export function parseArgs(spec: ParserSpec, argv: string[]): ParsedArgs {
  const globals = new Map<string, Option>();
  for (const o of [HELP_OPTION, ...spec.options]) {
    for (const f of o.flags) globals.set(f, o);
  }
  const subs = new Map(spec.subcommands.map((s) => [s.name, s] as const));

  const values: Record<string, unknown> = {};
  for (const o of spec.options) {
    if (o.action === "storeTrue") values[o.dest] = false;
    else if (takesValue(o)) values[o.dest] = o.default ?? null;
  }

  let sub: SubCommand | null = null;
  let subOpts = new Map<string, Option>();
  const positionals: string[] = [];
  const usage = (): string => (sub ? subUsage(spec, sub) : topUsage(spec));

  const i = { v: 0 };
  while (i.v < argv.length) {
    const tok = argv[i.v]!;
    i.v++;

    if (tok === "--") {
      for (; i.v < argv.length; i.v++) positionals.push(argv[i.v]!);
      break;
    }

    if (tok.startsWith("-") && tok !== "-") {
      let name = tok;
      let inline: string | null = null;
      const eq = tok.indexOf("=");
      if (tok.startsWith("--") && eq !== -1) {
        name = tok.slice(0, eq);
        inline = tok.slice(eq + 1);
      }
      const opt = subOpts.get(name) ?? globals.get(name);
      if (!opt) fail(usage(), spec.prog, `unrecognized arguments: ${tok}`);

      if (opt.action === "help") {
        console.log(sub ? formatSubHelp(spec, sub) : formatTopHelp(spec));
        throw new ExitSignal(0);
      }
      if (opt.action === "version") {
        console.log(opt.version ?? "");
        throw new ExitSignal(0);
      }
      if (opt.action === "storeTrue") {
        if (inline !== null) {
          fail(usage(), spec.prog, `argument ${name}: ignored explicit argument '${inline}'`);
        }
        values[opt.dest] = true;
        continue;
      }
      let raw = inline;
      if (raw === null) {
        if (i.v >= argv.length) {
          fail(usage(), spec.prog, `argument ${name}: expected one argument`);
        }
        raw = argv[i.v]!;
        i.v++;
      }
      values[opt.dest] = convert(opt, raw, usage(), spec.prog);
      continue;
    }

    if (sub === null) {
      const found = subs.get(tok);
      if (!found) {
        const list = spec.subcommands.map((s) => `'${s.name}'`).join(", ");
        fail(topUsage(spec), spec.prog, `argument cmd: invalid choice: '${tok}' (choose from ${list})`);
      }
      sub = found;
      values.cmd = sub.name;
      subOpts = new Map();
      for (const o of sub.options ?? []) {
        for (const f of o.flags) subOpts.set(f, o);
        if (o.action === "storeTrue") values[o.dest] = false;
        else if (takesValue(o)) values[o.dest] = o.default ?? null;
      }
      continue;
    }

    positionals.push(tok);
  }

  if (sub === null) {
    fail(topUsage(spec), spec.prog, "the following arguments are required: cmd");
  }

  const expected = sub.positionals ?? [];
  if (positionals.length > expected.length) {
    const extra = positionals.slice(expected.length).join(" ");
    fail(subUsage(spec, sub), spec.prog, `unrecognized arguments: ${extra}`);
  }
  const missing = expected
    .slice(positionals.length)
    .filter((p) => !p.optional)
    .map((p) => p.metavar ?? p.dest);
  if (missing.length) {
    fail(subUsage(spec, sub), spec.prog, `the following arguments are required: ${missing.join(", ")}`);
  }
  expected.forEach((p, idx) => {
    values[p.dest] = idx < positionals.length ? positionals[idx] : (p.default ?? null);
  });

  return values as ParsedArgs;
}
