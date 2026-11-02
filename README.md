# dsh-obsidian-memory

Store your agent's memory as plain Markdown in an [Obsidian](https://obsidian.md) vault.

Every memory is a `.md` file with YAML frontmatter that Obsidian indexes natively — so you can read, edit, link and back up your agent's memory with tools you already use. Nothing is locked in a database.

> **Status:** early but working. Host half (7 tools, 8 routes), sidebar panel, BM25 recall, decay/archiving and GitHub sync are all implemented and verified on DSH `0.2.1-rc.5`.

## What it does

- **A sidebar panel** — click the brain icon, browse memories, filter by tag, sort by recency or importance, read and edit in place.
- **7 agent tools** — the model writes and reads its own memory without being told to.
- **Recall with a token budget** — three detail tiers (tiny / compact / detailed) pick preview length and keyword count so recall costs what you can afford, not what the vault weighs.
- **BM25 ranking, no embeddings** — works offline, needs no API key, no vector store, no model call. CJK bigram tokenization so Chinese queries work.
- **Decay and archiving** — old, unimportant, unreferenced memories fade; they are moved to `Memories/.archive/`, never deleted.
- **GitHub sync** — pushes changed notes through the Contents API so another machine can pull them back. Optional, off unless configured.
- **Secrets are refused, not redacted** — a note containing a token or password is skipped with a reason, because a redacted memory looks complete while being wrong.

## Install

Install straight from this repository — no npm account or registry needed:

```sh
dsh plugin --profile web add dsh-obsidian-memory@github:aoyamabf-max/dsh-obsidian-memory
```

Or pin a tag so an upgrade does not surprise you:

```sh
dsh plugin --profile web add dsh-obsidian-memory@github:aoyamabf-max/dsh-obsidian-memory#v0.3.0
```

Replace `web` with your profile name if you use another one. Then restart DSH. The panel appears in the left sidebar; the tools appear to the agent immediately.

### Manual install

If you would rather read the code before installing it:

```sh
git clone https://github.com/aoyamabf-max/dsh-obsidian-memory.git
cd dsh-obsidian-memory
dsh plugin --profile web add .
```

The package has no runtime dependencies of its own. Everything it imports — `@deepseek-ai/schemastery`, `@deepseek-ai/cordis`, the client UI packages — comes from the DSH host and is declared as a peer dependency.

### Requirements

- **DSH** `>=0.2.0-rc.1 <0.3.0-0`. Declared as a peer range, so a mismatched host fails at install time instead of misbehaving later.
- **`@deepseek-ai/schemastery`** `^3.18.0` — ships with DSH, so you normally do not install it yourself.
- **Obsidian** — optional but that is the point. If Obsidian is installed, the vault is discovered from `%APPDATA%\obsidian\obsidian.json` (Windows) or `~/.config/obsidian/obsidian.json` (Linux/macOS), preferring the vault currently open. You can also set `vaultPath` explicitly.

## Configuration

All settings live in the plugin's Config schema, so they show up in DSH's own settings UI. Every field has a default; an empty config is valid.

| Field | Default | Meaning |
|---|---|---|
| `vaultPath` | `""` | Absolute path to the vault. Empty = auto-discover from Obsidian. |
| `folder` | `"Memories"` | Subfolder for memory notes, relative to the vault root. |
| `maxNoteBytes` | `262144` | Notes longer than this are truncated (hard cap; raising it has no effect). |
| `repo` | `""` | `owner/name` to sync to. Empty = no sync. |
| `branch` | `"main"` | Branch to push to. |
| `tokenFile` | `""` | File holding a GitHub token. Empty = `~/.dsh/dsh-obsidian-memory/token`. |
| `denyFile` | `""` | Secret blacklist, one literal per line. Empty = `~/.dsh/dsh-obsidian-memory/deny.txt`. |
| `syncEnabled` | `true` | Whether the timer runs. |
| `syncMinutes` | `30` | Sync interval in minutes (minimum 5). |
| `forgettingEnabled` | `false` | Allow decay/archive to actually write. Preview works either way. |
| `decayFactor` | `0.9` | Multiplier applied per decay pass. |
| `pruneThreshold` | `0.15` | Below this importance, a note becomes eligible for archiving. |

### Setting up GitHub sync (optional)

1. Create a **private** repository. Memory can contain hostnames, paths and internal decisions.
2. Create a fine-grained token with **Contents: read and write** on that repo only.
3. Save it: `mkdir -p ~/.dsh/dsh-obsidian-memory && printf '%s' '<token>' > ~/.dsh/dsh-obsidian-memory/token`
4. Set `repo` to `owner/name` in the plugin config.

The token is never written into the plugin config or the repository. Sync state (a path → sha256 map) lives in `~/.dsh/dsh-obsidian-memory/sync-state.json`, so only changed notes are pushed.

### Keeping secrets out

The plugin refuses to push a note containing a secret, and counts it under `blocked` rather than `failed` — the two mean different things. Two layers:

- **Built-in patterns** (ship with the code): `github_pat_`, `gh[pousr]_`, `AKIA`, `sk-`, `BEGIN … PRIVATE KEY`, `密码[:=是]…`.
- **Your own blacklist** at `~/.dsh/dsh-obsidian-memory/deny.txt` — one literal string per line, `#` for comments. Put your own server addresses, passwords and key names here. **This file stays on your machine and is never read into the source tree.**

## The 7 tools

| Tool | What it does |
|---|---|
| `obsidian_remember` | Write a new memory note. |
| `obsidian_search` | BM25 search over titles, tags and bodies. |
| `obsidian_context` | Assemble recall into a token budget; returns tiny/compact/detailed. |
| `obsidian_read` | Read one note by vault-relative path. |
| `obsidian_update` | Edit an existing note; keeps `id` and `createdAt`. |
| `obsidian_forget` | Preview or apply decay + archiving. Preview is the default. |
| `obsidian_sync` | Push changed notes to GitHub now. |

The plugin also registers a system-prompt section telling the model **when** to write memory — long-term preferences, decisions and their reasons, pitfalls with the exact error text, machine-local facts (paths and ports, never credentials) — and when not to: one-off intermediates, anything readable from the code, casual remarks, discussions with no conclusion.

## Files it creates

```
<vault>/Memories/mem-YYYYMMDD-HHmmss <title>.md   one memory
<vault>/Memories/.archive/…                       decayed memories (moved, never deleted)
~/.dsh/dsh-obsidian-memory/token                  GitHub token (optional)
~/.dsh/dsh-obsidian-memory/deny.txt               your secret blacklist (optional)
~/.dsh/dsh-obsidian-memory/sync-state.json        sync bookkeeping
```

`Memories/.archive/` starts with a dot so Obsidian's graph and search skip it by default.

## Design notes

- **Markdown over a database.** The vault is the source of truth. Uninstalling the plugin loses nothing — your memories are still notes.
- **No embeddings.** Vector recall needs an embedding service, which means a key, a network call and a bill. BM25 plus wikilink expansion is worse at paraphrase and better at everything else; it also never sends your memory anywhere.
- **Refuse, don't redact.** A redacted memory reads as complete while the important part is gone, and a rule that misses one secret leaves it in git history forever.
- **Archive, don't delete.** Pruning first scans every `[[wikilink]]` target and skips anything referenced, then moves the rest into `.archive/`. Nothing is unlinked.
- **Frontmatter is rewritten whole.** Every write must carry `importance`, `level` and `accessCount` forward or they silently reset to defaults. `noteMetaNumbers()` exists so both read paths share one fallback rule.

## License

MIT
