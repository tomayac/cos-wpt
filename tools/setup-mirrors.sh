#!/usr/bin/env bash
#
# Sets up the mirror origins the cross-origin tests run on: one each for
# HTTPS_REMOTE_ORIGIN, HTTPS_NOTSAMESITE_ORIGIN, and HTTPS_ORIGIN, the test's
# own origin, every one of them served from an origin root.
#
# GitHub has no API for creating an organisation, so create the orgs first
# at https://github.com/organizations/new (the free plan is enough). Everything
# after that is automated here.
#
# The mirrors pull rather than being pushed to: each holds nothing but a
# workflow that checks this (public) repository out and publishes it to Pages.
# That needs no deploy key and no personal access token, and leaves nothing to
# drift out of sync.
#
# Usage: tools/setup-mirrors.sh [org ...]
#   With no arguments, sets up cos-wpt-remote, cos-wpt-alt, and cos-wpt-self.
#   Name orgs to set up only those, such as a newly created one.

set -euo pipefail

if [ "$#" -gt 0 ]; then
  ORGS=("$@")
else
  ORGS=(cos-wpt-remote cos-wpt-alt cos-wpt-self)
fi
SOURCE_REPO="${SOURCE_REPO:-tomayac/cos-wpt}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die 'gh is not installed'
gh auth status >/dev/null 2>&1 || die 'gh is not authenticated'

setup_mirror() {
  local org="$1" repo="$1/$1.github.io"

  say "Mirror $org"

  gh api "orgs/$org" >/dev/null 2>&1 || die \
    "The organisation '$org' does not exist. Create it at
    https://github.com/organizations/new (free plan), then run this again."

  if gh api "repos/$repo" >/dev/null 2>&1; then
    echo "  repository $repo already exists"
  else
    gh repo create "$repo" --public \
      --description "Cross-origin mirror for $SOURCE_REPO — serves the COS web platform tests from this origin's root" \
      >/dev/null
    echo "  created $repo"
  fi

  local work
  work="$(mktemp -d)"
  mkdir -p "$work/.github/workflows"

  cat > "$work/.github/workflows/sync.yml" <<EOF
# This repository exists only to give $SOURCE_REPO a second origin, which its
# cross-origin tests need. It holds no copy of the site: every run publishes
# the source repository as it stands.
name: Publish the cos-wpt site

on:
  push:
    branches: [main]
  schedule:
    - cron: '23 * * * *'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
        with:
          repository: $SOURCE_REPO
      - name: Drop the source repository's own workflows and tooling
        run: rm -rf .github tools
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - id: deployment
        uses: actions/deploy-pages@v4

  # GitHub disables a scheduled workflow after 60 days without activity in its
  # repository, and this repository never changes on its own. An empty commit
  # once the newest one is 30 days old keeps the hourly publish running.
  keepalive:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - name: Commit if this repository has been quiet for 30 days
        run: |
          age=\$(( \$(date +%s) - \$(git log -1 --format=%ct) ))
          if [ "\$age" -lt \$(( 30 * 24 * 60 * 60 )) ]; then
            echo "The newest commit is \$(( age / 86400 )) days old; nothing to do."
            exit 0
          fi
          git config user.name 'github-actions[bot]'
          git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
          git commit --allow-empty -m 'Keep the scheduled publish workflow active'
          git push
EOF

  cat > "$work/README.md" <<EOF
# $org.github.io

A cross-origin mirror of [$SOURCE_REPO](https://github.com/$SOURCE_REPO), which
runs the Cross-Origin Storage web platform tests.

Those tests need origins other than the one serving the runner —
\`HTTPS_REMOTE_ORIGIN\`, \`HTTPS_NOTSAMESITE_ORIGIN\`, and a root-scoped
\`HTTPS_ORIGIN\` — and a GitHub account gets one origin. Hence this organisation, whose only purpose is to be a
different one. Serving from an organisation site rather than a project page
matters too: only a service worker scoped at \`/\` can answer the root-absolute
paths a couple of the tests hard-code.

This repository holds no copy of the site. [\`sync.yml\`](.github/workflows/sync.yml)
publishes the source repository directly, hourly and on demand.
EOF

  (
    cd "$work"
    git init -q -b main
    git config user.name 'cos-wpt'
    git config user.email 'cos-wpt@users.noreply.github.com'
    git add -A
    git commit -q -m "Publish the cos-wpt site from $SOURCE_REPO"
    git push -q --force "https://github.com/$repo.git" main
  )
  echo "  pushed the publishing workflow"

  # A push can enable Pages on its own between the check and the create, so
  # a create that finds it enabled updates it instead.
  if gh api "repos/$repo/pages" >/dev/null 2>&1; then
    gh api -X PUT "repos/$repo/pages" -f build_type=workflow >/dev/null
  else
    gh api -X POST "repos/$repo/pages" -f build_type=workflow >/dev/null 2>&1 ||
      gh api -X PUT "repos/$repo/pages" -f build_type=workflow >/dev/null
  fi
  echo "  Pages set to build from the workflow"

  # Enabling Pages on a repository that has just been pushed to also kicks off
  # a legacy Jekyll build, which can land after the workflow's deployment and
  # replace the site with a rendered README. Dispatch the real workflow last and
  # wait for it, so it is unambiguously the deployment that wins.
  sleep 5
  gh workflow run sync.yml --repo "$repo" >/dev/null 2>&1 || true
  echo -n '  publishing'
  for _ in $(seq 1 60); do
    sleep 10
    local status
    status="$(gh run list --repo "$repo" --workflow sync.yml --limit 1 \
      --json status,conclusion --jq '.[0].status + "/" + (.[0].conclusion // "-")' 2>/dev/null || echo '')"
    echo -n '.'
    case "$status" in
      completed/success) echo ' done'; break ;;
      completed/*) echo " run finished $status — see https://github.com/$repo/actions"; break ;;
    esac
  done

  rm -rf "$work"
}

for org in "${ORGS[@]}"; do setup_mirror "$org"; done

say 'Waiting for the mirrors to answer'
for org in "${ORGS[@]}"; do
  for attempt in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "https://$org.github.io/sw.js")"
    if [ "$code" = 200 ]; then
      echo "  https://$org.github.io/sw.js -> 200"
      break
    fi
    if [ "$attempt" = 40 ]; then
      echo "  https://$org.github.io/sw.js -> $code (check the run at https://github.com/$org/$org.github.io/actions)"
    fi
    sleep 15
  done
done

say 'Done'
cat <<EOF
The runner already defaults to cos-wpt-remote, cos-wpt-alt, and cos-wpt-self.
Open

  https://tomayac.github.io/cos-wpt/

and the cross-origin tests should go from "unrunnable" to running. If you used
organisation names other than the defaults, set them in the runner's Settings
panel, or pass them as the remote=, notsamesite=, and self= query parameters.
EOF
