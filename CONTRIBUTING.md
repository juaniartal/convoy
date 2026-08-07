# Contributing to Convoy

Thanks for considering a contribution. Convoy is small on purpose — please
read this before opening a large PR, so we can keep it that way.

## Development setup

```bash
git clone <this repo>
cd convoy
npm install
cp .env.example .env
npm run dev
```

`npm run dev` uses Probot's manifest flow: the first run opens a browser page
to create a GitHub App under your own account/org for local testing, and
writes the resulting App ID / private key / webhook secret into `.env` for
you. It also needs a way to receive webhooks on your machine — Probot
defaults to a [smee.io](https://smee.io) relay for this; see the README for
alternatives if you'd rather not use a third-party relay even for local dev.

## Before opening a PR

```bash
npm run lint
npm run format
npm test
npm run build
```

All four must pass — CI runs the same checks and will block merge otherwise.

## Code layout

- `src/core/` — framework-agnostic business logic (classification, state,
  reconciliation). No Probot or Express imports here. If you're changing
  *how* a run gets classified as a deploy vs. a normal pipeline, this is
  where that lives (`src/core/classify.ts`), and it should be covered by a
  unit test in `test/classify.test.ts` using a plain fixture — no live
  GitHub App required to test this logic.
- `src/handlers/` — thin Probot webhook handlers that call into `core/`.
- `src/api/` — the internal HTTP API the frontend polls.
- `public/` — the frontend. Plain HTML/CSS/JS, no build step, no framework.
  Please keep it that way — a two-tab dashboard with search and polling
  doesn't need one, and it keeps the project approachable.

## Reporting bugs / requesting features

Open a GitHub issue. For security vulnerabilities, see `SECURITY.md` instead
— please don't file those as public issues.
