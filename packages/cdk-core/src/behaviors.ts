/**
 * The one place a backend's CloudFront behavior is shaped.
 *
 * `Site` and `PreviewSite` build different distributions from the same
 * `backends` map, and the parts that differ are exactly two: prod points a
 * behavior at a real function-URL origin, while a preview points every backend
 * behavior at a placeholder the router overrides per request; and prod honors
 * a consumer's `cachePolicy`, while a preview is always `CACHING_DISABLED`
 * because one distribution serves every open PR.
 *
 * Everything else is identical and is identical for reasons that were measured
 * rather than chosen — `ALL_VIEWER_EXCEPT_HOST_HEADER` in particular (see
 * `.claude/rules/cdk.md`: excluding `host` and *only* `host`, because the deny
 * list applies to the outbound headers, which by then include the
 * `Authorization` header OAC just added). A second copy of this shape would be
 * a second chance to get one of them subtly wrong.
 */

import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'

import type { BackendProps } from './types.js'

export interface BackendBehaviorContext {
  /** Prod: the function-URL origin. Preview: the placeholder the router overrides. */
  readonly origin: cloudfront.IOrigin
  /** Preview: the router, on viewer-request. Prod: nothing. */
  readonly functionAssociations?: cloudfront.FunctionAssociation[]
  /** Previews ignore `backend.cachePolicy` and are always `CACHING_DISABLED`. */
  readonly forceCachingDisabled?: boolean
}

/** Builds one backend behavior. `origin` and `functionAssociations` are applied after `behaviorOverrides` and so cannot be replaced by it. */
export function backendBehavior(
  backend: BackendProps,
  context: BackendBehaviorContext,
): cloudfront.BehaviorOptions {
  if (typeof backend.cachePolicy === 'function' && !context.forceCachingDisabled) {
    throw new Error(
      'backendBehavior: cachePolicy is a factory; resolve it with a scope first (Site does this)',
    )
  }
  return {
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: backend.allowedMethods ?? cloudfront.AllowedMethods.ALLOW_ALL,
    cachePolicy: context.forceCachingDisabled
      ? cloudfront.CachePolicy.CACHING_DISABLED
      : ((backend.cachePolicy as cloudfront.ICachePolicy | undefined) ??
        cloudfront.CachePolicy.CACHING_DISABLED),
    // Must exclude `host` and only `host` — see the module comment.
    originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    // Compression would defeat SSE. Off for every backend, not just the
    // streaming ones, because a JSON API behind an uncached behavior gains
    // little from it and a single rule is one fewer thing to reason about.
    compress: false,
    ...backend.behaviorOverrides,
    // Applied last, so `behaviorOverrides` cannot replace them — which is what
    // the prop's doc comment promises. In a preview the router owns the
    // viewer-request slot; in prod there is no association and this pins it to
    // `undefined` rather than leaving an override free to add one.
    origin: context.origin,
    functionAssociations: context.functionAssociations,
  }
}

/**
 * The distribution-level props a consumer may not override, because the
 * construct's whole job is to get them right: the behaviors, the alternate
 * domain names, and the certificate that has to match them.
 */
const PROTECTED_DISTRIBUTION_PROPS = [
  'defaultBehavior',
  'additionalBehaviors',
  'domainNames',
  'certificate',
] as const

/**
 * Strips the props a consumer may not override out of `distributionOverrides`,
 * so the remainder can be spread *before* them. Spreading the whole thing last
 * would let a consumer replace the behaviors; spreading it first would make
 * `priceClass`, `logging` and friends — the things it exists for — silently
 * lose to the construct's own defaults.
 */
export function safeDistributionOverrides(
  overrides: Partial<cloudfront.DistributionProps> | undefined,
): Partial<cloudfront.DistributionProps> {
  if (!overrides) return {}
  const copy: Partial<cloudfront.DistributionProps> = { ...overrides }
  for (const key of PROTECTED_DISTRIBUTION_PROPS) delete copy[key]
  return copy
}
