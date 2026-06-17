#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

log() {
  printf '[deploy-local] %s\n' "$*"
}

ensure_env_file() {
  if [[ -n "${MY_AGENT_ENV_FILE:-}" ]]; then
    log "Writing .env from MY_AGENT_ENV_FILE."
    printf '%s\n' "$MY_AGENT_ENV_FILE" > .env
    chmod 600 .env
    return
  fi

  if [[ -n "${MY_AGENT_ENV_SOURCE:-}" && -f "$MY_AGENT_ENV_SOURCE" ]]; then
    log "Copying .env from MY_AGENT_ENV_SOURCE."
    cp "$MY_AGENT_ENV_SOURCE" .env
    chmod 600 .env
    return
  fi

  local branch_env_source="/Users/shenzhengyang/workspace/my-agent/.env.${GITHUB_REF_NAME:-}"
  if [[ "$repo_root" != "/Users/shenzhengyang/workspace/my-agent" && -n "${GITHUB_REF_NAME:-}" && -f "$branch_env_source" ]]; then
    log "Copying .env from the local ${GITHUB_REF_NAME} environment file."
    cp "$branch_env_source" .env
    chmod 600 .env
    return
  fi

  local default_env_source="/Users/shenzhengyang/workspace/my-agent/.env"
  if [[ "$repo_root" != "/Users/shenzhengyang/workspace/my-agent" && -f "$default_env_source" ]]; then
    log "Copying .env from the local workspace."
    cp "$default_env_source" .env
    chmod 600 .env
    return
  fi

  if [[ -f .env ]]; then
    return
  fi

  log ".env is missing. Set MY_AGENT_ENV_FILE, MY_AGENT_ENV_SOURCE, or create .env on the runner."
  exit 1
}

read_app_port() {
  local port="${APP_PORT:-}"

  if [[ -z "$port" && -f .env ]]; then
    port="$(grep -E '^APP_PORT=' .env | tail -n 1 | cut -d '=' -f 2- | tr -d '[:space:]' | tr -d '"' | tr -d "'")"
  fi

  printf '%s\n' "${port:-3000}"
}

ensure_env_file

log "Building and starting Docker Compose services."
docker compose up -d --build --remove-orphans

app_port="$(read_app_port)"
attempts="${DEPLOY_SMOKE_ATTEMPTS:-30}"

log "Waiting for http://127.0.0.1:${app_port}/."
for attempt in $(seq 1 "$attempts"); do
  if curl -fsS "http://127.0.0.1:${app_port}/" >/dev/null; then
    log "Deployment is reachable on port ${app_port}."
    exit 0
  fi

  log "Smoke check attempt ${attempt}/${attempts} failed; retrying."
  sleep 2
done

log "Deployment did not become reachable. Recent web logs:"
docker compose logs --tail=160 web
exit 1
