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

- `azure-keyvault-external-secret.yaml` + `seed-keyvault.sh` — Azure Key
  Vault via External Secrets Operator, plus the one-time script to seed the
  three credentials into it.
- `aws-secretsmanager-external-secret.yaml` + `seed-secretsmanager.sh` —
  same thing for AWS Secrets Manager. Same shape works for GCP Secret
  Manager or Vault too — just swap the `secretStoreRef`.
