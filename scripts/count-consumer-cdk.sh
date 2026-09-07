#!/usr/bin/env bash
#
# Measures acceptance criterion A3 in plan.md: "<= 60 non-import CDK lines for
# four stacks". Counts infra/bin/app.ts plus infra/lib/*.ts if that directory
# exists — today it does not (the app is one file), so the glob for infra/lib
# must degrade silently to nothing rather than counting a literal
# "infra/lib/*.ts" or erroring under set -u.
#
# Excluded, and why:
#   - blank lines: whitespace a consumer never had to type
#   - import lines: the criterion says "non-import" — wiring, not the CDK a
#     consumer authors
#   - comment lines (//, /*, */, and * continuation lines): A3 measures how
#     much CDK a consumer has to *write*, and this repo's infra/bin/app.ts is
#     heavily commented on purpose. Counting that prose against the budget
#     would punish good documentation.
#
# So the exclusion never hides itself, this prints both numbers: the counted
# total (non-blank, non-import, non-comment) and, for reference, the raw
# non-blank line count.
#
# Usage:
#   scripts/count-consumer-cdk.sh [--target <n>]
#
# Exits 0 when the counted total is <= target (60 by default), 1 otherwise.
#
# Must run under both bash 3.2 (macOS /bin/bash) and bash 5, like
# verify-preview.sh: no associative arrays, no mapfile, no ${var@U}.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET=60

usage() {
  echo "Usage: $0 [--target <n>]" >&2
  echo "  Counts non-blank, non-import, non-comment lines in infra/bin/app.ts" >&2
  echo "  plus infra/lib/*.ts (if that directory exists), and exits 0 only" >&2
  echo "  if the total is <= target (default 60)." >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      shift
      [ $# -gt 0 ] || usage
      TARGET="$1"
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

case "$TARGET" in
  ''|*[!0-9]*) echo "--target must be a non-negative integer, got: $TARGET" >&2; exit 2 ;;
esac

# count_file FILE
# Prints "counted raw" — counted is non-blank/non-import/non-comment lines,
# raw is all non-blank lines (comments included), for the reference line.
count_file() {
  awk '
    {
      line = $0
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line == "") next
      raw++
      if (line ~ /^import /) next
      if (line ~ /^\/\//) next
      if (line ~ /^\/\*/) next
      if (line ~ /^\*/) next
      counted++
    }
    END { printf "%d %d\n", counted + 0, raw + 0 }
  ' "$1"
}

FILES=()
if [ -f "$ROOT_DIR/infra/bin/app.ts" ]; then
  FILES+=("$ROOT_DIR/infra/bin/app.ts")
fi

if [ -d "$ROOT_DIR/infra/lib" ]; then
  for f in "$ROOT_DIR/infra/lib"/*.ts; do
    [ -e "$f" ] || continue
    FILES+=("$f")
  done
fi

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No infra files found under $ROOT_DIR/infra" >&2
  exit 2
fi

TOTAL_COUNTED=0
TOTAL_RAW=0

for f in "${FILES[@]}"; do
  result="$(count_file "$f")"
  c="${result%% *}"
  r="${result##* }"
  rel="${f#"$ROOT_DIR"/}"
  printf '%-40s %s\n' "$rel" "$c"
  TOTAL_COUNTED=$((TOTAL_COUNTED + c))
  TOTAL_RAW=$((TOTAL_RAW + r))
done

echo "---"
printf '%-40s %s\n' "total (non-blank, non-import, non-comment)" "$TOTAL_COUNTED"
echo "(for reference: $TOTAL_RAW non-blank lines, $TARGET line target)"

if [ "$TOTAL_COUNTED" -le "$TARGET" ]; then
  echo "PASS: $TOTAL_COUNTED <= $TARGET"
  exit 0
else
  echo "FAIL: $TOTAL_COUNTED > $TARGET"
  exit 1
fi
