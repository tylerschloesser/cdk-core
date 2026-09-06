#!/usr/bin/env bash
#
# The one command a session runs to prove a deployed PR preview actually
# works end to end, through CloudFront. Pure curl — no AWS credentials, no
# AWS CLI. Must run under both bash 3.2 (macOS /bin/bash) and bash 5, so no
# associative arrays, no mapfile, no ${var@U}.
#
# Usage:
#   scripts/verify-preview.sh <pr-number> [--domain cdk-core.ty.ler.dev] [--expect-absent]
#
# With --expect-absent, checks 1-6 are expected to fail with 404 (the preview
# has been torn down) and the script exits 0 only if every one of them 404s.

set -euo pipefail

DOMAIN="cdk-core.ty.ler.dev"
PR=""
EXPECT_ABSENT=0

usage() {
  echo "Usage: $0 <pr-number> [--domain cdk-core.ty.ler.dev] [--expect-absent]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)
      shift
      [ $# -gt 0 ] || usage
      DOMAIN="$1"
      shift
      ;;
    --expect-absent)
      EXPECT_ABSENT=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      if [ -z "$PR" ]; then
        PR="$1"
        shift
      else
        usage
      fi
      ;;
  esac
done

[ -n "$PR" ] || usage
case "$PR" in
  ''|*[!0-9]*) echo "pr-number must be a positive integer, got: $PR" >&2; exit 2 ;;
esac

BASE="https://pr-${PR}.preview.${DOMAIN}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

SHA256_BIN=""
if command -v shasum >/dev/null 2>&1; then
  SHA256_BIN="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256_BIN="sha256sum"
else
  echo "FATAL: neither shasum nor sha256sum is available" >&2
  exit 2
fi

PASS_COUNT=0
FAIL_COUNT=0

