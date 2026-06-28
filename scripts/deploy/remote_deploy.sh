#!/usr/bin/env bash
# Runs ON the prod EC2 box, invoked over SSM by the pipeline's Deploy stage.
# Arg $1 = directory containing the freshly-extracted build (source + compiled dist).
#
# Responsibilities:
#   1. Snapshot the current app for rollback (excludes node_modules).
#   2. Sync the new release into the live app dir, PRESERVING .env, .env.*, the
#      server-only *_private.pem keys, node_modules, and the .git checkout.
#   3. Reinstall production deps and reload pm2.
#   4. Health-check /healthz; non-zero exit => SSM command fails => pipeline red.
set -euo pipefail

RELEASE_DIR="${1:?usage: remote_deploy.sh <release_dir>}"
APP_DIR=/home/ubuntu/medsys-api-enterprise
APP_NAME=medlink-api

echo "[remote_deploy] release=$RELEASE_DIR app=$APP_DIR"

# 1. Rollback snapshot (keep last 3, exclude node_modules to save disk).
if [ -d "$APP_DIR" ]; then
  ts=$(date +%Y%m%d-%H%M%S)
  tar czf "/home/ubuntu/medlink-backup-${ts}.tar.gz" \
    --exclude='node_modules' --exclude='.git' \
    -C /home/ubuntu medsys-api-enterprise 2>/dev/null || true
  ls -1t /home/ubuntu/medlink-backup-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
fi

# 2. Sync new release in, protecting runtime-only files from overwrite/delete.
echo "[remote_deploy] syncing files (preserving .env / *.pem / node_modules / .git)"
rsync -a --delete \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='node_modules' \
  --exclude='*_private.pem' \
  --exclude='.git' \
  "$RELEASE_DIR"/ "$APP_DIR"/

chown -R ubuntu:ubuntu "$APP_DIR"

# 3. Production deps + reload.
echo "[remote_deploy] npm ci --omit=dev"
sudo -u ubuntu bash -lc "cd '$APP_DIR' && npm ci --omit=dev"

echo "[remote_deploy] pm2 reload $APP_NAME"
sudo -u ubuntu bash -lc "cd '$APP_DIR' && (pm2 reload '$APP_NAME' --update-env || pm2 restart '$APP_NAME')"
sudo -u ubuntu bash -lc "pm2 save" || true

# 4. Health check.
echo "[remote_deploy] health check http://localhost:3000/healthz"
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3000/healthz || echo 000)
  if [ "$code" = "200" ]; then
    echo "[remote_deploy] healthy on attempt ${i}"
    exit 0
  fi
  echo "  attempt ${i}/12: HTTP ${code} - retrying in 5s"
  sleep 5
done

echo "[remote_deploy] HEALTH CHECK FAILED"
exit 1
