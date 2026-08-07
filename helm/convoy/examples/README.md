# Bringing your own Secret

By default (`secret.create: true`), this chart creates the credentials
Secret directly from `values.yaml` — the simplest path for a plain
`helm install`, no other tooling required.

If you already manage credentials through an External Secrets
Operator / Vault / cloud secret manager (as most real GitOps setups do),
set:

```yaml
secret:
  create: false
  name: convoy-convoy # whatever name your externally-managed Secret has
```

and provide a Secret with that name containing `APP_ID`, `PRIVATE_KEY`,
`WEBHOOK_SECRET` (and `CONVOY_API_KEY` if you use the optional API key
gate) — same keys the chart's own Secret would have.

- `azure-keyvault-external-secret.yaml` — an ExternalSecret example for
  Azure Key Vault via External Secrets Operator. The same shape works for
  AWS Secrets Manager, GCP Secret Manager, or Vault — just swap the
  `secretStoreRef`.
- `seed-keyvault.sh` — one-time script to put the three GitHub App
  credentials into Key Vault under the key names the example expects.
