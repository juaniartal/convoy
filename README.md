# Convoy

Self-hosted, real-time GitHub Actions pipeline visualizer for your whole
organization — think "ArgoCD, but for GitHub Actions pipelines."

Convoy installs a GitHub App on your org (or your own account) and shows
every repository's workflow runs on one screen, split into two views:

- **Deploys** — runs triggered by a production release (a version tag, or a
  published GitHub Release)
- **Pipelines** — every other CI run (main, qa, feature/*, bugfix/*, etc.)

Updates arrive via GitHub webhooks, not polling, so it scales to an org with
hundreds of repositories without hammering the GitHub API.

![Convoy dashboard](docs/assets/screenshot.png)

## Quickstart

**Just want to look at it first?**

```bash
git clone <this repo> && cd convoy
npm install
npm run demo
```

Opens at `http://localhost:3000` with seeded fake data — no GitHub App, no
webhooks, no setup. Good for a first look.

**Want it running on your own repos?**

```bash
cp .env.example .env
npm run dev
```

`.env.example` is a template with no real secrets in it; `cp` just creates
your own local `.env` from it (already gitignored, so your credentials never
get committed). You don't need to fill it in by hand — the next step does
that for you.

The first run walks you through creating a GitHub App in your browser and
installing it on whichever repos you want Convoy to watch. That's it —
`http://localhost:3000` now shows their real pipelines, live.

This is meant to run as a persistent service, not something you open and
close — like ArgoCD, it's only useful while it's up. See
["Running it for real"](#running-it-for-real) below for Docker/Kubernetes,
and the [full setup guide](#setup) if `npm run dev` doesn't just work.

## Why

Watching a release roll out across dozens of repos usually means opening the
Actions tab of every repo by hand, or building something bespoke and
throwaway. Convoy is the reusable version of that: point it at your org once,
and it keeps showing you what's currently deploying and what's just normal CI
traffic — accurately, live, without anyone pasting a list of links.

## Design principles

- **Self-hosted, never a hosted service.** Convoy ships as a Docker image and
  a Helm chart. Your CI data — repo names, workflow status, run metadata —
  never leaves your own infrastructure. There is no Convoy-operated backend.
- **Webhooks first, polling only as a safety net.** A GitHub App installed on
  your org receives `workflow_run`/`workflow_job` events directly. A slow
  periodic reconciliation pass (a few minutes apart) exists only to catch
  webhook deliveries GitHub failed to deliver — it is not how Convoy stays
  up to date under normal operation.
- **One shared credential, not per-user GitHub logins.** Convoy does not
  implement "Login with GitHub" for your team. Who can *view* the dashboard
  is left to whatever your organization already uses to gate internal tools
  (SSO, VPN, an authenticating ingress) — see "Access control" below. The
  GitHub App is the *only* credential Convoy uses to talk to GitHub.
- **Minimal permissions.** The GitHub App requests `actions: read` and
  `metadata: read` — nothing else. It cannot read file contents, cannot write
  anything, and cannot modify workflows.
- **No database in v1.** State lives in memory, rebuilt from webhooks plus
  periodic reconciliation. There's no history or trend analytics yet — this
  is a live status board, not an analytics platform (that may change in a
  future version, but v1 is deliberately kept small and shippable).
- **Single instance.** Because state is in-process memory, Convoy runs as
  exactly one replica (the Helm chart pins this). Running more than one
  wouldn't share state and would each receive an inconsistent view of
  GitHub's webhook deliveries.

## How classification works

A run is classified as a **deploy** if:
- it was triggered by publishing a GitHub Release, or
- it was triggered by a `push` whose ref looks like a version tag (e.g. `v1.2.3`, `1.2.3-beta`)

Everything else is a **pipeline**. If a repo doesn't follow this convention
(for example, it deploys by merging to a `production` branch instead of
tagging), add an override in `convoy.yaml` — see `convoy.yaml.example` for
the three supported override strategies (branch-based, tag-pattern, or
workflow-name), plus an `excludeRepos` list for archived/irrelevant repos.

## Access control

> **⚠️ Convoy has no login of its own — don't expose it directly to the
> public internet.** This is the same tradeoff Prometheus and most
> self-hosted, read-only monitoring tools make on purpose: building and
> maintaining a real auth system (users, sessions, SSO) is a lot of
> complexity for a tool that can't change anything, so instead Convoy
> expects to sit behind whatever access control your network already has.
> That's a deliberate v1 choice, not an oversight — see below for the
> two ways to do it.

**Publishing Convoy's source code doesn't expose anything about your running
instance** — your GitHub App's private key and webhook secret live only in
your own `.env`/Kubernetes Secret, never in git. The one thing you do need to
think about: the webhook endpoint (`/api/github/webhooks`) has to be public
so GitHub can reach it, and it's safe to leave open — it verifies GitHub's
signature and rejects anything else. The **dashboard itself** is not
authenticated by default, so if it's reachable from the public internet, put
something in front of it:

1. **Put it behind your existing SSO/VPN/authenticating ingress** — the
   normal way most internal tools are gated. Convoy doesn't need to know who
   you are; it just needs to not be reachable by people who shouldn't see it.
2. **Set `CONVOY_API_KEY`** — a simple shared-secret gate if you don't have
   (1) available yet. Accepts either `Authorization: Bearer <key>` (for
   scripts/reverse proxies) or HTTP Basic Auth with the key as the password
   and any username — a plain browser tab gets a real native login prompt,
   no separate login page for Convoy to build.
3. **Want per-person login instead of one shared password?** A free
   tunnel with built-in auth (e.g. Cloudflare Tunnel + Cloudflare Access)
   can require you to sign in with Google/GitHub before traffic ever
   reaches Convoy — without Convoy having to implement anything itself.

## Running it for real

**Docker:**
```bash
docker run -p 3000:3000 \
  -e APP_ID=... \
  -e WEBHOOK_SECRET=... \
  -e PRIVATE_KEY_PATH=/app/private-key.pem \
  -v $(pwd)/private-key.pem:/app/private-key.pem:ro \
  -v $(pwd)/convoy.yaml:/app/convoy.yaml:ro \
  ghcr.io/YOUR_ORG_OR_USER/convoy:latest
```

**Kubernetes (Helm):**
```bash
helm install convoy ./helm/convoy \
  --set-file github.privateKey=./private-key.pem \
  --set github.appId=<APP_ID> \
  --set github.webhookSecret=<WEBHOOK_SECRET> \
  --set ingress.host=convoy.your-internal-domain.com
```

See `helm/convoy/values.yaml` for the full set of configurable values.
Pulling from a private registry? Set `imagePullSecrets` too.

Already manage credentials through External Secrets Operator, Vault, or a
cloud secret manager instead of plain `--set`/`--set-file`? Set
`secret.create=false` and point Convoy at a Secret you provide yourself —
see `helm/convoy/examples/` for an Azure Key Vault example (the same shape
works for AWS/GCP/Vault).

In your GitHub App settings, set the webhook URL to your deployed instance's
`/api/github/webhooks` endpoint.

## Setup

The Quickstart above covers the normal path. This section is the detailed
version, for when something doesn't just work.

### 1. Create the GitHub App

Locally, for development:

```bash
git clone <this repo>
cd convoy
npm install
cp .env.example .env
npm run dev
```

The first run walks you through Probot's manifest flow in your browser,
using the defaults in `app.yml` — it creates the GitHub App for you and
writes the App ID, private key, and webhook secret into `.env`. Install the
App on the org (or the specific repos) you want Convoy to watch.

For local webhook delivery, Probot defaults to relaying through
[smee.io](https://smee.io). If routing webhook metadata through a third-party
relay isn't acceptable even for local development, run your own smee server
or use an alternative tunnel (ngrok, cloudflared) and set `WEBHOOK_PROXY_URL`
accordingly. In production, none of this applies — GitHub delivers webhooks
directly to your deployed ingress URL.

#### If `npm run dev` crashes with `SmeeClient is not a constructor`

This is a known incompatibility between Probot 14's built-in webhook-proxy
(which dynamically fetches `smee-client@5.0.0` via `npx` at runtime) and
Node 20/24 — confirmed independently of network/proxy issues (a plain
`npx smee-client@5.0.0` works fine; only Probot's internal dynamic import of
it breaks). Work around it by setting up the App and tunnel manually instead
of relying on the automatic manifest flow:

1. Create the App by hand at <https://github.com/settings/apps/new> —
   webhook URL is a smee.io channel (get one by visiting
   `https://smee.io/new` in your browser first), events: `Workflow run` +
   `Workflow job`, permissions: `Actions: read`, `Metadata: read`.
2. Generate a private key on the App's settings page, save it as
   `private-key.pem` in this folder.
3. Fill `.env` by hand with the App ID, webhook secret, and
   `PRIVATE_KEY_PATH=./private-key.pem`. Leave `WEBHOOK_PROXY_URL` **empty**
   — setting it at all triggers the crash, even outside setup mode.
4. Run Convoy (`npm run dev`) in one terminal, and the smee relay
   independently in another:
   ```bash
   npx smee-client@5.0.0 -u https://smee.io/<your-channel> -t http://localhost:3000/api/github/webhooks
   ```
5. Install the App on a couple of test repos and open `http://localhost:3000`.

### 2. Run it

See ["Running it for real"](#running-it-for-real) above for the Docker and
Helm commands.

### 3. Point GitHub at it

In your GitHub App settings, set the webhook URL to your deployed instance's
`/api/github/webhooks` endpoint.

## Configuration reference

| Env var | Required | Description |
|---|---|---|
| `APP_ID` | yes | GitHub App ID |
| `PRIVATE_KEY_PATH` or `PRIVATE_KEY` | yes (one of the two) | Path to the App's private key `.pem`, or its raw contents (what the Helm chart uses, via a Secret) |
| `WEBHOOK_SECRET` | yes | GitHub App webhook secret |
| `PORT` | no (default `3000`) | HTTP port |
| `CONVOY_API_KEY` | no | If set, gates all requests behind a Bearer token or Basic Auth (any username, this as the password) |
| `CONVOY_CONFIG_PATH` | no (default `./convoy.yaml`) | Path to classification overrides |

## Status

Early — v1 is focused on getting the core loop (webhooks → classification →
live dashboard) right for a single org, self-hosted. History/analytics,
multi-org support, and richer access control are explicitly out of scope for
now; see open issues for what's planned.

## License

MIT — see `LICENSE`.

## Maintainer

Built and maintained by [Juan Ignacio](https://www.linkedin.com/in/juanignaciodev/).
Issues and PRs welcome — see `CONTRIBUTING.md`.
