#!/usr/bin/env bash
# Run once, from a machine logged into the Azure CLI with write access to
# your Key Vault. Puts the three GitHub App credentials Convoy needs into
# Key Vault under the same key names the example ExternalSecret expects.
#
# Usage:
#   ./seed-keyvault.sh <keyvault-name> <app-id> <webhook-secret> <path-to-private-key.pem>
set -euo pipefail

KEYVAULT_NAME="${1:?Usage: $0 <keyvault-name> <app-id> <webhook-secret> <path-to-private-key.pem>}"
APP_ID="${2:?Missing app-id}"
WEBHOOK_SECRET="${3:?Missing webhook-secret}"
PRIVATE_KEY_PATH="${4:?Missing path to private-key.pem}"

az keyvault secret set \
  --vault-name "$KEYVAULT_NAME" \
  --name convoy-github-app-id \
  --value "$APP_ID" >/dev/null

az keyvault secret set \
  --vault-name "$KEYVAULT_NAME" \
  --name convoy-github-webhook-secret \
  --value "$WEBHOOK_SECRET" >/dev/null

az keyvault secret set \
  --vault-name "$KEYVAULT_NAME" \
  --name convoy-github-private-key \
  --value "$(cat "$PRIVATE_KEY_PATH")" >/dev/null

echo "Seeded convoy-github-app-id, convoy-github-webhook-secret, convoy-github-private-key into $KEYVAULT_NAME."
