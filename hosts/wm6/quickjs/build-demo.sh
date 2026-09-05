#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../../.." && pwd)"
bundle="${repo_root}/dist/hero-main.js"
pak="${repo_root}/dist/hero-main.pak"
output="${1:-${script_dir}/../vs2005/prebuilt/PocketJS.WM6.Demo.js}"
pak_output="${output%.*}.pak"

if [[ ! -f "$bundle" || ! -f "$pak" ]]; then
    echo "Missing Hero bundle or pak; run: bun tools/build.ts hero-main" >&2
    exit 2
fi
mkdir -p "$(dirname "$output")"
{
    printf '%s\n' '/* PocketJS WM6 native Rust core + real apps/hero bundle. */'
    sed -n 'p' "$bundle"
} > "$output"
cp "$pak" "$pak_output"
echo "Built ${output} and ${pak_output}"
