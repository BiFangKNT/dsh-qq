# Repository Guidelines

## Project Structure

This is a fork of `2710586329/dsh-qq`; the package remains `dsh-qq-onebot`. Distinguish fork installation from upstream releases.

- `src/`: plugin entry (`index.js`), inbound/outbound messages, sessions, configuration, tools, `onebot/` protocol client, and `shared/` utilities.
- `client.js`: DSH settings interface; `cordis.patch.yml`: bundle configuration.
- `test/`: regression scripts, mock DSH/NapCat, and simulator UI assets.
- `tools/`: ASR and deployment scripts; `docs/`: configuration, deployment, and development guides.
- `会话/` and `logs/`: local runtime data, not public fixtures.

## Development Commands

Use Node.js ≥ 26 and pnpm. JavaScript ES modules run directly; no build step is configured.

```powershell
pnpm install --ignore-scripts  # Install dependencies
pnpm dev:mock                  # Start the browser simulator
pnpm test:mock                 # Test the mock environment
pnpm test:e2e                  # Test the full mock message pipeline
pnpm test                      # Run all *.test.mjs sequentially
node test/run-all.mjs image    # Filter tests by filename
```

## Coding Style

Follow existing two-space indentation, single quotes, and omitted semicolons. Use `camelCase` identifiers, lowercase hyphenated module names, and explicit ESM import extensions. No formatter or lint command is configured; avoid unrelated reformatting.

Keep overlapping defaults in `src/config.js` and `cordis.patch.yml` synchronized; run the `patch-defaults` test after changing them.

## Testing

Tests use Node.js assertions, `node:test`, and custom scripts. Name regression files `<behavior>.test.mjs`. Cover changed behavior and relevant boundaries; run focused tests before broader regression checks. Documentation-only changes need link and whitespace checks. No coverage percentage is enforced.

Mock results do not establish real DSH, model, or QQ compatibility. Report verification limits; consult `TESTING.md` for integration checks.

## Commits and Pull Requests

Follow recent prefixes: `feat:`, `fix:`, `docs:`, and `build:`, optionally scoped, such as `docs(README): clarify fork installation`.

PRs should explain the problem, resulting behavior, and validation; link relevant issues and include screenshots for UI changes. Update affected documentation.

The user manages `git add`. Request confirmation before committing when asked; do not stage changes yourself.

## Security and Configuration

Keep credentials, real QQ identifiers, private paths, personas, and chat records out of commits and examples. Use fictional identifiers and redact shared logs.
