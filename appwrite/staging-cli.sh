#!/usr/bin/env bash
# staging-cli.sh — run Appwrite CLI commands against the STAGING project only.
# Refuses to run if production project ID is present in the environment.
#
# Usage: ./staging-cli.sh <appwrite-cli-args...>
# Example: ./staging-cli.sh push collections

set -euo pipefail

STAGING_PROJECT_ID="6a0ad92e0001d5e515ce"
STAGING_ENDPOINT="https://nyc.cloud.appwrite.io/v1"
PROD_PROJECT_ID="691d4a54003b21bf0136"

# Defense-in-depth: refuse to run if the prod project ID is referenced in env.
# This prevents an APPWRITE_PROJECT_ID export from upstream contaminating us.
env | grep -F "$PROD_PROJECT_ID" >/dev/null && {
  echo "ERROR: production project ID '$PROD_PROJECT_ID' is present in the shell env." >&2
  echo "       Unset it (e.g. \`unset APPWRITE_PROJECT_ID\`) before running this wrapper." >&2
  exit 1
} || true

if [ -z "${APPWRITE_STAGING_API_KEY:-}" ]; then
  echo "ERROR: APPWRITE_STAGING_API_KEY is not set. Export it before running this wrapper." >&2
  exit 1
fi

echo "→ appwrite (STAGING project $STAGING_PROJECT_ID) $*"

APPWRITE_ENDPOINT="$STAGING_ENDPOINT" \
APPWRITE_PROJECT="$STAGING_PROJECT_ID" \
APPWRITE_KEY="$APPWRITE_STAGING_API_KEY" \
  appwrite "$@"
