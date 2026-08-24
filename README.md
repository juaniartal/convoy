# Convoy

[![CI](https://github.com/juaniartal/convoy/actions/workflows/ci.yml/badge.svg)](https://github.com/juaniartal/convoy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

Self-hosted, real-time GitHub Actions pipeline visualizer for your whole
organization. Think ArgoCD, but for GitHub Actions runs instead of
Kubernetes deployments.

Convoy installs a GitHub App on your org (or just your own account) and
shows every repo's workflow runs on one screen, split into three views:

- **Deploys** — runs triggered by a production release (a version tag, or a
  published GitHub Release)
- **Pipelines** — everything else (main, qa, feature/*, bugfix/*, whatever)
- **Overview** — an ArgoCD-style summary page: what portion of your repos
  are healthy vs. down right now, one donut chart per view

Updates come in through GitHub webhooks, not polling. That's the part that
lets it scale to hundreds of repos without hammering the GitHub API.

> **Every instance is fully independent.** Running Convoy means creating
> your *own* GitHub App, with your own credentials, on your own account or
> org. Nobody who self-hosts Convoy ever needs mine, or anyone else's —
> that's the whole point of self-hosted.

![Convoy dashboard](docs/assets/screenshot.png)

## Contents

- [Why this exists](#why-this-exists)
- [Quickstart](#quickstart)
- [Choose how you'll run it](#choose-how-youll-run-it)
  - [Case 1 — just trying it out](#case-1--just-trying-it-out)
  - [Case 2 — one person, actually relying on it day to day](#case-2--one-person-actually-relying-on-it-day-to-day)
  - [Case 3 — a team, always-on in a shared cluster](#case-3--a-team-always-on-in-a-shared-cluster)
  - [Is it actually real-time?](#is-it-actually-real-time)
- [Design principles](#design-principles)
- [How classification works](#how-classification-works)
- [Access control](#access-control)
- [Setup](#setup)
- [Configuration reference](#configuration-reference)
- [Status](#status)
- [License](#license)
- [Maintainer](#maintainer)

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
git clone <this repo> && cd convoy
npm install
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
while it's actually up (or up whenever you personally need it — see the
next section). See [Choose how you'll run it](#choose-how-youll-run-it)
below, and the [full setup guide](#setup) if `npm run dev` doesn't just
work for you.

## Choose how you'll run it

Three cases, and they need genuinely different webhook setups — worth
reading before you pick one. Whichever you land on, it starts the same
way: you need your own GitHub App (see [Setup](#setup) — the same
walkthrough for everyone, regardless of where Convoy itself ends up
running).

### Case 1 — just trying it out

`npm run demo` needs nothing at all (no GitHub App, no webhooks — see
[Quickstart](#quickstart) above). Want real data while you evaluate it?
`npm run dev` plus the smee.io relay from [Setup](#setup) is fine *for
this*. smee is a free, ephemeral, third-party relay — exactly right for
"let me see this work for twenty minutes," and exactly wrong for anything
you plan to depend on (channels aren't meant to be permanent, and you
don't control that relay's uptime).

### Case 2 — one person, actually relying on it day to day

Once you're past evaluating, stop using smee. Two ways to do this instead —
pick whichever matches how you actually work, not which one is "more
correct":

**A. A small always-on VPS.** No Kubernetes needed. A cheap box (a $5-6/mo
DigitalOcean/Hetzner droplet, a home server, even a Raspberry Pi) running
Docker is enough to keep it up permanently:
```bash
docker run -d --restart=always -p 3000:3000 \
  -e APP_ID=... \
  -e WEBHOOK_SECRET=... \
  -e PRIVATE_KEY_PATH=/app/private-key.pem \
  -v $(pwd)/private-key.pem:/app/private-key.pem:ro \
  -v $(pwd)/convoy.yaml:/app/convoy.yaml:ro \
  ghcr.io/juaniartal/convoy:latest
```
`--restart=always` means it survives the box rebooting. Point your GitHub
App's webhook URL at `http://<your-server>:3000/api/github/webhooks` — put
a real domain and TLS in front if you want it cleaner (a reverse proxy
like Caddy makes that close to a one-liner). The box itself has a public
IP, so GitHub reaches it directly — no relay of any kind needed here.

**B. Local Kubernetes, only running when you're actually looking.** If you
already run Docker Desktop / kind / minikube for other things, you don't
need a VPS at all — install the Helm chart locally and bring it up only
when you want to check on something:
```bash
helm install convoy ./helm/convoy \
  --set-file github.privateKey=./private-key.pem \
  --set github.appId=<APP_ID> \
  --set github.webhookSecret=<WEBHOOK_SECRET>

kubectl port-forward svc/convoy-convoy 3000:80   # whenever you want to look
```
Unlike option A, a port-forward is only reachable from your own machine —
GitHub can't deliver anything to it directly. Two ways to handle that:
- **Don't bother.** Leave the webhook URL pointed at nothing reachable.
  Every delivery shows as failed in GitHub's UI (harmless), and
  reconciliation still catches everything up automatically within a few
  minutes of you bringing Convoy back up. This is genuinely how I ran my
  own instance for most of building this.
- **Want it truly live instead of "catches up in a few minutes"?** Use a
  tunnel with a **static/persistent domain** — a free [ngrok](https://ngrok.com)
  account gives you one for exactly this. Point the tunnel at
  `localhost:3000` whenever Convoy is up, and set your GitHub App's webhook
  URL to that ngrok domain *once* — since the domain doesn't change between
  runs, you never have to touch the App's settings again, just start/stop
  the tunnel alongside Convoy itself. This is *not* smee: it's a stable
  address you control, not an ephemeral test channel.

Either way, once it's reachable by anyone but you, set `CONVOY_API_KEY` —
one env var gets you a real login page instead of a wide-open dashboard.
See [Access control](#access-control).

<details>
<summary><strong>New to Docker? Full walkthrough for option A, from zero</strong></summary>

Every step needed to get a real domain serving Convoy over HTTPS,
permanently, on a plain VPS — not assuming you've done any of this before.

1. **Get a VPS.** Any provider works (DigitalOcean, Hetzner, a spare
   machine at home with port forwarding). You need: a public IP address,
   and root/sudo access. $5-6/mo is plenty — Convoy is light.
2. **Install Docker on it.** SSH in, then:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
   That's Docker's own official install script, works on basically every
   Linux distro. (On your own laptop instead of a VPS, install Docker
   Desktop from docker.com — but a laptop that sleeps isn't "always on",
   which is the whole point of this case.)
3. **Point a domain at it.** Buy a domain anywhere (Namecheap, Google
   Domains, whatever), or use a subdomain of one you already own. In your
   DNS provider's dashboard, add an **A record**: name `convoy` (or
   whatever subdomain), value = your VPS's public IP. DNS changes can take
   a few minutes to a few hours to propagate; `dig convoy.yourdomain.com`
   should eventually show your VPS's IP.
4. **Create the GitHub App.** Follow [Setup](#setup) below — same steps
   regardless of where Convoy ends up running. Save the App ID, the
   downloaded private key, and the webhook secret.
5. **Run Convoy and a reverse proxy together**, so you get real HTTPS
   without touching certificates by hand — Caddy gets one automatically
   from Let's Encrypt the moment it sees a real domain pointed at it:
   ```bash
   docker network create convoy-net

   docker run -d --name convoy --restart=always --network convoy-net \
     -e APP_ID=<APP_ID> \
     -e WEBHOOK_SECRET=<WEBHOOK_SECRET> \
     -e PRIVATE_KEY_PATH=/app/private-key.pem \
     -v $(pwd)/private-key.pem:/app/private-key.pem:ro \
     ghcr.io/juaniartal/convoy:latest

   cat > Caddyfile <<'EOF'
   convoy.yourdomain.com {
     reverse_proxy convoy:3000
   }
   EOF

   docker run -d --name caddy --restart=always --network convoy-net \
     -p 80:80 -p 443:443 \
     -v caddy_data:/data \
     -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile \
     caddy:2
   ```
   Replace `convoy.yourdomain.com` with your real domain in the Caddyfile.
   Give it a minute — Caddy needs to request and validate the certificate
   the first time.
6. **Point the GitHub App's webhook URL** at
   `https://convoy.yourdomain.com/api/github/webhooks` (in the App's
   settings page).
7. **Check it's alive**: `curl https://convoy.yourdomain.com/api/healthz`
   should return `{"status":"ok",...}`. Open the domain in a browser —
   that's your dashboard, permanently up, with real HTTPS, no relay of any
   kind between GitHub and your server.

</details>

### Case 3 — a team, always-on in a shared cluster

This is what the Helm chart is actually built for:
```bash
helm install convoy ./helm/convoy \
  --set-file github.privateKey=./private-key.pem \
  --set github.appId=<APP_ID> \
  --set github.webhookSecret=<WEBHOOK_SECRET> \
  --set ingress.host=convoy.your-internal-domain.com
```
See `helm/convoy/values.yaml` for the full set of configurable values.
Pulling from a private registry? You'll want `imagePullSecrets` too. Before
putting this behind a real Ingress host, turn on a login — set `apiKey` for
a single shared password, or the `oidc.*` values for a real "Log in with
\<your provider\>" button backed by Azure AD/Google/Okta/etc., whatever
your team already uses:
```bash
helm install convoy ./helm/convoy \
  --set-file github.privateKey=./private-key.pem \
  --set github.appId=<APP_ID> \
  --set github.webhookSecret=<WEBHOOK_SECRET> \
  --set ingress.host=convoy.your-internal-domain.com \
  --set oidc.issuerUrl=https://login.microsoftonline.com/<tenant-id>/v2.0 \
  --set oidc.clientId=<CLIENT_ID> \
  --set oidc.clientSecret=<CLIENT_SECRET> \
  --set oidc.redirectUri=https://convoy.your-internal-domain.com/api/auth/oidc/callback
```
Both `apiKey` and `oidc.*` can be set together — see
[Access control](#access-control) for the full picture on either one.

Already manage credentials through External Secrets Operator, Vault, or a
cloud secret manager instead of plain `--set`/`--set-file`? Set
`secret.create=false` and point Convoy at a Secret you provide yourself —
there are working examples for both **Azure Key Vault** and **AWS Secrets
Manager** under `helm/convoy/examples/` (same shape works for GCP Secret
Manager or Vault too, just swap the `secretStoreRef`).

Either way, the last step is the same: in your GitHub App's settings, set
the webhook URL to your deployed instance's `/api/github/webhooks`
endpoint.

<details>
<summary><strong>New to Kubernetes? Full walkthrough, from zero</strong></summary>

Covers both a cluster you manage yourself and Azure AKS — everything
between "I have nothing" and a real HTTPS domain serving Convoy inside
your cluster, permanently.

1. **Get a cluster.**
   - **Azure AKS:**
     ```bash
     az group create --name convoy-rg --location eastus
     az aks create --resource-group convoy-rg --name convoy-aks \
       --node-count 1 --generate-ssh-keys
     az aks get-credentials --resource-group convoy-rg --name convoy-aks
     ```
     (One node is enough for Convoy itself; bump `--node-count` if this
     cluster runs other things too.)
   - **Your own cluster, nothing set up yet:** [k3s](https://k3s.io) is
     the fastest way to get a real, working cluster on any Linux box:
     `curl -sfL https://get.k3s.io | sh -`. Already have a cluster and
     `kubectl` pointed at it? Skip to step 2.
2. **Install `kubectl` and Helm**, if you don't have them —
   [kubernetes.io/docs/tasks/tools](https://kubernetes.io/docs/tasks/tools/)
   and:
   ```bash
   curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
   ```
3. **Install an Ingress controller** — this is what actually routes
   `https://convoy.yourdomain.com` to the right pod inside the cluster; a
   fresh cluster doesn't have one yet:
   ```bash
   helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
   helm repo update
   helm install ingress-nginx ingress-nginx/ingress-nginx \
     --namespace ingress-nginx --create-namespace
   ```
   Get its external IP (on AKS or any cloud, this appears within a minute
   or two; on bare-metal k3s with no cloud load balancer, it can stay
   `<pending>` — that needs something like [MetalLB](https://metallb.io/),
   a bare-metal-specific extra step outside what this guide covers):
   ```bash
   kubectl get svc -n ingress-nginx ingress-nginx-controller
   ```
4. **Point a domain at that IP** — same as the Docker walkthrough above:
   an A record in your DNS provider, name = your subdomain, value = the
   IP from step 3.
5. **Install cert-manager**, so HTTPS certificates get issued and renewed
   automatically instead of by hand:
   ```bash
   helm repo add jetstack https://charts.jetstack.io
   helm repo update
   helm install cert-manager jetstack/cert-manager \
     --namespace cert-manager --create-namespace --set crds.enabled=true
   ```
   Then tell it how to issue certificates (swap in a real email — Let's
   Encrypt uses it for expiry notices, nothing else):
   ```bash
   cat <<'EOF' | kubectl apply -f -
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata:
     name: letsencrypt
   spec:
     acme:
       server: https://acme-v02.api.letsencrypt.org/directory
       email: you@example.com
       privateKeySecretRef:
         name: letsencrypt-key
       solvers:
         - http01:
             ingress:
               ingressClassName: nginx
   EOF
   ```
6. **Create the GitHub App** — [Setup](#setup) below, same steps
   regardless of where Convoy runs.
7. **Install Convoy itself.** Put this in `convoy-values.yaml`:
   ```yaml
   github:
     appId: '<APP_ID>'
     webhookSecret: '<WEBHOOK_SECRET>'
   ingress:
     enabled: true
     className: nginx
     host: convoy.yourdomain.com
     annotations:
       cert-manager.io/cluster-issuer: letsencrypt
     tls:
       enabled: true
       secretName: convoy-tls
   ```
   then:
   ```bash
   helm install convoy ./helm/convoy \
     -f convoy-values.yaml \
     --set-file github.privateKey=./private-key.pem
   ```
8. **Point the GitHub App's webhook URL** at
   `https://convoy.yourdomain.com/api/github/webhooks`.
9. **Check it's alive**:
   `curl https://convoy.yourdomain.com/api/healthz` should return
   `{"status":"ok",...}` within a minute or so of the cert-manager
   certificate finishing issuance. Open the domain in a browser — that's
   your team's dashboard, live, inside your own cluster.

</details>

### Is it actually real-time?

Convoy always runs three things at once — there's no setting that picks
between them:

- **Webhooks** push an update the instant something happens on GitHub. This
  is what makes the board feel instant, and how it stays that way without
  polling hundreds of repos on a timer.
- **The active-run watcher** re-checks whatever Convoy currently thinks is
  still running (queued/in-progress), every ~30 seconds, but *only* those —
  reading "what's active" costs nothing (it's already in memory), and
  checking one specific run by id is a single cheap request. This exists
  because GitHub does drop webhook deliveries under bursty load — confirmed
  directly, not theoretical: pushing to 20 repos at once dropped roughly
  half the "completed" events one run, and every run that got stuck showing
  "rolling" corrected itself within the next ~30-second tick, not 5 minutes
  later.
- **Reconciliation** polls every repo directly every 5 minutes, regardless,
  whether webhooks are working or not. It's the last-resort net under both
  of the above — a run that was never even seen as "active" (its very first
  webhook was the one that got dropped) still gets caught here.

Which one you're actually getting at any moment comes down entirely to
whether GitHub can reach Convoy's webhook endpoint. Three things have to be
true:

1. Your GitHub App's webhook URL is set to something real (not blank, not
   pointing at a tunnel that isn't running).
2. That URL is reachable from the public internet.
3. **It points at wherever Convoy is *actually* running right now — same
   host, same port.** This is the one people get bitten by: a tunnel or
   Ingress keeps forwarding traffic to an address nothing is listening on
   anymore (an old process, a different port after a restart), and nothing
   anywhere throws an error — you just quietly start getting 5-minute-stale
   updates instead of instant ones.

**How to check which one you're actually getting:** hit `/api/healthz`:
```json
{ "status": "ok", "installationCount": 3, "lastReconciledAt": "...", "lastWebhookReceivedAt": "..." }
```
Trigger a run on GitHub and watch `lastWebhookReceivedAt`. If it updates
within a second or two, webhooks are live. If it stays stuck (or `null`)
while `lastReconciledAt` keeps advancing every 5 minutes on its own,
GitHub isn't reaching you — check point 3 above first, it's the usual
culprit.

**To make sure it's always real-time, not just right after setup:**
- **Solo/individual** (Case 2 above): the always-on VPS option (2-A) is the
  simplest way to guarantee this — one process, one public IP, nothing in
  between that can drift out of sync. The local-cluster-plus-tunnel option
  (2-B) works too, but you're responsible for keeping the tunnel and
  Convoy pointed at the same port every time you bring it back up.
- **Company** (Case 3 above): a real Ingress on a domain that's always up.
  Once it's wired correctly, Kubernetes keeps the Service pointed at
  whichever pod is actually alive automatically — nothing to keep in sync
  by hand.

## Design principles

A few decisions here were deliberate, so I'm writing down the reasoning
instead of leaving people to guess:

- **Self-hosted, never a hosted service.** Convoy ships as a Docker image
  and a Helm chart. Your CI data — repo names, workflow status, run
  metadata — never leaves your own infrastructure. There's no
  Convoy-operated backend anywhere.
- **Webhooks first, polling only as a safety net.** A GitHub App installed
  on your org gets `workflow_run`/`workflow_job` events directly. A fast
  watcher re-checks only currently-active runs every ~30s, and a slower
  full reconciliation pass runs every 5 minutes regardless — both exist to
  catch webhook deliveries GitHub failed to send, not how Convoy stays up
  to date under normal operation. See
  [Is it actually real-time?](#is-it-actually-real-time) for why this
  matters more than it sounds like it should.
- **One GitHub credential, separate from who can view the dashboard.** The
  GitHub App is the only credential Convoy ever uses to talk to GitHub —
  it's not tied to any individual's account. Who can *view* the dashboard
  is a different question, answered by an optional shared access key or
  OIDC login (see Access control below), or left to your network entirely.
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

Everything else is a **pipeline** — including pushes to long-lived
environment branches like `develop` or `qa`, even if that push technically
triggers a real deployment somewhere. That's intentional: "Deploy" is meant
to answer "did we ship a real release", not "did a file get copied
somewhere". A feature branch merged into `qa` isn't a release just because
the job that runs is *named* deploy.

The default (tag-shaped ref = deploy) already covers the common setup —
tag `v1.2.3`, deploy, done — with zero config. You only need an override
in `convoy.yaml` when there's genuinely no other signal for "this is a
real release":

- **You tag releases, but also deploy on every push to some branches**
  (`develop`/`qa`/`main` as environments, prod cut from a tag) — no
  override needed, the default already gets this right; branch pushes to
  those environments correctly stay as pipelines.
- **You have no tags at all, and production *is* a long-lived branch** —
  e.g. merging to `main` deploys straight to prod, nothing ever gets
  tagged. Here the branch itself is the only signal, so add:
  ```yaml
  overrides:
    - repo: your-org/your-repo
      strategy: branch
      deployBranches: [main]
  ```

See `convoy.yaml.example` for the three override strategies (branch-based,
tag-pattern, workflow-name), plus an `excludeRepos` list for archived or
irrelevant repos.

## Access control

> **⚠️ By default, Convoy has no login of its own — don't expose it
> directly to the public internet without turning one on.** Neither
> `CONVOY_API_KEY` nor `CONVOY_OIDC_*` set means anyone who reaches the URL
> sees the dashboard, no questions asked. Turning one of them on takes one
> env var.

Publishing Convoy's source code doesn't expose anything about your own
running instance. Your GitHub App's private key and webhook secret live
only in your own `.env`/Kubernetes Secret, never in git. The one thing you
do need to think about: the webhook endpoint (`/api/github/webhooks`) has
to be public so GitHub can reach it, and that part's fine to leave open — it
verifies GitHub's signature and rejects anything else. The **dashboard
itself** needs one of the following if it's reachable from anywhere you
don't fully trust:

1. **Set `CONVOY_API_KEY`.** Gates the dashboard behind Convoy's own login
   page with this as the shared access key. Scripts and reverse proxies can
   still send `Authorization: Bearer <key>` directly instead of going
   through the page. One password for the whole team, no accounts to
   manage — the simplest option, and enough for most self-hosters.
2. **Set `CONVOY_OIDC_*` for real SSO.** Adds a "Log in with \<provider\>"
   button to the same login page, backed by any standard OIDC provider —
   Azure AD, Google, Okta, whatever your org already uses. Needs an app
   registration at your provider first:
   ```bash
   CONVOY_OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0
   CONVOY_OIDC_CLIENT_ID=<from your app registration>
   CONVOY_OIDC_CLIENT_SECRET=<from your app registration>
   CONVOY_OIDC_REDIRECT_URI=https://convoy.your-domain.com/api/auth/oidc/callback
   ```
   That last value has to exactly match the redirect URI registered at the
   provider. Both `CONVOY_API_KEY` and `CONVOY_OIDC_*` can be set together
   — the login page shows the SSO button and the access-key field, either
   one gets you in.

   <details>
   <summary><strong>New to OIDC? Full walkthrough for getting those 4 values, from zero</strong></summary>

   Convoy doesn't implement its own login — it delegates to whatever
   identity provider your org already uses. You register Convoy as an
   "application" at that provider once, and it hands you the 4 values
   above. Pick the provider you use:

   **Azure AD / Microsoft Entra ID**

   1. Go to [entra.microsoft.com](https://entra.microsoft.com) → **App
      registrations** → **New registration**.
   2. Name it anything (e.g. `Convoy`). **Supported account types**:
      single tenant, unless you specifically want people outside your org
      to be able to log in. **Redirect URI**: platform **Web**, value
      `https://convoy.your-domain.com/api/auth/oidc/callback` — exact
      match required, including that path.
   3. On the app's overview page, copy **Application (client) ID** →
      that's `CONVOY_OIDC_CLIENT_ID`.
   4. Copy **Directory (tenant) ID** from the same page, and build:
      `CONVOY_OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0`
   5. **Certificates & secrets** → **New client secret** → copy the
      **Value** column immediately (it's hidden forever after you leave
      the page) → that's `CONVOY_OIDC_CLIENT_SECRET`.
   6. Restrict who can log in (recommended — Convoy itself doesn't filter
      by group): go to **Enterprise applications** → find your app →
      **Properties** → set **Assignment required** to **Yes** → then
      **Users and groups** → add only the people/teams who should have
      access. Azure rejects anyone else's login before Convoy ever sees
      it.

   **Google Workspace**

   1. [Google Cloud Console](https://console.cloud.google.com) → **APIs &
      Services** → **Credentials** → **Create credentials** → **OAuth
      client ID** → application type **Web application**.
   2. **Authorized redirect URIs** →
      `https://convoy.your-domain.com/api/auth/oidc/callback`.
   3. `CONVOY_OIDC_ISSUER_URL=https://accounts.google.com`, and the
      **Client ID**/**Client secret** Google shows you after creating it
      map straight to `CONVOY_OIDC_CLIENT_ID`/`CONVOY_OIDC_CLIENT_SECRET`.
   4. To restrict to your workspace domain instead of any Google account,
      set the OAuth consent screen's **User type** to **Internal**.

   **Okta**

   1. Okta admin panel → **Applications** → **Create App Integration** →
      **OIDC - OpenID Connect** → **Web Application**.
   2. **Sign-in redirect URI** →
      `https://convoy.your-domain.com/api/auth/oidc/callback`.
   3. `CONVOY_OIDC_ISSUER_URL=https://<your-okta-domain>/oauth2/default`,
      plus the **Client ID**/**Client secret** from the app you just
      created.
   4. Under **Assignments**, pick only the users/groups who should have
      access.

   **Any other provider** works the same way as long as it speaks
   standard OIDC: you always end up with an issuer URL, a client ID, a
   client secret, and a redirect URI you register up front. Once you have
   the 4 values, set them locally in `.env` or on a running deployment via
   Helm:
   ```bash
   helm upgrade convoy ./helm/convoy \
     --set oidc.issuerUrl=<issuer-url> \
     --set oidc.clientId=<client-id> \
     --set-string oidc.clientSecret=<client-secret> \
     --set oidc.redirectUri=https://convoy.your-domain.com/api/auth/oidc/callback
   ```
   Restart (Docker) or let the rollout finish (Helm), open the dashboard,
   and a "Log in with SSO" button appears.
   </details>
3. **Or skip both and put it behind your existing SSO/VPN/authenticating
   ingress instead.** Convoy doesn't need to know who you are, it just
   needs to not be reachable by people who shouldn't see it — if your
   network already handles that, there's nothing else to configure.

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

<details>
<summary><strong>If <code>npm run dev</code> crashes with <code>SmeeClient is not a constructor</code></strong></summary>

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

</details>

### 2. Run it

See [Choose how you'll run it](#choose-how-youll-run-it) above for the
Docker and Helm commands, whichever path fits.

### 3. Point GitHub at it

In your GitHub App settings, set the webhook URL to your deployed
instance's `/api/github/webhooks` endpoint.

## Configuration reference

**GitHub App**

| Env var | Required | Description |
|---|---|---|
| `APP_ID` | yes | GitHub App ID |
| `PRIVATE_KEY_PATH` or `PRIVATE_KEY` | yes (one of the two) | Path to the App's private key `.pem`, or its raw contents (what the Helm chart uses, via a Secret) |
| `WEBHOOK_SECRET` | yes | GitHub App webhook secret |
| `PORT` | no (default `3000`) | HTTP port |
| `CONVOY_CONFIG_PATH` | no (default `./convoy.yaml`) | Path to classification overrides |

**Access control** — see [Access control](#access-control) for the full picture

| Env var | Required | Description |
|---|---|---|
| `CONVOY_API_KEY` | no | Shared access key. Gates the dashboard behind Convoy's own login page; scripts can also send `Authorization: Bearer <key>` directly |
| `CONVOY_OIDC_ISSUER_URL` | no (all four together, or none) | Your OIDC provider's issuer URL (Azure AD, Google, Okta, ...) |
| `CONVOY_OIDC_CLIENT_ID` | no | Client ID from your provider's app registration |
| `CONVOY_OIDC_CLIENT_SECRET` | no | Client secret from the same app registration |
| `CONVOY_OIDC_REDIRECT_URI` | no | Must exactly match what's registered at the provider, ending in `/api/auth/oidc/callback` |
| `CONVOY_OIDC_BUTTON_LABEL` | no (default `Log in with SSO`) | Text on the login page's SSO button |
| `CONVOY_OIDC_ALLOW_INSECURE` | no | **Dev/test only.** Lets `CONVOY_OIDC_ISSUER_URL` point at a plain-HTTP IdP for local testing. Never set this against a real deployment — every real provider is HTTPS |

## Status

Early days. v1 is focused on getting the core loop right — webhooks,
classification, live dashboard, real-time reliability, and login (shared
key or OIDC/SSO) — for a single org, self-hosted. No history/analytics, no
multi-org support, no per-user accounts or audit trail (one shared login
or SSO, not individual identities). That's on purpose, not an oversight;
see open issues for what's actually planned.

## License

MIT — see `LICENSE`.

## Maintainer

This is my first real open-source project. Built and maintained by
[Juan Ignacio](https://www.linkedin.com/in/juanignaciodev/), a DevOps/SRE
engineer — I built Convoy to solve a real problem on my own team, and I
still run it myself day to day. Issues and PRs are welcome, see
`CONTRIBUTING.md`.
