#!/usr/bin/env bash
# Rebuilds the checked-in Windows helper (prebuilt/win32-x64/) from this source,
# cross-compiled on Linux. Reproducible: the same toolchain gives the same bytes
# (paths are remapped, the PE timestamp is left out, dependencies are --locked).
#
# Needs: rustup with the x86_64-pc-windows-gnu target and the mingw-w64 linker
#   rustup target add x86_64-pc-windows-gnu
#   sudo apt-get install gcc-mingw-w64-x86-64      (Debian/Ubuntu)
#
#   ./build-windows.sh           rebuild, update prebuilt/ and the checksum
#   ./build-windows.sh --check   rebuild into a temporary folder and compare
#                                with the checked-in binary (exit 1 if different)
#
# See docs/adr/0005-sensor-relay.md ("Packaging") for why the binary is committed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"
target=x86_64-pc-windows-gnu
name=freilauf-sensor-relay.exe
out="$here/prebuilt/win32-x64"
check=0
[[ "${1:-}" == "--check" ]] && check=1

target_dir="$here/target"
if (( check )); then
  target_dir="$(mktemp -d)"
  trap 'rm -rf "$target_dir"' EXIT
fi

cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$here=/src -C link-arg=-Wl,--no-insert-timestamp"
export SOURCE_DATE_EPOCH=0
cargo build --release --locked --target "$target" --target-dir "$target_dir"
built="$target_dir/$target/release/$name"

sum="$(sha256sum "$built" | cut -d' ' -f1)"
if (( check )); then
  want="$(cut -d' ' -f1 "$out/$name.sha256")"
  if [[ "$sum" == "$want" ]]; then
    echo "reproduced: $sum"
    exit 0
  fi
  echo "different: built $sum, checked in $want" >&2
  exit 1
fi

mkdir -p "$out"
cp "$built" "$out/$name"
echo "$sum  $name" > "$out/$name.sha256"
{
  echo "freilauf-sensor-relay $(grep -m1 '^version' Cargo.toml | cut -d'"' -f2), built by build-windows.sh"
  echo "sha256: $sum"
  echo "bytes: $(stat -c %s "$out/$name")"
  echo "rustc: $(rustc -V)"
  echo "cargo: $(cargo -V)"
  echo "linker: $(x86_64-w64-mingw32-gcc --version | head -1)"
  echo "binutils: $(x86_64-w64-mingw32-ld --version | head -1)"
  echo "target: $target"
} > "$out/BUILDINFO.txt"
cat "$out/BUILDINFO.txt"
