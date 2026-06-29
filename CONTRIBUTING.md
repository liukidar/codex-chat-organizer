# Contributing

## Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run check
```

Launch the extension development host:

1. Open this repository in VS Code.
2. Press `F5`.
3. Open the **Codex Chats** activity bar view in the Extension Development Host.

## Packaging

```bash
npm run package
code --install-extension codex-chat-organizer-0.0.3-rc.0.vsix --force
```

Reload VS Code after installing a local VSIX.

## Release Candidates

Use semver prerelease versions for release candidates:

```bash
npm version 0.0.3-rc.1 --no-git-tag-version
npm run check
git add package.json package-lock.json CHANGELOG.md
git commit -m "Bump extension version to 0.0.3-rc.1"
git push
```

Then run **Actions** -> **Release VSIX** in GitHub.
