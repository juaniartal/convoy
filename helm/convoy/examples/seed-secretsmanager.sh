#!/usr/bin/env bash
# Run once, from a machine authenticated with the AWS CLI and write access
# to Secrets Manager. Puts the three GitHub App credentials Convoy needs
# into Secrets Manager under the same key names the example ExternalSecret
# expects.
#
# Usage:
#   ./seed-secretsmanager.sh <app-id> <webhook-secret> <path-to-private-key.pem> [aws-region]
set -euo pipefail

APP_ID="${1:?Usage: $0 <app-id> <webhook-secret> <path-to-private-key.pem> [aws-region]}"
WEBHOOK_SECRET="${2:?Missing webhook-secret}"
PRIVATE_KEY_PATH="${3:?Missing path to private-key.pem}"
REGION_ARG=()
[ -n "${4:-}" ] && REGION_ARG=(--region "$4")

put_secret() {
  local name="$1" value="$2"
  aws secretsmanager create-secret --name "$name" --secret-string "$value" "${REGION_ARG[@]}" >/dev/null 2>&1 || \
  aws secretsmanager put-secret-value --secret-id "$name" --secret-string "$value" "${REGION_ARG[@]}" >/dev/null
}

put_secret convoy/github-app-id "$APP_ID"
put_secret convoy/github-webhook-secret "$WEBHOOK_SECRET"
put_secret convoy/github-private-key "$(cat "$PRIVATE_KEY_PATH")"

echo "Seeded convoy/github-app-id, convoy/github-webhook-secret, convoy/github-private-key into AWS Secrets Manager."

# Using the optional OIDC/SSO login too? Seed those the same way, e.g.:
#   put_secret convoy/oidc-issuer-url "https://login.microsoftonline.com/<tenant-id>/v2.0"
#   put_secret convoy/oidc-client-id "<client-id>"
#   put_secret convoy/oidc-client-secret "<client-secret>"
#   put_secret convoy/oidc-redirect-uri "https://<your-domain>/api/auth/oidc/callback"
