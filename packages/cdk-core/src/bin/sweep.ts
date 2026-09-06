#!/usr/bin/env node
/**
 * `cdk-core sweep` — the orphan sweeper (Epoch 3).
 *
 * It reconciles three things against GitHub PR state: CloudFormation stacks
 * matching `^<prefix>-pr-(\d+)$`, KVS keys, and `pr-<n>/` prefixes in the
 * preview bucket. `--dry-run` deletes nothing and is what the acceptance tests
 * use.
 *
 * The stub exists in Epoch 1 so the `bin` entry in the exports map is real and
 * the published shape does not change when the body lands.
 */

const [, , command, ...rest] = process.argv

if (command !== 'sweep') {
  console.error('usage: cdk-core sweep --site <domain> --stack-prefix <prefix> --repo <owner/name> [--dry-run]')
  process.exit(2)
}

void rest
console.error('not implemented: Epoch 3 (cdk-core sweep)')
process.exit(1)
