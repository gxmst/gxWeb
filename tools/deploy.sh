#!/bin/sh
# Run on the deployment host from its existing checkout.
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"
branch=${1:-main}
test -d .git
test -f .env || { printf '%s\n' 'Create the private server .env before deploying.' >&2; exit 1; }
test -z "$(git status --porcelain=v1 --untracked-files=no)" || {
    printf '%s\n' 'Tracked server changes must be preserved before deploying.' >&2
    exit 1
}
test "$(git branch --show-current)" = "$branch" || {
    printf '%s\n' 'Switch the checkout to the requested branch before deploying.' >&2
    exit 1
}
git pull --ff-only origin "$branch"
docker compose -p gxweb config --quiet
docker compose -p gxweb build
docker compose -p gxweb up -d
docker compose -p gxweb ps
git log -1 --format='Deployed commit: %H %s'
