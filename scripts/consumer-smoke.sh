#!/usr/bin/env bash
#
# Proves the *packaged* `@tylerschloesser/cdk-core` works for someone who is
# not in this workspace.
#
# The reference site stays on `workspace:*` on purpose — it dogfoods HEAD — so
# nothing in `pnpm verify` ever resolves the package the way an npm consumer
# does. Everything that only breaks in a tarball is invisible to it: a missing
# `dist/handlers/` bundle, an `exports` map that does not point at the emitted
# files, a bin whose shebang or CommonJS banner got dropped, an optional peer
# that turns out not to be optional. This script is the check for exactly that
# class of bug, and it is the reason it installs from a registry or a tarball
# rather than from `../..`.
#
# What it does: makes a temp directory laid out like a small consumer repo,
# installs the package into it, renders the `new-site` skill's `app.ts`
# template with dummy values, and runs `cdk synth` on all four permanent
# stacks plus one PR stack.
#
# **No AWS credentials.** `GithubDeployRole` resolves two SSM parameters with
# `valueFromLookup`, which would otherwise call AWS, so the temp project ships
# a `cdk.context.json` with those two keys pre-seeded. That is not a fudge: it
# is what a real consumer's committed context file holds, and it keeps this
# script runnable in CI and on a plane.
#
# Usage:
#   scripts/consumer-smoke.sh                     # install @latest from npm
#   scripts/consumer-smoke.sh --version 0.1.0     # install an exact version
#   scripts/consumer-smoke.sh --tarball <path>    # install a local `npm pack` artifact
#   scripts/consumer-smoke.sh --pack              # `npm pack` this workspace first, then use it
#   scripts/consumer-smoke.sh --keep              # leave the temp dir for inspection
#
# `--pack` is the pre-publish form: it is how you find out the tarball is
# broken *before* burning a version number, since npm versions are permanent.
#
# Must run under bash 3.2 (macOS /bin/bash) and bash 5: no associative arrays,
# no mapfile.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES="$REPO_ROOT/plugins/cdk-core/skills/new-site/templates"
PACKAGE_NAME="@tylerschloesser/cdk-core"

# Dummy everything. The account is a valid-shaped 12-digit id that is not a
# real account; the region must be us-east-1 because CloudFront requires its
# certificate there and `siteCertificate` says so at synth.
ACCOUNT_ID="000000000000"
REGION="us-east-1"
SITE_DOMAIN="smoke.example.com"
ZONE_ID="Z00000000000000000000"
ZONE_NAME="example.com"
STACK_PREFIX="Smoke"
AUTH_PREFIX="smoke-example"
PREVIEW_AUTH_PREFIX="smoke-example-preview"
REPO="example/smoke"
REPO_OWNER_ID="1"
REPO_ID="2"
ROLE_NAME="smoke-github-deploy"

SPEC=""
TARBALL=""
DO_PACK=0
KEEP=0

