# Convoy

Self-hosted, real-time GitHub Actions pipeline visualizer for your whole
organization. Think ArgoCD, but for GitHub Actions runs instead of
Kubernetes deployments.

Convoy installs a GitHub App on your org (or just your own account) and
shows every repo's workflow runs on one screen, split into two views:

- **Deploys** — runs triggered by a production release (a version tag, or a
  published GitHub Release)
- **Pipelines** — everything else (main, qa, feature/*, bugfix/*, whatever)

Updates come in through GitHub webhooks, not polling. That's the part that
lets it scale to hundreds of repos without hammering the GitHub API.

![Convoy dashboard](docs/assets/screenshot.png)

## Why this exists

I work somewhere that deploys a lot of small services on Thursdays, and
watching that roll out used to mean 40 open tabs, one per repo's Actions
page, refreshing them by hand to see what landed and what didn't. That gets
old fast. Convoy is the tool I wished existed: point it at your org once,
and it just shows you what's deploying right now and what's normal CI
traffic, live, without anyone pasting a list of links into Slack.

## Quickstart

**Just want to look at it first?**

```bash
git clone <this repo> && cd convoy
npm install
npm run demo
```

Opens at `http://localhost:3000` with fake seeded data — no GitHub App, no
webhooks, nothing to configure. Good for a first look before you commit to
anything.

**Want it running on your own repos?**

```bash
cp .env.example .env
npm run dev
```

`.env.example` is just a template, no real secrets in it. `cp` creates your
own local `.env` from it (already gitignored). You don't have to fill it in
by hand — the next step does that part for you.

The first run walks you through creating a GitHub App in your browser and
installing it on whichever repos you want Convoy to watch. That's it —
`http://localhost:3000` now shows their real pipelines, live.

One thing worth knowing going in: this is meant to run as a persistent
service, not something you open and close. Like ArgoCD, it's only useful
while it's actually up. See ["Running it for real"](#running-it-for-real)
below for Docker/Kubernetes, and the [full setup guide](#setup) if
`npm run dev` doesn't just work for you.

## Design principles

A few decisions here were deliberate, so I'm writing down the reasoning
instead of leaving people to guess:

- **Self-hosted, never a hosted service.** Convoy ships as a Docker image
  and a Helm chart. Your CI data — repo names, workflow status, run
  metadata — never leaves your own infrastructure. There's no
  Convoy-operated backend anywhere.
- **Webhooks first, polling only as a safety net.** A GitHub App installed
  on your org gets `workflow_run`/`workflow_job` events directly. There's a
  slow periodic reconciliation pass too, but that only exists to catch
  webhook deliveries GitHub failed to send — it's not how Convoy stays up
  to date under normal operation.
- **One shared credential, not per-user GitHub logins.** Convoy doesn't
  implement "Login with GitHub" for your team. Who can *view* the dashboard
  is left to whatever your org already uses to gate internal tools (SSO,
  VPN, an authenticating ingress) — see Access control below. The GitHub
  App is the only credential Convoy ever uses to talk to GitHub.
- **Minimal permissions.** The App requests `actions: read` and
  `metadata: read`. Nothing else. It can't read file contents, can't write
  anything, can't touch your workflows.
- **No database in v1.** State lives in memory, rebuilt from webhooks plus
  periodic reconciliation. There's no history or trend analytics yet — this
  is a live status board, not an analytics platform. That might change
  someday, but v1 is meant to stay small enough that I can actually finish
  it.
- **Single instance.** Because state is just in-process memory, Convoy runs
  as exactly one replica (the Helm chart pins this). More than one wouldn't
  share state, and each replica would see a different, incomplete slice of
  GitHub's webhook deliveries.

## How classification works

A run counts as a **deploy** if:
- it was triggered by publishing a GitHub Release, or
- it was a `push` whose ref looks like a version tag (`v1.2.3`, `1.2.3-beta`, that kind of thing)

Everything else is a **pipeline**. If your repo doesn't follow that
convention — say it deploys by merging to a `production` branch instead of
tagging — add an override in `convoy.yaml`. See `convoy.yaml.example` for
the three override strategies (branch-based, tag-pattern, workflow-name),
plus an `excludeRepos` list for archived or irrelevant repos.

## Access control

> **⚠️ Convoy has no login of its own — don't expose it directly to the
> public internet.** This is the same call Prometheus and most self-hosted,
> read-only monitoring tools make: building and maintaining a real auth
> system is a lot of complexity for a tool that can't actually change
> anything, so Convoy expects to sit behind whatever access control your
> network already has. That's a deliberate v1 choice, not something I
> forgot — see below for how to actually do it.

Publishing Convoy's source code doesn't expose anything about your own
running instance. Your GitHub App's private key and webhook secret live
only in your own `.env`/Kubernetes Secret, never in git. The one thing you
do need to think about: the webhook endpoint (`/api/github/webhooks`) has
to be public so GitHub can reach it, and that part's fine to leave open — it
verifies GitHub's signature and rejects anything else. The **dashboard
itself** isn't authenticated by default, so if it's reachable from the
public internet, put something in front of it:

1. **Put it behind your existing SSO/VPN/authenticating ingress.** The
   normal way most internal tools are gated. Convoy doesn't need to know
   who you are, it just needs to not be reachable by people who shouldn't
   see it.
2. **Set `CONVOY_API_KEY`** if you don't have (1) yet. Accepts either
   `Authorization: Bearer <key>` (for scripts or reverse proxies) or plain
   HTTP Basic Auth with the key as the password and any username — a
   browser tab gets a real native login prompt, no login page for Convoy to
   build.
3. **Want per-person login instead of one shared password?** A free tunnel
   with built-in auth (Cloudflare Tunnel + Cloudflare Access, for example)
   can require signing in with Google/GitHub before traffic ever reaches
   Convoy, without Convoy having to implement any of that itself.

## Running it for real

**Docker:**
```bash
docker run -p 3000:3000 \
  -e APP_ID=... \
  -e WEBHOOK_SECRET=... \
  -e PRIVATE_KEY_PATH=/app/private-key.pem \
  -v $(pwd)/private-key.pem:/app/private-key.pem:ro \
  -v $(pwd)/convoy.yaml:/app/convoy.yaml:ro \
  ghcr.io/juaniartal/convoy:latest
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
Pulling from a private registry? You'll want `imagePullSecrets` too.

Already manage credentials through External Secrets Operator, Vault, or a
cloud secret manager, instead of plain `--set`/`--set-file`? Set
`secret.create=false` and point Convoy at a Secret you provide yourself.
There's an Azure Key Vault example under `helm/convoy/examples/` — the
same shape works for AWS, GCP, or Vault.

In your GitHub App settings, set the webhook URL to your deployed
instance's `/api/github/webhooks` endpoint.

## Setup

The Quickstart above covers the normal path. This section is the longer
version, for when something doesn't just work on the first try.

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
using the defaults in `app.yml`. It creates the GitHub App for you and
writes the App ID, private key, and webhook secret into `.env`. Install the
App on the org (or the specific repos) you want Convoy to watch.

For local webhook delivery, Probot defaults to relaying through
[smee.io](https://smee.io). If routing webhook metadata through a
third-party relay isn't acceptable even for local dev, run your own smee
server or use a different tunnel (ngrok, cloudflared) and set
`WEBHOOK_PROXY_URL` accordingly. None of this matters in production —
GitHub delivers webhooks straight to your deployed ingress URL there.

Right after the manifest flow finishes, Probot logs
`Probot has been set up, please restart the server!` — that's normal, not
an error. Stop `npm run dev` (Ctrl+C) and run it again once; the first
process was still running in "setup mode" and won't serve the real
dashboard until it restarts with the credentials that were just written.

#### If `npm run dev` crashes with `SmeeClient is not a constructor`

I ran into this myself. It's a known incompatibility between Probot 14's
built-in webhook proxy (which fetches `smee-client@5.0.0` via `npx` at
runtime) and Node 20/24 — confirmed it's not a network/proxy issue on my
end, since a plain `npx smee-client@5.0.0` runs fine on its own; it's
specifically Probot's internal dynamic import of it that breaks. Work
around it by setting up the App and tunnel by hand instead of relying on
the automatic manifest flow. This is more steps than the automatic path,
so here's every field, not just a summary:

**1. Create the App.** Go to
<https://github.com/settings/apps/new> and fill in:

- **GitHub App name** — anything, has to be unique on GitHub (e.g.
  `yourname-convoy-test`).
- **Description** — optional, leave it blank if you want.
- **Homepage URL** — GitHub requires *something* here even though nothing
  reads it for local testing. `http://localhost:3000` is fine.
- **Callback URL** and **"Request user authorization (OAuth) during
  installation"** — leave both alone (empty / unchecked). This section is
  for apps that implement "Login with GitHub" for end users, which Convoy
  deliberately doesn't do — see
  [Design principles](#design-principles) above for why. Nothing to fill
  in here.
- **Webhook → Active** — checked.
- **Webhook → Webhook URL** — a smee.io channel. Open
  <https://smee.io/new> in another tab first, it gives you a URL like
  `https://smee.io/AbCdEfGh123`; paste that here.
- **Webhook → Webhook secret** — *you* make this up, it isn't generated
  for you. Any string works, but a real random one is one command away:
  ```bash
  openssl rand -hex 20
  ```
  Paste the result here, and remember it — you'll type the exact same
  value into `.env` in step 3.
- **Repository permissions → Actions** — Read-only.
- **Repository permissions → Metadata** — Read-only (GitHub usually
  selects this automatically once Actions is set).
- **Subscribe to events** — check `Workflow run` and `Workflow job`.
- **Where can this GitHub App be installed?** — "Only on this account" is
  fine for personal testing.

Click **Create GitHub App**. GitHub creates it and shows you its settings
page — note the **App ID** near the top, you'll need it in a minute.

**2. Generate the private key.** Still on that settings page, scroll down
to **Private keys** and click **Generate a private key**. Your browser
downloads a `.pem` file — this is a key GitHub just generated specifically
for this App, not any SSH key you might already have on your machine (that
mix-up is an easy one to make and it does not work — GitHub App keys are
always RSA and start with `-----BEGIN RSA PRIVATE KEY-----`; if you paste
in something else, `npm run dev` will now tell you clearly instead of
failing in a confusing way). Move the downloaded file into this project
folder and rename it to `private-key.pem`.

**3. Fill in `.env` by hand:**
```
APP_ID=<the App ID from step 1>
WEBHOOK_SECRET=<the exact same string you put in the Webhook secret field>
PRIVATE_KEY_PATH=./private-key.pem
```
Leave `WEBHOOK_PROXY_URL` **empty** — setting it at all triggers the crash
this whole section exists to work around, even outside setup mode.

**4. Run it.** Two terminals, both from inside this project folder:

Terminal 1:
```bash
npm run dev
```
Terminal 2 (the smee relay, running independently):
```bash
npx smee-client@5.0.0 -u https://smee.io/<your-channel> -t http://localhost:3000/api/github/webhooks
```

**5. Install the App.** From the App's settings page, click **Install App**
in the left sidebar, pick your account, and choose a couple of test repos.
GitHub redirects you to a generic "Installation complete" confirmation
page when you're done — that's just GitHub's own page, not part of
Convoy, nothing to do there. Open `http://localhost:3000` and you should
see your repos.

**Don't want to deal with a tunnel at all yet?** You don't have to. Put
any syntactically valid URL in the Webhook URL field (even one that goes
nowhere) and skip terminal 2 entirely. Every webhook delivery will show as
failed in GitHub's UI, but Convoy still updates on its own every few
minutes via reconciliation — you just won't see changes the instant they
happen. Good enough for "does this work at all", set up the smee tunnel
later if you want it live.

### 2. Run it

See ["Running it for real"](#running-it-for-real) above for the Docker and
Helm commands.

### 3. Point GitHub at it

In your GitHub App settings, set the webhook URL to your deployed
instance's `/api/github/webhooks` endpoint.

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

Early days. v1 is focused on getting the core loop right — webhooks,
classification, live dashboard — for a single org, self-hosted. No
history/analytics, no multi-org support, no fancier access control yet.
That's on purpose, not an oversight; see open issues for what's actually
planned.

## License

MIT — see `LICENSE`.

## Maintainer

This is my first real open-source project. Built and maintained by
[Juan Ignacio](https://www.linkedin.com/in/juanignaciodev/) — issues and
PRs are welcome, see `CONTRIBUTING.md`.
