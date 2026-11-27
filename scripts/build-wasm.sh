#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
rustup run 1.85.1 cargo build --manifest-path "$ROOT/wasm/Cargo.toml" --target wasm32-unknown-unknown --release --locked
mkdir -p "$ROOT/public/wasm"
cp "$ROOT/wasm/target/wasm32-unknown-unknown/release/canokey_browser_wasm.wasm" "$ROOT/public/wasm/canokey.wasm"
