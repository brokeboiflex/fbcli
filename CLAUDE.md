# CLAUDE.md

This project's agent instructions live in [AGENTS.md](AGENTS.md) — read it
before changing code or running any Facebook command.

@AGENTS.md

Two skills ship with the repo, in the cross-agent `.agents/skills/` location
and symlinked into `.claude/skills/` so Claude Code picks them up:

- `fbcli` — using fbcli to read or write a Facebook account (safety rules,
  JSON contract, recipes).
- `fbcli-dev` — changing fbcli itself (test loop, adding a command, fixing a
  drifted selector).
