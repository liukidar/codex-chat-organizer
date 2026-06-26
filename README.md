# Codex Chat Organizer

Local VS Code extension for browsing, searching, renaming, tagging, archiving,
and resuming Codex chats stored under `CODEX_HOME` (`~/.codex` by default).

This is intended to be a standalone repository. You can move this folder out of
the current workspace and initialize it as its own git repo.

## Features

- Browse local Codex chats from `state_*.sqlite`.
- Group chats by project working directory.
- Search titles, metadata, tags, and transcript JSONL content.
- Open a readable Markdown transcript.
- Rename chats in Codex local state so the title can show up in Codex.
- Archive and unarchive chats in Codex local state.
- Resume a chat by launching `codex resume <session-id>` in a terminal.
- Copy session IDs.
- Store organizer-only tags in `~/.codex-chat-organizer/metadata.json`.
- Create timestamped backups before every Codex-state mutation.

## Safety Model

Codex does not currently expose a public local rename/archive API for external
extensions. This extension writes to Codex's private local state after a
compatibility check.

On startup, the extension checks that Codex state still has the expected
`threads` schema. If the schema is not recognized, the extension switches into a
read-only/error state instead of guessing.

Before every rename/archive/unarchive, the extension backs up:

- `state_*.sqlite`
- `state_*.sqlite-wal`
- `state_*.sqlite-shm`
- `session_index.jsonl`

Backups are written under:

```text
~/.codex-chat-organizer/backups/
```

Tags are stored separately and do not affect Codex:

```text
~/.codex-chat-organizer/metadata.json
```

## Requirements

- VS Code `1.100.0` or newer.
- Node.js for development.
- Python 3 for the helper script.
- Codex local state under `~/.codex`, or set `codexChatOrganizer.codexHome`.

The extension avoids native Node SQLite dependencies. It shells out to Python's
standard-library `sqlite3` module.

## Development

Install dependencies:

```bash
npm install
```

Compile:

```bash
npm run compile
```

Run all local checks:

```bash
npm run check
```

Launch a development host:

1. Open this folder in VS Code.
2. Press `F5`.
3. In the Extension Development Host, open the **Codex Chats** activity bar view.

## Package

Build a `.vsix`:

```bash
npm run package
```

Install it:

```bash
code --install-extension codex-chat-organizer-0.0.2.vsix --force
```

Reload VS Code after installing.

If the CLI install command targets the wrong VS Code instance, use Command
Palette -> **Extensions: Install from VSIX...** and select the generated file.

## Release From GitHub

This repo includes a manual GitHub Actions workflow that checks the extension,
builds the `.vsix`, uploads it as a workflow artifact, and attaches it to a
GitHub Release.

To create a release:

1. Push this folder as a standalone GitHub repository.
2. In GitHub, open **Actions** -> **Release VSIX** -> **Run workflow**.
3. Leave `version` blank to release the current `package.json` version.
4. Optionally choose `draft` or `prerelease`.

The workflow creates a tag named from `package.json`, for example `v0.0.1`, and
attaches:

```text
codex-chat-organizer-0.0.1.vsix
```

For a new release, bump the package version first:

```bash
npm version 0.0.2 --no-git-tag-version
git add package.json package-lock.json
git commit -m "Bump extension version to 0.0.2"
git push
```

Then run the workflow again. After the release is published, it can be installed
from its release asset:

```bash
curl -L -o codex-chat-organizer.vsix \
  https://github.com/YOUR_USER/codex-chat-organizer/releases/download/v0.0.1/codex-chat-organizer-0.0.1.vsix

code --install-extension codex-chat-organizer.vsix
```

## Troubleshooting

If the **Codex Chats** view is empty:

1. Run **Codex Chats: Refresh** from the Command Palette.
2. Run **Codex Chats: Show Diagnostics** and inspect the output channel.
3. Run **Codex Chats: Check Compatibility**.

The helper can also be checked directly from the extension repo:

```bash
python3 scripts/codex_state.py schema
python3 scripts/codex_state.py list
python3 scripts/codex_state.py list --include-archived
```

If direct helper commands show chats but VS Code does not, reinstall the latest
VSIX with `--force` and reload VS Code.

## Settings

- `codexChatOrganizer.codexHome`: override `CODEX_HOME`.
- `codexChatOrganizer.pythonPath`: override the Python executable used by the helper.
- `codexChatOrganizer.showArchived`: show archived chats.
- `codexChatOrganizer.searchTranscriptContent`: scan transcript files during search.

## Commands

- **Codex Chats: Refresh**
- **Codex Chats: Search**
- **Codex Chats: Clear Search**
- **Codex Chats: Rename Chat**
- **Codex Chats: Archive Chat**
- **Codex Chats: Unarchive Chat**
- **Codex Chats: Set Tags**
- **Codex Chats: Open Transcript**
- **Codex Chats: Resume in Terminal**
- **Codex Chats: Copy Session ID**
- **Codex Chats: Check Compatibility**

Most commands are available from the tree item context menu.

## Data Sources

Read from Codex:

```text
~/.codex/state_*.sqlite
~/.codex/session_index.jsonl
~/.codex/sessions/**/*.jsonl
~/.codex/archived_sessions/*.jsonl
```

Written to Codex for native sync:

```text
~/.codex/state_*.sqlite
~/.codex/session_index.jsonl
```

Written by this extension:

```text
~/.codex-chat-organizer/metadata.json
~/.codex-chat-organizer/backups/
```

## Recovery

If a Codex update changes the schema and something looks wrong:

1. Close Codex/VS Code windows using Codex.
2. Find the latest backup under `~/.codex-chat-organizer/backups/`.
3. Copy the backed-up files back into `~/.codex`.
4. Reopen VS Code.

The extension creates a new backup before every native Codex-state mutation.

## Notes

If Codex is open while you rename/archive a chat, you may need to refresh or
reload the Codex sidebar before the change appears there.

Do not share extension logs or backups without reviewing them first. Codex
transcripts can contain sensitive data.
