#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
bundle="${repo_root}/dist/cards-main.js"
output="${1:-${script_dir}/../vs2005/prebuilt/PocketJS.WM6.Cards.js}"

if [[ ! -f "$bundle" ]]; then
    echo "Missing dist/cards-main.js; run: bun tools/build.ts cards-main" >&2
    exit 2
fi
mkdir -p "$(dirname "$output")"
{
    printf '%s\n' '/* PocketJS WM6 bootstrap + real apps/cards bundle. */'
    sed -n 'p' "${script_dir}/cards-host.js"
    sed -n 'p' "$bundle"
} > "$output"
echo "Built ${output}"
