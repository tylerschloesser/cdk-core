/**
 * `cdk-core sweep` — the orphan sweeper (Epoch 3, plan.md D3).
 *
 * It reconciles three things against GitHub PR state: CloudFormation stacks
 * matching `^<prefix>-pr-(\d+)$`, KVS keys, and `pr-<n>/` prefixes in the
 * preview bucket. `--dry-run` deletes nothing and is what the acceptance
 * tests use.
 *
 * This file is bundled by esbuild (see the `build` script in
 * package.json) rather than shipped as the plain `tsc` output, so that a
 * consumer who installs this package does not have to install five AWS SDK
 * packages just to get the CDK constructs from the `.` export — that is why
 * `@aws-sdk/client-cloudformation`, `@aws-sdk/client-s3`,
 * `@aws-sdk/client-ssm`, `@aws-sdk/client-cloudfront-keyvaluestore` and
 * `@aws-sdk/signature-v4a` are devDependencies, not dependencies. The esbuild
 * step in `build` runs *after* `tsc -b` specifically because it overwrites
 * `tsc`'s emitted `dist/bin/sweep.js` with the bundle.
 *
 * No `#!/usr/bin/env node` here in the source: esbuild's `--banner:js` in the
 * `build` script supplies it on the bundled output, which is the only form
 * of this file that ever ships or runs. A shebang here too would double up
 * with the banner (esbuild does not deduplicate) and make the bundle a
 * syntax error.
 */

import { sweep } from '../sweep/reconcile.js'
import { createSweepDeps } from '../sweep/aws.js'

const USAGE =
  'usage: cdk-core sweep --site <domain> --stack-prefix <prefix> --repo <owner/name> [--dry-run] [--region <region>]'

function usage(): never {
  console.error(USAGE)
  process.exit(2)
}

interface ParsedArgs {
  site: string
  stackPrefix: string
  repo: string
  dryRun: boolean
  region: string
}

function parseArgs(argv: string[]): ParsedArgs {
  let site: string | undefined
  let stackPrefix: string | undefined
  let repo: string | undefined
  let dryRun = false
  let region = 'us-east-1'

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--site':
        site = argv[++i]
        break
      case '--stack-prefix':
        stackPrefix = argv[++i]
        break
      case '--repo':
        repo = argv[++i]
        break
      case '--region':
        region = argv[++i]
        break
      case '--dry-run':
        dryRun = true
        break
      default:
        usage()
    }
  }

  if (!site || !stackPrefix || !repo) {
    usage()
  }

  return { site, stackPrefix, repo, dryRun, region }
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv

  if (command !== 'sweep') {
    usage()
  }

  const options = parseArgs(rest)
  const deps = createSweepDeps(options)
  const result = await sweep(deps, {
    site: options.site,
    stackPrefix: options.stackPrefix,
    repo: options.repo,
    dryRun: options.dryRun,
  })
  process.exit(result.exitCode)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
