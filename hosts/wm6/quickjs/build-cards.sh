#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
bundle="${repo_root}/dist/cards-main.js"
pak="${repo_root}/dist/cards-main.pak"
output="${1:-${script_dir}/../vs2005/prebuilt/PocketJS.WM6.Cards.js}"
pak_output="${output%.*}.pak"

if [[ ! -f "$bundle" || ! -f "$pak" ]]; then
    echo "Missing Cards bundle or pak; run: bun tools/build.ts cards-main" >&2
    exit 2
fi
mkdir -p "$(dirname "$output")"
{
    printf '%s\n' '/* PocketJS WM6 bootstrap + real apps/cards bundle. */'
    sed -n 'p' "${script_dir}/cards-host.js"
    sed -n 'p' "$bundle"
} > "$output"
cp "$pak" "$pak_output"
echo "Built ${output} and ${pak_output}"
