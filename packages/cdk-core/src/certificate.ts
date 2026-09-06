/**
 * The one ACM certificate a site needs (plan.md D9).
 *
 * `<domain>` and `*.preview.<domain>` on a single cert, so `Site` and
 * `PreviewSite` — which live in different stacks and deploy on different
 * cadences — do not each drag a DNS-validated certificate through
 * CloudFormation. A wildcard covers exactly one label, which is why previews
 * are `pr-<n>.preview.<domain>` and not `pr-<n>.<domain>`: the latter would
 * need `*.<domain>`, and that would shadow every other host on the site.
 */

import { Stack, Token } from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import type { Construct } from 'constructs'
import type { SiteDomain } from './types.js'

export interface SiteCertificateProps extends SiteDomain {
  /** Adds `auth.<domain>` as a third SAN, for the Cognito custom-domain escape hatch. */
  readonly includeAuthHost?: boolean
}

/**
 * One ACM certificate covering `domain` and `*.preview.<domain>` (and
 * `auth.<domain>` if asked). Must be created in us-east-1.
 */
export function siteCertificate(
  scope: Construct,
  id: string,
  props: SiteCertificateProps,
): acm.Certificate {
  // CloudFront only accepts certificates from us-east-1. Catching it here
  // turns a stack that deploys and then serves a TLS error into a synth-time
  // message. A token means the consumer used an env-agnostic stack, and we
  // cannot know — CloudFormation will say so at deploy time instead.
  const { region } = Stack.of(scope)
  if (!Token.isUnresolved(region) && region !== 'us-east-1') {
    throw new Error(
      `siteCertificate must be created in us-east-1 (CloudFront requirement), got '${region}'. ` +
        'Give the stack an explicit `env: { account, region: \'us-east-1\' }`.',
    )
  }

  const subjectAlternativeNames = [`*.preview.${props.domain}`]
  if (props.includeAuthHost) subjectAlternativeNames.push(`auth.${props.domain}`)

  return new acm.Certificate(scope, id, {
    domainName: props.domain,
    subjectAlternativeNames,
    validation: acm.CertificateValidation.fromDns(props.zone),
  })
}
