#!/bin/bash
# Publish test totals, compiler warnings and wasm size as public notice annotations.
log=${1:-cargo.log}
res=$(grep -E '^test result:' "$log" | tr '\n' ' ')
[ -n "$res" ] && echo "::notice title=tests::$res"
w=$(grep -cE '^warning' "$log")
if [ "$w" -gt 0 ]; then
  msg=$(grep -A6 -E '^warning' "$log" | head -80 | sed 's/%/%25/g' | awk '{printf "%s%%0A", $0}')
  echo "::warning title=compiler warnings ($w)::$msg"
fi
for f in target/near/circuit/*.wasm; do [ -f "$f" ] && echo "::notice title=wasm::$(basename "$f") $(stat -c%s "$f") bytes sha256 $(sha256sum "$f" | cut -c1-16)"; done
exit 0