# report NAME STATUS REASON
# STATUS is PASS or FAIL. Never exits; tallies and prints one line.
report() {
  name="$1"
  status="$2"
  reason="$3"
  if [ "$status" = "PASS" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  printf '%-4s %-28s %s\n' "$status" "$name" "$reason"
}

# In --expect-absent mode, checks 1-6 are supposed to 404. Wrap their normal
# PASS/FAIL so a 404 becomes the expected outcome and anything else fails.
expect_absent_report() {
  name="$1"
  http_code="$2"
  if [ "$EXPECT_ABSENT" = "1" ]; then
    if [ "$http_code" = "404" ]; then
      report "$name" "PASS" "torn down as expected (404)"
    else
      report "$name" "FAIL" "expected 404 (torn down), got $http_code"
    fi
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# 1. Assets: GET / -> 200, text/html, contains <div id="root"
# ---------------------------------------------------------------------------
check_assets() {
  name="assets (GET /)"
  body_file="$TMPDIR/assets_body"
  headers_file="$TMPDIR/assets_headers"
  http_code="$(curl -sS --max-time 20 -o "$body_file" -D "$headers_file" -w '%{http_code}' "$BASE/" || true)"
  http_code="${http_code:-000}"

  if expect_absent_report "$name" "$http_code"; then return; fi

  if [ "$http_code" != "200" ]; then
    report "$name" "FAIL" "expected 200, got $http_code"
    return
  fi
  if ! grep -qi '^content-type:.*text/html' "$headers_file"; then
    report "$name" "FAIL" "content-type header does not contain text/html"
    return
  fi
  if ! grep -q '<div id="root"' "$body_file"; then
    report "$name" "FAIL" "body does not contain <div id=\"root\""
    return
  fi
  report "$name" "PASS" "200, text/html, <div id=\"root\"> present"
}

# ---------------------------------------------------------------------------
# 2. SPA fallback: GET /some/deep/path -> 200, same HTML as /
# ---------------------------------------------------------------------------
check_spa_fallback() {
  name="SPA fallback (GET /some/deep/path)"
  body_file="$TMPDIR/spa_body"
  http_code="$(curl -sS --max-time 20 -o "$body_file" -w '%{http_code}' "$BASE/some/deep/path" || true)"
  http_code="${http_code:-000}"

  if expect_absent_report "$name" "$http_code"; then return; fi

  if [ "$http_code" != "200" ]; then
    report "$name" "FAIL" "expected 200, got $http_code"
    return
  fi
  if ! grep -q '<div id="root"' "$body_file"; then
    report "$name" "FAIL" "body does not look like index.html (<div id=\"root\"> missing)"
    return
  fi
  if ! cmp -s "$body_file" "$TMPDIR/assets_body"; then
    report "$name" "FAIL" "body differs from GET / — not the same index.html"
    return
  fi
  report "$name" "PASS" "200, falls back to index.html"
}

# ---------------------------------------------------------------------------
# 3. Config: GET /__config.json -> 200, valid JSON, .mode == preview, .pr == n
# ---------------------------------------------------------------------------
check_config() {
  name="config (GET /__config.json)"
  body_file="$TMPDIR/config_body"
  http_code="$(curl -sS --max-time 20 -o "$body_file" -w '%{http_code}' "$BASE/__config.json" || true)"
  http_code="${http_code:-000}"

  if expect_absent_report "$name" "$http_code"; then return; fi

  if [ "$http_code" != "200" ]; then
    report "$name" "FAIL" "expected 200, got $http_code"
    return
  fi

  if ! python3 -c "
import json, sys
with open('$body_file') as f:
    data = json.load(f)
assert data.get('mode') == 'preview', f\"mode was {data.get('mode')!r}\"
assert data.get('pr') == $PR, f\"pr was {data.get('pr')!r}\"
" 2>"$TMPDIR/config_err"; then
    report "$name" "FAIL" "$(cat "$TMPDIR/config_err")"
    return
  fi
  report "$name" "PASS" "200, valid JSON, mode=preview, pr=$PR"
}

# ---------------------------------------------------------------------------
# 4. Buffered API: GET /api/ping -> 200, body contains "pong"
# ---------------------------------------------------------------------------
check_ping() {
  name="buffered API (GET /api/ping)"
  body_file="$TMPDIR/ping_body"
  http_code="$(curl -sS --max-time 20 -o "$body_file" -w '%{http_code}' "$BASE/api/ping" || true)"
  http_code="${http_code:-000}"

  if expect_absent_report "$name" "$http_code"; then return; fi

  if [ "$http_code" != "200" ]; then
    report "$name" "FAIL" "expected 200, got $http_code"
    return
  fi
  if ! grep -q '"pong"' "$body_file"; then
    report "$name" "FAIL" "body does not contain \"pong\": $(cat "$body_file")"
    return
  fi
  report "$name" "PASS" "200, body contains \"pong\""
}

# ---------------------------------------------------------------------------
# 5. Signed POST: POST /api/echo with a body + x-amz-content-sha256
# ---------------------------------------------------------------------------
check_echo() {
  name="signed POST (POST /api/echo)"
  echo_body='{"text":"hello preview"}'
  # Write the exact payload to a file so the hash and the sent body match byte
  # for byte, then hash that file.
  printf '%s' "$echo_body" > "$TMPDIR/echo_payload"
  hash="$($SHA256_BIN "$TMPDIR/echo_payload" | awk '{print $1}')"

  resp_file="$TMPDIR/echo_body"
  http_code="$(curl -sS --max-time 20 -o "$resp_file" -w '%{http_code}' \
    -X POST "$BASE/api/echo" \
    -H "content-type: application/json" \
    -H "x-amz-content-sha256: $hash" \
    --data-binary "@$TMPDIR/echo_payload" || true)"
  http_code="${http_code:-000}"

  if expect_absent_report "$name" "$http_code"; then return; fi

  if [ "$http_code" = "403" ]; then
    report "$name" "FAIL" "403 Forbidden — this is OAC signing (x-amz-content-sha256), not a routing bug"
    return
  fi
  if [ "$http_code" != "200" ]; then
    report "$name" "FAIL" "expected 200, got $http_code"
    return
  fi
  if grep -Eq '"length": ?13[,}[:space:]]' "$resp_file"; then
    report "$name" "PASS" "200, body reports length 13"
  else
    report "$name" "FAIL" "body does not contain \"length\": 13: $(cat "$resp_file")"
  fi
}

# ---------------------------------------------------------------------------
# 6. SSE: curl -N /events/tick?n=5, at least 5 `event: tick` frames,
#    1st->5th spread >= 0.4s, 1st->2nd gap <= 1.5s.
# ---------------------------------------------------------------------------
check_sse() {
  name="SSE stream (GET /events/tick?n=5)"

  if [ "$EXPECT_ABSENT" = "1" ]; then
    # In torn-down mode we still just want a 404, with no need to time frames.
    http_code="$(curl -sS --max-time 30 -o "$TMPDIR/sse_body" -w '%{http_code}' -N "$BASE/events/tick?n=5" || true)"
    http_code="${http_code:-000}"
    if [ "$http_code" = "404" ]; then
      report "$name" "PASS" "torn down as expected (404)"
    else
      report "$name" "FAIL" "expected 404 (torn down), got $http_code"
    fi
    return
  fi

  # curl -N streams to stdout; pipe into python3, which timestamps each
  # `event: tick` line as it is read and prints the verdict as JSON on the
  # last line of its own stdout.
  set +e
  result="$(curl -N -sS --max-time 30 "$BASE/events/tick?n=5" 2>"$TMPDIR/sse_curl_err" | python3 -c '
import sys, time, json

first = None
times = []
for line in sys.stdin:
    if line.startswith("event: tick"):
        now = time.time()
        if first is None:
            first = now
        times.append(now)

out = {"count": len(times)}
if len(times) >= 1:
    out["first_to_second"] = (times[1] - times[0]) if len(times) >= 2 else None
if len(times) >= 5:
    out["first_to_fifth"] = times[4] - times[0]
print(json.dumps(out))
')"
  curl_exit="${PIPESTATUS[0]:-$?}"
  set -e

  count="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("count", 0))' 2>/dev/null || echo 0)"

  if [ "$curl_exit" != "0" ] && [ "$count" = "0" ]; then
    if [ -s "$TMPDIR/sse_curl_err" ] && grep -qi '404' "$TMPDIR/sse_curl_err"; then
      report "$name" "FAIL" "curl failed (exit $curl_exit), no tick frames received: $(cat "$TMPDIR/sse_curl_err")"
    else
      report "$name" "FAIL" "curl failed (exit $curl_exit) or timed out, no tick frames received"
    fi
    return
  fi

  if [ "$count" -lt 5 ]; then
    report "$name" "FAIL" "only $count \"event: tick\" frames arrived, expected >= 5"
    return
  fi

  spread="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["first_to_fifth"])')"
  gap="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["first_to_second"])')"

  ok="$(python3 -c "print('yes' if $spread >= 0.4 and $gap <= 1.5 else 'no')")"
  spread_ms="$(python3 -c "print(round($spread * 1000))")"
  gap_ms="$(python3 -c "print(round($gap * 1000))")"

  if [ "$ok" = "yes" ]; then
    report "$name" "PASS" "5 tick frames; 1st->5th spread ${spread_ms}ms (>=400), 1st->2nd gap ${gap_ms}ms (<=1500)"
  else
    report "$name" "FAIL" "5 tick frames but timing out of bounds: 1st->5th spread ${spread_ms}ms (need >=400), 1st->2nd gap ${gap_ms}ms (need <=1500) — looks buffered"
  fi
}

# ---------------------------------------------------------------------------
# 7. Unknown preview host: GET https://pr-999999.preview.<domain>/ -> 404
#    (not affected by --expect-absent: it's always expected to 404)
# ---------------------------------------------------------------------------
check_unknown_host() {
  name="unknown host (GET pr-999999.preview.$DOMAIN)"
  unknown_base="https://pr-999999.preview.${DOMAIN}"
  http_code="$(curl -sS --max-time 20 -o "$TMPDIR/unknown_body" -w '%{http_code}' "$unknown_base/" || true)"
  http_code="${http_code:-000}"
  if [ "$http_code" = "404" ]; then
    report "$name" "PASS" "404 as expected"
  else
    report "$name" "FAIL" "expected 404, got $http_code — previews may be leaking into each other"
  fi
}

echo "Verifying preview: $BASE"
if [ "$EXPECT_ABSENT" = "1" ]; then
  echo "(--expect-absent: checks 1-6 must all 404)"
fi
echo

check_assets
check_spa_fallback
check_config
check_ping
check_echo
check_sse
check_unknown_host

echo
echo "----------------------------------------"
echo "$PASS_COUNT passed, $FAIL_COUNT failed"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
exit 0
