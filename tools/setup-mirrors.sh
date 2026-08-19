#!/usr/bin/env bash
#
# Sets up the two mirror origins that serve HTTPS_REMOTE_ORIGIN and
# HTTPS_NOTSAMESITE_ORIGIN for the cross-origin tests.
#
# GitHub has no API for creating an organisation, so create the two orgs first
# at https://github.com/organizations/new (the free plan is enough). Everything
# after that is automated here: the <org>.github.io repositories, a write
# deploy key per mirror so the sync workflow needs no personal access token,
# the initial push, and Pages itself.
#
# Usage: tools/setup-mirrors.sh [remote-org] [alt-org]

set -euo pipefail

REMOTE_ORG="${1:-cos-wpt-remote}"
ALT_ORG="${2:-cos-wpt-alt}"
SOURCE_REPO="${SOURCE_REPO:-tomayac/cos-wpt}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v gh >/dev/null || die 'gh is not installed'
gh auth status >/dev/null 2>&1 || die 'gh is not authenticated'

setup_mirror() {
  local org="$1" secret="$2" repo="$1/$1.github.io"

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

  # A write deploy key is scoped to this one repository, so the sync workflow
  # never needs a personal access token.
  local keydir key
  keydir="$(mktemp -d)"
  key="$keydir/id_ed25519"
  ssh-keygen -t ed25519 -N '' -C "cos-wpt-mirror-$org" -f "$key" >/dev/null

  for id in $(gh api "repos/$repo/keys" --jq ".[] | select(.title == \"cos-wpt sync\") | .id"); do
    gh api -X DELETE "repos/$repo/keys/$id" >/dev/null
  done
  gh api -X POST "repos/$repo/keys" \
    -f title='cos-wpt sync' -f "key=$(cat "$key.pub")" -F read_only=false >/dev/null
  gh secret set "$secret" --repo "$SOURCE_REPO" < "$key" >/dev/null
  echo "  deploy key installed, private half stored as $secret on $SOURCE_REPO"

  # The mirror is the site without its workflows: it is a plain static copy,
  # and running this repository's deploy/mirror workflows there would only
  # confuse things.
  local work
  work="$(mktemp -d)"
  git -C "$ROOT" archive HEAD | tar -x -C "$work"
  rm -rf "$work/.github" "$work/tools"
  (
    cd "$work"
    git init -q -b main
    git config user.name 'cos-wpt mirror'
    git config user.email 'cos-wpt@users.noreply.github.com'
    git add -A
    git commit -q -m "Mirror of $SOURCE_REPO"
    GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
      git push -q --force "git@github.com:$repo.git" main
  )
  echo "  pushed the site"

  if gh api "repos/$repo/pages" >/dev/null 2>&1; then
    gh api -X PUT "repos/$repo/pages" -f build_type=legacy \
      -f 'source[branch]=main' -f 'source[path]=/' >/dev/null
  else
    gh api -X POST "repos/$repo/pages" \
      -f 'source[branch]=main' -f 'source[path]=/' >/dev/null
  fi
  echo "  Pages enabled at https://$org.github.io/"

  rm -rf "$keydir" "$work"
}

setup_mirror "$REMOTE_ORG" MIRROR_KEY_REMOTE
setup_mirror "$ALT_ORG" MIRROR_KEY_ALT

say 'Waiting for both mirrors to answer'
for org in "$REMOTE_ORG" "$ALT_ORG"; do
  for attempt in $(seq 1 40); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "https://$org.github.io/sw.js")"
    if [ "$code" = 200 ]; then
      echo "  https://$org.github.io/sw.js -> 200"
      break
    fi
    [ "$attempt" = 40 ] && echo "  https://$org.github.io/sw.js -> $code (still building; Pages can take a few minutes)"
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
