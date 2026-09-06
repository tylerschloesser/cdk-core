/**
 * Cache policies worth naming, offered as an alternative to a backend's
 * `CACHING_DISABLED` default.
 *
 * There is exactly one so far, carried from `yahn.ty.ler.dev`, because it is
 * the only one that came out of a real site rather than a guess.
 */

import { Duration } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import type { Construct } from 'constructs'

export class CachePolicies {
  private constructor() {}

  /**
   * The origin decides. `defaultTtl: 0` is what makes CloudFront honor the
   * handler's own `Cache-Control` — `public, max-age=30,
   * stale-while-revalidate=300` on a feed, `no-store` on a 500 — instead of
   * overriding it, and `maxTtl` is the ceiling on an origin that misbehaves.
   *
   * Query strings are part of the key and headers and cookies are not: an API
   * whose response varies by header wants its own policy, not this one.
   *
   * Pass it as a backend's `cachePolicy`. Previews ignore it and stay
   * `CACHING_DISABLED`, since one distribution serves every open PR.
   */
  static originDecides(scope: Construct, id = 'OriginDecidesCachePolicy'): cloudfront.CachePolicy {
    return new cloudfront.CachePolicy(scope, id, {
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(0),
      maxTtl: Duration.minutes(5),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
    })
  }
}