usage() {
  echo "Usage: $0 [--version <v> | --tarball <path> | --pack] [--keep]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      shift
      [ $# -gt 0 ] || usage
      SPEC="${PACKAGE_NAME}@$1"
      shift
      ;;
    --tarball)
      shift
      [ $# -gt 0 ] || usage
      TARBALL="$1"
      shift
      ;;
    --pack)
      DO_PACK=1
      shift
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

if [ "$DO_PACK" -eq 1 ] && [ -n "$TARBALL" ]; then
  echo "FATAL: --pack and --tarball are mutually exclusive" >&2
  exit 2
fi

command -v node >/dev/null 2>&1 || { echo "FATAL: node not found on PATH" >&2; exit 2; }
command -v npm >/dev/null 2>&1 || { echo "FATAL: npm not found on PATH" >&2; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdk-core-smoke.XXXXXX")"
cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo "" >&2
    echo "temp project kept at: $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

if [ "$DO_PACK" -eq 1 ]; then
  echo "==> pnpm pack $REPO_ROOT/packages/cdk-core" >&2
  # `pnpm pack`, never `npm pack`. Every version in this workspace is a
  # `catalog:` specifier, and only pnpm rewrites those to real ranges when it
  # packs; an `npm pack` tarball ships `"aws-jwt-verify": "catalog:"` in
  # `dependencies` and dies in the consumer's install with
  # `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "catalog:"`. Measured here
  # before 0.1.0 was published. `prepare` runs `build`, so the tarball is
  # always built from current source.
  command -v pnpm >/dev/null 2>&1 || { echo "FATAL: pnpm not found on PATH (--pack needs it)" >&2; exit 2; }
  (cd "$REPO_ROOT/packages/cdk-core" && pnpm pack --pack-destination "$WORK" >/dev/null 2>&1)
  # `pnpm pack` prints a banner as well as the path, so glob for what it wrote
  # rather than parsing its stdout. $WORK was just created, so it holds one.
  TARBALL="$(find "$WORK" -maxdepth 1 -name '*.tgz' | head -1)"
  echo "    -> $TARBALL" >&2
fi

if [ -n "$TARBALL" ]; then
  [ -f "$TARBALL" ] || { echo "FATAL: tarball not found: $TARBALL" >&2; exit 1; }
  # npm resolves a relative file: spec against the installing project, so make
  # it absolute before it goes into a manifest in another directory.
  case "$TARBALL" in
    /*) ;;
    *) TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")" ;;
  esac
  SPEC="$TARBALL"
elif [ -z "$SPEC" ]; then
  SPEC="${PACKAGE_NAME}@latest"
fi

echo "==> consumer project: $WORK" >&2
echo "==> installing: $SPEC" >&2

# ---- lay the project out the way the template expects -------------------
#
# `templates/app.ts` reaches out of `infra/bin/` for `../../apps/api/src/*.ts`
# and `../../apps/web/dist`, so the temp repo mirrors that shape. The entry
# files are real because `NodejsFunction` bundles them at synth with esbuild —
# which is also why esbuild is a dependency of the *root*, where CDK runs the
# bundler from.
mkdir -p "$WORK/infra/bin" "$WORK/apps/api/src" "$WORK/apps/web/dist"

cat > "$WORK/apps/api/src/lambda-api.ts" <<'EOF'
export const handler = async () => ({ statusCode: 200, body: 'ok' })
EOF
cp "$WORK/apps/api/src/lambda-api.ts" "$WORK/apps/api/src/lambda-events.ts"
# `Site` throws at synth if webDist is missing, and BucketDeployment refuses an
# empty source directory.
echo '<!doctype html><title>smoke</title>' > "$WORK/apps/web/dist/index.html"

cat > "$WORK/package.json" <<EOF
{
  "name": "cdk-core-consumer-smoke",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "dependencies": {
    "$PACKAGE_NAME": "$SPEC",
    "aws-cdk-lib": "^2.268.0",
    "constructs": "^10.8.1"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "aws-cdk": "^2.1140.0",
    "esbuild": "^0.28.2",
    "tsx": "^4.20.3",
    "typescript": "~6.0.2"
  }
}
EOF

cat > "$WORK/infra/cdk.json" <<'EOF'
{
  "app": "npx tsx bin/app.ts",
  "output": "cdk.out"
}
EOF

# The two SSM lookups `GithubDeployRole` does, pre-seeded so synth needs no
# credentials. A real consumer commits this file for the same reason.
cat > "$WORK/infra/cdk.context.json" <<EOF
{
  "ssm:account=${ACCOUNT_ID}:parameterName=/cdk-core/${SITE_DOMAIN}/preview/kvsArn:region=${REGION}": "arn:aws:cloudfront::${ACCOUNT_ID}:key-value-store/00000000-0000-0000-0000-000000000000",
  "ssm:account=${ACCOUNT_ID}:parameterName=/cdk-core/${SITE_DOMAIN}/preview/bucketName:region=${REGION}": "smoke-preview-assets"
}
EOF

# ---- render the template ------------------------------------------------
#
# Same substitution the `workflow-templates.test.ts` drift test performs, with
# dummy values instead of this repo's. If a placeholder survives, the synth
# below fails loudly rather than silently synthesizing `{{SITE_DOMAIN}}`.
PACKAGE_NAME="$PACKAGE_NAME" PREVIEW_AUTH_PREFIX="$PREVIEW_AUTH_PREFIX" ROLE_NAME="$ROLE_NAME" \
SITE_DOMAIN="$SITE_DOMAIN" REPO_OWNER_ID="$REPO_OWNER_ID" STACK_PREFIX="$STACK_PREFIX" \
AUTH_PREFIX="$AUTH_PREFIX" ZONE_NAME="$ZONE_NAME" ACCOUNT_ID="$ACCOUNT_ID" REPO_ID="$REPO_ID" \
ZONE_ID="$ZONE_ID" REGION="$REGION" REPO="$REPO" \
node -e '
const fs = require("node:fs")
const [src, dest] = process.argv.slice(1)
const order = ["PACKAGE_NAME","PREVIEW_AUTH_PREFIX","ROLE_NAME","SITE_DOMAIN","REPO_OWNER_ID","STACK_PREFIX","AUTH_PREFIX","ZONE_NAME","ACCOUNT_ID","REPO_ID","ZONE_ID","REGION","REPO"]
let out = fs.readFileSync(src, "utf8")
for (const k of order) out = out.split("{{" + k + "}}").join(process.env[k])
const left = out.match(/\{\{[A-Z_]+\}\}/g)
if (left) { console.error("FATAL: unsubstituted placeholders: " + left.join(", ")); process.exit(1) }
fs.writeFileSync(dest, out)
' "$TEMPLATES/app.ts" "$WORK/infra/bin/app.ts"

# ---- install and synth --------------------------------------------------

echo "==> npm install" >&2
(cd "$WORK" && npm install --no-audit --no-fund --loglevel=error)

INSTALLED="$(cd "$WORK" && node -e 'console.log(require("./node_modules/@tylerschloesser/cdk-core/package.json").version)')"
echo "==> installed $PACKAGE_NAME@$INSTALLED" >&2

# The published manifest must carry real semver ranges. A `catalog:` specifier
# that escaped into `dependencies` would already have failed the install above,
# but saying it out loud is what makes the failure legible next time.
(cd "$WORK" && node -e '
const deps = require("./node_modules/@tylerschloesser/cdk-core/package.json").dependencies || {}
const bad = Object.entries(deps).filter(([, v]) => /^(catalog|workspace):/.test(v))
if (bad.length) { console.error("FATAL: unresolved specifiers in the published manifest: " + JSON.stringify(bad)); process.exit(1) }
console.log("  ok  dependencies are real semver ranges: " + JSON.stringify(deps))
')

# Resolve every published subpath through the exports map, in the environment
# that subpath claims to support. This is the cheap half of the test and it
# catches the most common packaging bug: an exports entry pointing at a file
# the build does not emit.
echo "==> resolving exports" >&2
(cd "$WORK" && node -e '
const p = "@tylerschloesser/cdk-core"
const main = require("node:module").createRequire(process.cwd() + "/x.js")
for (const sub of ["", "/auth/server"]) {
  const r = main.resolve(p + sub)
  console.log("  ok  " + p + sub + " -> " + r.replace(process.cwd(), "."))
}
')
(cd "$WORK" && node --input-type=module -e '
import { defineSiteStacks, Site, PreviewSite, PreviewDeployment, GithubDeployRole, siteCertificate } from "@tylerschloesser/cdk-core"
import { createVerifier } from "@tylerschloesser/cdk-core/auth/server"
const missing = Object.entries({ defineSiteStacks, Site, PreviewSite, PreviewDeployment, GithubDeployRole, siteCertificate, createVerifier })
  .filter(([, v]) => typeof v !== "function")
  .map(([k]) => k)
if (missing.length) { console.error("FATAL: not callable from the tarball: " + missing.join(", ")); process.exit(1) }
console.log("  ok  named exports import and are callable")
')
# `auth/browser` is DOM-only, so it is checked for resolvability and for not
# dragging aws-cdk-lib in, not executed.
(cd "$WORK" && node -e '
const fs = require("node:fs")
const pkg = require("./node_modules/@tylerschloesser/cdk-core/package.json")
const rel = pkg.exports["./auth/browser"].default
const path = "./node_modules/@tylerschloesser/cdk-core/" + rel.replace(/^\.\//, "")
if (!fs.existsSync(path)) { console.error("FATAL: exports ./auth/browser points at a missing file: " + rel); process.exit(1) }
if (fs.readFileSync(path, "utf8").includes("aws-cdk-lib")) { console.error("FATAL: auth/browser references aws-cdk-lib"); process.exit(1) }
console.log("  ok  ./auth/browser resolves and pulls in no aws-cdk-lib")
')
# The bin is a bundled CommonJS artifact with a shebang; an ESM bundle of the
# AWS SDK builds clean and dies on first call with `Dynamic require of
# "node:https" is not supported`, so run it rather than just resolving it.
echo "==> cdk-core CLI" >&2
# `--help` prints usage and exits 2, like every other script in this repo, so
# assert on what it printed rather than on the exit code.
CLI_OUT="$( (cd "$WORK" && ./node_modules/.bin/cdk-core --help) 2>&1 || true )"
case "$CLI_OUT" in
  *"usage: cdk-core sweep"*) echo "  ok  cdk-core bin executes" ;;
  *)
    echo "FATAL: the cdk-core bin did not execute. Output was:" >&2
    echo "$CLI_OUT" >&2
    exit 1
    ;;
esac

echo "==> cdk synth" >&2
STACKS="${STACK_PREFIX}Shared ${STACK_PREFIX}Preview ${STACK_PREFIX}Site ${STACK_PREFIX}GithubOidc"
# shellcheck disable=SC2086
(cd "$WORK/infra" && ../node_modules/.bin/cdk synth $STACKS --quiet)
echo "  ok  four permanent stacks synthesized"
(cd "$WORK/infra" && ../node_modules/.bin/cdk synth "${STACK_PREFIX}-pr-1" -c pr=1 --quiet)
echo "  ok  ${STACK_PREFIX}-pr-1 synthesized"

# A synth that emitted no CloudFront distribution would still "succeed", so
# assert the shape of what came out.
node -e '
const fs = require("node:fs")
const [dir, prefix] = process.argv.slice(1)
const check = (stack, types) => {
  const file = dir + "/" + stack + ".template.json"
  const t = JSON.parse(fs.readFileSync(file, "utf8"))
  const have = Object.values(t.Resources || {}).map((r) => r.Type)
  for (const type of types) {
    if (!have.includes(type)) { console.error("FATAL: " + stack + " has no " + type); process.exit(1) }
  }
}
check(prefix + "Shared", ["AWS::CertificateManager::Certificate"])
check(prefix + "Preview", ["AWS::CloudFront::Distribution", "AWS::CloudFront::KeyValueStore", "AWS::CloudFront::Function", "AWS::Cognito::UserPool"])
check(prefix + "Site", ["AWS::CloudFront::Distribution", "AWS::Cognito::UserPool", "AWS::Lambda::Url"])
check(prefix + "GithubOidc", ["AWS::IAM::Role"])
check(prefix + "-pr-1", ["AWS::Lambda::Url"])
console.log("  ok  templates contain the expected resource types")
' "$WORK/infra/cdk.out" "$STACK_PREFIX"

echo "" >&2
echo "PASS: $PACKAGE_NAME@$INSTALLED synthesizes four stacks plus a PR stack outside this workspace" >&2
