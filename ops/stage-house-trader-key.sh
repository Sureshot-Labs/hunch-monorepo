#!/bin/bash
# Run as root on the Docker host. Reads one dedicated JSON bundle over stdin.
set -euo pipefail
umask 077
export LC_ALL=C

if [[ "$EUID" != 0 || "$#" != 0 || -t 0 ]]; then
  echo "Use sudo and pipe the dedicated House Trader JSON bundle on stdin" >&2
  exit 64
fi
command -v jq >/dev/null || { echo "jq is required" >&2; exit 69; }

stage_dir=/run/hunch-house-trader
target=/run/hunch-house-trader/key.json
if [[ -L "$stage_dir" || -L "$target" ]]; then
  echo "Refusing a symbolic link in the key staging path" >&2
  exit 65
fi
install -d -o 0 -g 0 -m 0700 -- "$stage_dir"
if [[ "$(stat -c '%u:%a' -- "$stage_dir")" != 0:700 ]]; then
  echo "Key staging directory is not root-only" >&2
  exit 65
fi
temporary="$(mktemp "$stage_dir/.incoming.XXXXXXXX")"
trap 'rm -f -- "$temporary"' EXIT

dd of="$temporary" bs=4097 count=1 iflag=fullblock status=none
if [[ "$(stat -c '%s' -- "$temporary")" -gt 4096 ]] ||
   ! jq -e -s '
     length == 1 and (.[0] | type == "object" and keys == ["HUNCH_HOUSE_TRADER_PRIVATE_KEY"] and
       (.HUNCH_HOUSE_TRADER_PRIVATE_KEY | type == "string" and test("^0x[0-9a-fA-F]{64}$")))
   ' "$temporary" >/dev/null 2>&1; then
  echo "Invalid House Trader key bundle; existing file unchanged" >&2
  exit 65
fi
chown 10001:10001 -- "$temporary"
chmod 0400 -- "$temporary"
mv -T -- "$temporary" "$target"
echo "House Trader key file staged (0400)"
