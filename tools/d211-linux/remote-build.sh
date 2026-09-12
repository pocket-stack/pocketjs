#!/usr/bin/env bash
#
# One-command rebuild from macOS: sync the checkout to a canonical builder,
# build there with the Luban toolchain, and bring the artifacts back.
#
#   D211_REMOTE=user@host tools/d211-linux/remote-build.sh
#   D211_REMOTE=user@host D211_REMOTE_PORT=2222 tools/d211-linux/remote-build.sh
#
# D211_REMOTE is required. D211_REMOTE_PORT is optional and only needed when
# the builder does not listen on the SSH default. GNU rsync is required on
# macOS (`brew install rsync`). The remote tree is the build mirror of this
# checkout; --delete only ever touches that tree (dist/, .pocket/,
# .pocket-build/, node_modules/ are excluded and preserved).

set -euo pipefail

: "${D211_REMOTE:?set D211_REMOTE to the builder SSH target (user@host)}"
remote="$D211_REMOTE"
ssh_port=""
if [[ -n "${D211_REMOTE_PORT:-}" ]]; then
  ssh_port="-p $D211_REMOTE_PORT"
fi

# The port flag is intentionally word-split; it is empty or "-p <port>".
remote_home="$(ssh $ssh_port "$remote" 'printf %s "$HOME"')"
remote_repository="${D211_REMOTE_REPOSITORY:-$remote_home/pocketjs}"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "d211: syncing $root -> $remote:$remote_repository"
rsync -az --delete \
  --exclude node_modules \
  --exclude .pocket \
  --exclude dist \
  --exclude .pocket-build \
  -e "ssh $ssh_port" \
  "$root/" "$remote:$remote_repository/"

echo "d211: building on $remote"
ssh $ssh_port "$remote" \
  "bash -lc 'cd $remote_repository && export PATH=\$HOME/.bun/bin:\$PATH && bun tools/d211-linux.ts build'"

mkdir -p "$root/dist/d211-linux"
echo "d211: fetching artifacts"
rsync -az \
  -e "ssh $ssh_port" \
  "$remote:$remote_repository/dist/d211-linux/" "$root/dist/d211-linux/"

echo "d211: artifacts in $root/dist/d211-linux"
ls -l "$root/dist/d211-linux"
