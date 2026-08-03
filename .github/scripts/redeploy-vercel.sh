#!/usr/bin/env bash

set -euo pipefail

write_status() {
  printf 'VERCEL_REDEPLOY_STATUS=%s\n' "$1" >> "$GITHUB_ENV"
}

is_nonblank() {
  local value="${1//[[:space:]]/}"
  [ -n "$value" ]
}

is_success_status() {
  case "$1" in
    2??) return 0 ;;
    *) return 1 ;;
  esac
}

temporary_directory="$(mktemp -d)"
response_file="${temporary_directory}/response.json"
trap 'rm -rf "$temporary_directory"' EXIT

hook_failure=""
if is_nonblank "${VERCEL_DEPLOY_HOOK_URL:-}"; then
  echo "Triggering the Vercel deploy hook..."
  : > "$response_file"
  hook_http="000"
  if hook_http="$(curl -sS -o "$response_file" -w '%{http_code}' --max-time 60 \
    -X POST "$VERCEL_DEPLOY_HOOK_URL" 2>/dev/null)"; then
    :
  else
    hook_http="000"
  fi

  if is_success_status "$hook_http"; then
    echo "Vercel deploy hook accepted the request (HTTP ${hook_http})."
    write_status "triggered via deploy hook (HTTP ${hook_http})"
    exit 0
  fi

  if [ "$hook_http" = "000" ]; then
    hook_failure="deploy hook network error"
    echo "::warning::Vercel deploy hook network error. Trying the API fallback."
  else
    hook_failure="deploy hook HTTP ${hook_http}"
    echo "::warning::Vercel deploy hook failed (HTTP ${hook_http}). Trying the API fallback."
  fi
fi

if ! is_nonblank "${VERCEL_TOKEN:-}" || ! is_nonblank "${VERCEL_PROJECT_ID:-}"; then
  echo "::warning::VERCEL_TOKEN and/or VERCEL_PROJECT_ID not set; API fallback is unavailable."
  if [ -n "$hook_failure" ]; then
    write_status "failed: ${hook_failure}; API fallback unavailable (missing VERCEL_TOKEN or VERCEL_PROJECT_ID)"
  else
    write_status "skipped: no deploy hook and missing API credentials"
  fi
  exit 0
fi

api_base="https://api.vercel.com"
team_q=""
if is_nonblank "${VERCEL_TEAM_ID:-}"; then
  team_q="?teamId=${VERCEL_TEAM_ID}"
fi
auth_header="Authorization: Bearer ${VERCEL_TOKEN}"
target_sha="$(printf '%s' "$BASELINE_SHA" | tr '[:upper:]' '[:lower:]')"
list_url="${api_base}/v6/deployments?projectId=${VERCEL_PROJECT_ID}&limit=100"
if is_nonblank "${VERCEL_TEAM_ID:-}"; then
  list_url="${list_url}&teamId=${VERCEL_TEAM_ID}"
fi

echo "Looking for a READY Vercel deployment at commit ${target_sha}..."
: > "$response_file"
list_http="000"
if list_http="$(curl -sS -o "$response_file" -w '%{http_code}' --max-time 30 \
  -H "$auth_header" "$list_url" 2>/dev/null)"; then
  :
else
  list_http="000"
fi

if ! is_success_status "$list_http"; then
  echo "::warning::Vercel deployment list failed (HTTP ${list_http}). Wait-for-health will still gate migrate/ops."
  write_status "failed: API deployment list HTTP ${list_http}"
  exit 0
fi

deployment_id=""
if command -v jq >/dev/null 2>&1; then
  deployment_id="$(jq -r --arg sha "$target_sha" '
    first(
      .deployments[]?
      | select(.state == "READY")
      | select(
          ((.meta.githubCommitSha // .meta.gitCommitSha // .meta.commitSha // "") | ascii_downcase) == $sha
          or ((.gitSource.sha // "") | ascii_downcase) == $sha
        )
      | (.uid // .id)
    ) // empty
  ' < "$response_file" 2>/dev/null || true)"
fi

redeploy_http="000"
if [ -n "$deployment_id" ] && [ "$deployment_id" != "null" ]; then
  echo "Found READY deployment ${deployment_id}; requesting production redeploy..."
  redeploy_url="${api_base}/v13/deployments/${deployment_id}/redeploy${team_q}"
  : > "$response_file"
  if redeploy_http="$(curl -sS -o "$response_file" -w '%{http_code}' --max-time 60 \
    -X POST "$redeploy_url" \
    -H "$auth_header" \
    -H "Content-Type: application/json" \
    -d '{"target":"production"}' 2>/dev/null)"; then
    :
  else
    redeploy_http="000"
  fi

  if [ "$redeploy_http" = "404" ] || [ "$redeploy_http" = "405" ]; then
    echo "Redeploy sub-resource unavailable (HTTP ${redeploy_http}); using create-deployment redeploy..."
    create_query="forceNew=1"
    if is_nonblank "${VERCEL_TEAM_ID:-}"; then
      create_query="${create_query}&teamId=${VERCEL_TEAM_ID}"
    fi
    payload="$(jq -n \
      --arg project "$VERCEL_PROJECT_ID" \
      --arg deployment "$deployment_id" \
      '{ name: $project, project: $project, deploymentId: $deployment, target: "production" }')"
    : > "$response_file"
    if redeploy_http="$(curl -sS -o "$response_file" -w '%{http_code}' --max-time 60 \
      -X POST "${api_base}/v13/deployments?${create_query}" \
      -H "$auth_header" \
      -H "Content-Type: application/json" \
      -d "$payload" 2>/dev/null)"; then
      :
    else
      redeploy_http="000"
    fi
  fi
else
  echo "No READY deployment found for ${target_sha}."
  repository="$GITHUB_REPOSITORY"
  organization="${repository%%/*}"
  repository_name="${repository#*/}"
  echo "Creating a production deployment from gitSource (org=${organization}, repo=${repository_name}, sha=${BASELINE_SHA})..."
  create_query="forceNew=1"
  if is_nonblank "${VERCEL_TEAM_ID:-}"; then
    create_query="${create_query}&teamId=${VERCEL_TEAM_ID}"
  fi
  payload="$(jq -n \
    --arg project "$VERCEL_PROJECT_ID" \
    --arg organization "$organization" \
    --arg repository "$repository_name" \
    --arg sha "$BASELINE_SHA" \
    '{
      name: $project,
      project: $project,
      target: "production",
      gitSource: {
        type: "github",
        org: $organization,
        repo: $repository,
        ref: "main",
        sha: $sha
      }
    }')"
  : > "$response_file"
  if redeploy_http="$(curl -sS -o "$response_file" -w '%{http_code}' --max-time 60 \
    -X POST "${api_base}/v13/deployments?${create_query}" \
    -H "$auth_header" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null)"; then
    :
  else
    redeploy_http="000"
  fi
fi

if is_success_status "$redeploy_http"; then
  new_deployment_id=""
  if command -v jq >/dev/null 2>&1; then
    new_deployment_id="$(jq -r '.id // .uid // empty' < "$response_file" 2>/dev/null || true)"
  fi
  if [ -n "$new_deployment_id" ]; then
    write_status "triggered via API redeploy (HTTP ${redeploy_http}, deployment ${new_deployment_id})"
  else
    write_status "triggered via API redeploy (HTTP ${redeploy_http})"
  fi
else
  echo "::warning::Vercel production redeploy request failed (HTTP ${redeploy_http}). Wait-for-health will still gate migrate/ops."
  write_status "failed: API redeploy HTTP ${redeploy_http}"
fi
