#!/bin/bash

set -euo pipefail

# Load secrets from .env (gitignored). Copy .env.example to .env and fill in values.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -o allexport
  # shellcheck source=.env
  source "$SCRIPT_DIR/.env"
  set +o allexport
else
  echo "ERROR: .env file not found. Copy .env.example to .env and fill in your values." >&2
  exit 1
fi

# --- CONFIGURATION ---
REMOTE_HOST="${REMOTE_HOST}"
REMOTE_USER="${REMOTE_USER}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
REMOTE_TMP="${REMOTE_TMP:-/root/deploy-tmp}"
REMOTE_BACKEND_PATH="${REMOTE_BACKEND_PATH:-/usr/local/bin/messenger-backend}"
REMOTE_FRONTEND_PATH="${REMOTE_FRONTEND_PATH:-/var/www/weather}"

export CORS_ORIGIN="${CORS_ORIGIN}"
export BULLETIN_STORE_PATH="${BULLETIN_STORE_PATH:-/var/lib/messenger-backend/bulletins.json}"
export BULLETIN_TTL_MINUTES="${BULLETIN_TTL_MINUTES:-4320}"
export TURN_SHARED_SECRET="${TURN_SHARED_SECRET}"
export TURN_REALM="${TURN_REALM}"
export TURN_TTL_SECONDS="${TURN_TTL_SECONDS:-600}"
export TURN_URLS="${TURN_URLS:-}"

echo "Starting local build and deploy for black-sea.org..."

# --- 1. CLEANUP LOCAL ---
rm -rf ./dist-temp
mkdir -p ./dist-temp

# --- 2. BUILD BACKEND (Go) ---
echo "Building Go backend for Linux AMD64..."
pushd backend >/dev/null
GOOS=linux GOARCH=amd64 go build -o ../dist-temp/messenger-backend .
popd >/dev/null

# --- 3. BUILD FRONTEND (Node/Vite) ---
echo "Building frontend..."
pushd frontend >/dev/null
npm ci
npm run build
# Video assets under public/media are managed manually on the VM and are
# preserved server-side, so exclude them from deploy artifacts.
rm -rf dist/media
cp -r dist/. ../dist-temp/
popd >/dev/null

# --- 4. TRANSFER TO VPS ---
echo "Uploading build artifacts to VPS..."
ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" "mkdir -p '$REMOTE_TMP' '$REMOTE_FRONTEND_PATH'"
scp -i "$SSH_KEY" -r ./dist-temp/. "$REMOTE_USER@$REMOTE_HOST:$REMOTE_TMP/"

# --- 5. REMOTE PRODUCTION SWAP ---
echo "Installing artifacts and restarting services..."
ssh -i "$SSH_KEY" "$REMOTE_USER@$REMOTE_HOST" \
    "REMOTE_TMP='$REMOTE_TMP' REMOTE_BACKEND_PATH='$REMOTE_BACKEND_PATH' REMOTE_FRONTEND_PATH='$REMOTE_FRONTEND_PATH' CORS_ORIGIN='$CORS_ORIGIN' BULLETIN_STORE_PATH='$BULLETIN_STORE_PATH' BULLETIN_TTL_MINUTES='$BULLETIN_TTL_MINUTES' TURN_SHARED_SECRET='$TURN_SHARED_SECRET' TURN_REALM='$TURN_REALM' TURN_TTL_SECONDS='$TURN_TTL_SECONDS' TURN_URLS='$TURN_URLS' bash -s" <<'EOF'
set -euo pipefail

systemctl stop messenger-backend || true

mkdir -p /etc/systemd/system/messenger-backend.service.d
mkdir -p "$(dirname "$BULLETIN_STORE_PATH")"
printf '[Service]\nEnvironment="CORS_ORIGIN=%s"\n' "$CORS_ORIGIN" \
  > /etc/systemd/system/messenger-backend.service.d/cors.conf
printf '[Service]\nEnvironment="BULLETIN_STORE_PATH=%s"\nEnvironment="BULLETIN_TTL_MINUTES=%s"\n' "$BULLETIN_STORE_PATH" "$BULLETIN_TTL_MINUTES" \
  > /etc/systemd/system/messenger-backend.service.d/bulletin.conf
printf '[Service]\nEnvironment="TURN_SHARED_SECRET=%s"\nEnvironment="TURN_REALM=%s"\nEnvironment="TURN_TTL_SECONDS=%s"\nEnvironment="TURN_URLS=%s"\n' "$TURN_SHARED_SECRET" "$TURN_REALM" "$TURN_TTL_SECONDS" "$TURN_URLS" \
  > /etc/systemd/system/messenger-backend.service.d/turn.conf
systemctl daemon-reload

install -m 0755 "$REMOTE_TMP/messenger-backend" "$REMOTE_BACKEND_PATH"

find "$REMOTE_FRONTEND_PATH" -mindepth 1 -maxdepth 1 ! -name media -exec rm -rf {} +
cp -r "$REMOTE_TMP"/. "$REMOTE_FRONTEND_PATH"/
rm -f "$REMOTE_FRONTEND_PATH/messenger-backend"
rm -rf "$REMOTE_TMP"

systemctl start messenger-backend
systemctl reload nginx
curl --fail --silent http://127.0.0.1:8080/health >/dev/null

echo "Deployment successful."
EOF
