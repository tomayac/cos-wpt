#!/usr/bin/env bash
#
# Sets up the two mirror origins that serve HTTPS_REMOTE_ORIGIN and
# HTTPS_NOTSAMESITE_ORIGIN for the cross-origin tests.
#
# GitHub has no API for creating an organisation, so create the two orgs first
# at https://github.com/organizations/new (the free plan is enough). Everything
# after that is automated here.
#
# The mirrors pull rather than being pushed to: each holds nothing but a
# workflow that checks this (public) repository out and publishes it to Pages.
# That needs no deploy key and no personal access token, and leaves nothing to
# drift out of sync.
#
# Usage: tools/setup-mirrors.sh [remote-org] [alt-org]

set -euo pipefail

REMOTE_ORG="${1:-cos-wpt-remote}"
ALT_ORG="${2:-cos-wpt-alt}"
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
EOF

  cat > "$work/README.md" <<EOF
# $org.github.io

A cross-origin mirror of [$SOURCE_REPO](https://github.com/$SOURCE_REPO), which
runs the Cross-Origin Storage web platform tests.

Those tests need origins other than the one serving the runner —
\`HTTPS_REMOTE_ORIGIN\` and \`HTTPS_NOTSAMESITE_ORIGIN\` — and a GitHub account
gets one origin. Hence this organisation, whose only purpose is to be a
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

  if gh api "repos/$repo/pages" >/dev/null 2>&1; then
    gh api -X PUT "repos/$repo/pages" -f build_type=workflow >/dev/null
  else
    gh api -X POST "repos/$repo/pages" -f build_type=workflow >/dev/null
  fi
  echo "  Pages set to build from the workflow"

  gh workflow run sync.yml --repo "$repo" >/dev/null 2>&1 || true
  rm -rf "$work"
}

setup_mirror "$REMOTE_ORG"
setup_mirror "$ALT_ORG"

say 'Waiting for both mirrors to answer'
for org in "$REMOTE_ORG" "$ALT_ORG"; do
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
The runner already defaults to these two origins. Open

  https://tomayac.github.io/cos-wpt/

and the cross-origin tests should go from "unrunnable" to running. If you used
organisation names other than the defaults, set them in the runner's Settings
panel, or pass them as query parameters:

  https://tomayac.github.io/cos-wpt/?remote=https://$REMOTE_ORG.github.io&notsamesite=https://$ALT_ORG.github.io
EOF
