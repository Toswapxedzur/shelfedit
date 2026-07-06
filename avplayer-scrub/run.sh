#!/usr/bin/env bash
set -euo pipefail

orig_pwd="$(pwd)"
cd "$(dirname "$0")"

if [[ $# -eq 0 ]]; then
  swift run -c release AVPlayerScrub
  exit 0
fi

first="$1"
shift
if [[ -e "${orig_pwd}/${first}" ]]; then
  first="${orig_pwd}/${first}"
fi

swift run -c release AVPlayerScrub "${first}" "$@"
