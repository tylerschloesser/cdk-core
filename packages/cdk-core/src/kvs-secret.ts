/**
 * `KvsSecret` — copies one JSON field of a Secrets Manager secret into a
 * CloudFront KeyValueStore at deploy time, via the `KvsSecret` `ResourceType`
 * in `src/handlers/preview-resources.ts`. This is the edge gate's session-
 * signing HMAC secret: a CloudFront Function has no environment variables, so
 * per AWS's own guidance the shared secret has to live somewhere the function
 * *can* read, and `kvs.get()` against the KeyValueStore is that place.
 *
 * It deliberately does **not** create its own Lambda or `cr.Provider`. Both
 * `Site` and `PreviewSite` already run a `PoolUser`-style handler/provider
 * pair backed by the same bundled `preview-resources` asset (see
 * `handler-asset.ts`); a second pair would double the stack's Lambda count
 * for a resource type the existing handler already dispatches on. Callers
 * pass that handler in as `onEventHandler` and this construct only adds the
 * IAM it needs and the `CustomResource` itself.
 *
 * ## The trade-off this makes, on purpose
 *
 * A symmetric secret in a KeyValueStore is readable by anyone holding
 * `cloudfront-keyvaluestore:ListKeys` on that store, because `ListKeys`
 * returns *values*, not just key names — there is no per-key IAM. On the
 * preview store that is not hypothetical: `src/github-deploy-role.ts` already
 * grants `ListKeys` on it to the GitHub Actions OIDC role, so a CI run can
 * read the preview signing key. This is accepted because CloudFront
 * Functions have no environment variables and no other secret store, and
 * because a preview signing key only forges *preview* sessions — prod's
 * secret is a different secret in a different store. **A prod store should
 * never be granted `ListKeys`.**
 */

import { CustomResource } from 'aws-cdk-lib'
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as iam from 'aws-cdk-lib/aws-iam'
import type * as lambda from 'aws-cdk-lib/aws-lambda'
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'

export interface KvsSecretProps {
  readonly keyValueStore: cloudfront.IKeyValueStore
  readonly secret: secretsmanager.ISecret
  /** JSON field inside the secret. */
  readonly secretKey: string
  /** Key to write in the KeyValueStore. */
  readonly kvsKey: string
  /** The custom-resource handler; the construct adds its IAM to this function. */
  readonly onEventHandler: lambda.IFunction
  readonly serviceToken: string
}

export class KvsSecret extends Construct {
  constructor(scope: Construct, id: string, props: KvsSecretProps) {
    super(scope, id)

    props.onEventHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudfront-keyvaluestore:DescribeKeyValueStore',
          'cloudfront-keyvaluestore:UpdateKeys',
        ],
        resources: [props.keyValueStore.keyValueStoreArn],
      }),
    )
    props.secret.grantRead(props.onEventHandler)

    new CustomResource(this, 'Resource', {
      serviceToken: props.serviceToken,
      resourceType: 'Custom::CdkCoreKvsSecret',
      properties: {
        ResourceType: 'KvsSecret',
        KvsArn: props.keyValueStore.keyValueStoreArn,
        Key: props.kvsKey,
        SecretArn: props.secret.secretArn,
        SecretKey: props.secretKey,
      },
    })
  }
}
