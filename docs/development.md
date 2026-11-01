# Development

**English** · [Русский](development.ru.md)

Stack: Next.js 15 (App Router, standalone), TypeScript, Tailwind + shadcn/ui, MCP SDK v2 (`mcp-handler`), better-auth with an OAuth provider,
SQLite + Drizzle, `node-cron`, QuickJS for scripts. Code rules and the non-obvious parts are in [`CLAUDE.md`](../CLAUDE.md).

## Locally

```bash
cp .env.example .env.local   # fill in the keys: openssl rand -hex 32 / openssl rand -base64 32
pnpm install
pnpm dev                     # the log shows: "Admin panel: http://localhost:3000/<prefix>/login"
```

MCP is off over http (clients require https). The admin panel and connectors work.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # before every commit
pnpm db:generate                           # migration after editing lib/db/schema.ts
```

Don't run `pnpm build` next to a running `pnpm dev`: it overwrites `.next` and breaks the dev server.

## Screenshots and demo

```bash
pnpm build
pnpm screenshots   # docs/screenshots/*.png for the README and social preview
pnpm demo          # demo-out/ is a static demo for GitHub Pages
```

Both start the hub on made-up data (`scripts/demo/seed.mts`) in a temporary folder with `HUB_DEMO=1` (no background jobs),
walk through the admin panel in Chromium and save the pages without scripts. `.github/workflows/demo.yml` publishes the demo on every push to `main`;
in the repository settings, Pages → Source must be "GitHub Actions".

## Connectors

A connector is a folder `lib/connectors/<name>/` that exports a `Connector` object (`id`, `name`, `configSchema`, `test`, `tools`,
optional `instructions`), plus one line in `lib/connectors/registry.ts`. The admin panel draws the form from `configSchema`, and `secret()` fields are encrypted.

## Releases

`pnpm release` (or `pnpm release minor` / `major`) bumps the version in `package.json`, makes a commit, creates the tag `vX.Y.Z` and pushes.
CI builds the image, publishes `:X.Y.Z` and `:X.Y` next to `:latest`, and creates a GitHub Release with the list of commits since the previous tag.

Dependabot updates dependencies (`.github/dependabot.yml`) once a week. better-auth and the MCP SDK are grouped: update them together,
both libraries change fast.
