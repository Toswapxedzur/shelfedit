#!/usr/bin/env bash
# Launch the native ShelfEdit slice. Run from a normal Terminal (not a sandboxed
# shell) so macOS presents the window on your active desktop.
#
#   ./run.sh            # build (release) + launch the GUI
#   ./run.sh --selftest # headless pipeline benchmark on your real footage
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release
exec ./target/release/shelfedit "$@"
