/**
 * The Cognito half of `Site` and `PreviewSite`, shared as code rather than as
 * a convention — the same reason `behaviors.ts` exists. Both constructs build
 * the *same* pool shape: Google as the only identity provider, a hosted-UI
 * prefix domain, and one browser app client whose only auth flow is refresh.
 * What differs is two strings (the domain prefix, the callback URL) and the
 * fact that `PreviewSite` adds a machine client and a native user on top; see
 * plan.md D4 for why the pools are separate at all.
 *
 * Every flag below is load-bearing. The failure modes are silent: a pool that
 * accepts SRP sign-in looks identical from the browser, and a client that
 * trusts a second identity provider looks identical until someone uses it.
 */

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'

import type { SiteAuthConfig } from './config.js'
import type { AuthProps } from './types.js'

/** Where the Google OAuth client's `{clientId, clientSecret}` lives by default (plan.md D4). */
export const DEFAULT_GOOGLE_SECRET_NAME = 'cdk-core/google-oauth'

/**
 * The scopes asked of Google, and the scopes the app client may request. They
 * are the same three on purpose: with only `openid email profile` the consent
 * screen may stay in Testing without Google's 7-day refresh expiry applying.
 */
const OAUTH_SCOPES = [
  cognito.OAuthScope.OPENID,
  cognito.OAuthScope.EMAIL,
  cognito.OAuthScope.PROFILE,
]

export interface SiteUserPoolProps {
  readonly auth: AuthProps
  /** Cognito hosted-UI prefix, e.g. 'cdk-core'. Must equal what was typed into Google. */
  readonly domainPrefix: string
  /** Exact-match callback URLs. Cognito allows no wildcards (plan.md D5). */
  readonly callbackUrls: string[]
  readonly logoutUrls: string[]
  /** Shown in the console; not a stable identifier. */
  readonly userPoolName: string
}

export interface SiteUserPool {
  readonly userPool: cognito.UserPool
  readonly userPoolClient: cognito.UserPoolClient
  readonly userPoolDomain: cognito.UserPoolDomain
  /** `https://cognito-idp.<region>.amazonaws.com/<poolId>` — what a token's `iss` must equal. */
  readonly issuer: string
  /** What the browser puts in `__config.json` and builds authorize/token URLs from. */
  readonly authConfig: SiteAuthConfig
}

/**
 * Renders `{{resolve:secretsmanager:…}}` for one field of the Google OAuth
 * secret. The client id is not itself a secret — it travels in every authorize
 * redirect — but it lives in the same JSON blob as the client secret, and
 * reading it through the same dynamic reference keeps the deployed template
 * free of both and means a rotated Google client needs no code change.
 */
function googleSecret(scope: Construct, id: string, auth: AuthProps): secretsmanager.ISecret {
  return secretsmanager.Secret.fromSecretNameV2(
    scope,
    id,
    auth.googleSecretName ?? DEFAULT_GOOGLE_SECRET_NAME,
  )
}

export function siteUserPool(
  scope: Construct,
  id: string,
  props: SiteUserPoolProps,
): SiteUserPool {
  const { auth } = props

  const userPool = new cognito.UserPool(scope, id, {
    userPoolName: props.userPoolName,
    // Nobody signs up here: every human arrives through Google, and the only
    // native user that ever exists is the preview machine user, created by an
    // admin API call rather than by signing up.
    selfSignUpEnabled: false,
    signInAliases: { username: true },
    // The default for a new pool, stated explicitly because the tier decides
    // whether the classic hosted UI is available at all (plan.md D4).
    featurePlan: cognito.FeaturePlan.ESSENTIALS,
    // Only the preview pool has a password at all, but the policy is pool-wide
    // and the generated machine password has to satisfy it: alphanumeric and
    // long, so `excludePunctuation` on the generated secret cannot collide
    // with a `requireSymbols` rule.
    passwordPolicy: {
      minLength: 16,
      requireLowercase: true,
      requireUppercase: true,
      requireDigits: true,
      requireSymbols: false,
    },
    // A pool holds no state worth keeping — its users are Google identities
    // that reappear on the next login — and the epoch's teardown promises
    // `cdk destroy` removes everything. CDK's default here is RETAIN.
    removalPolicy: RemovalPolicy.DESTROY,
    ...auth.userPoolOverrides,
  })

  const secret = googleSecret(scope, `${id}GoogleSecret`, auth)
  const google = new cognito.UserPoolIdentityProviderGoogle(scope, `${id}Google`, {
    userPool,
    clientId: secret.secretValueFromJson('clientId').unsafeUnwrap(),
    clientSecretValue: secret.secretValueFromJson('clientSecret'),
    scopes: ['openid', 'email', 'profile'],
    // Without this the federated user has no `email` attribute, so the ID
    // token has no `email` claim and `auth/server` rejects every token it
    // successfully verifies.
    attributeMapping: {
      email: cognito.ProviderAttribute.GOOGLE_EMAIL,
    },
  })

  const userPoolDomain = auth.customDomainCertificate
    ? userPool.addDomain(`${id}Domain`, {
        customDomain: {
          domainName: props.domainPrefix,
          certificate: auth.customDomainCertificate,
        },
      })
    : userPool.addDomain(`${id}Domain`, {
        cognitoDomain: { domainPrefix: props.domainPrefix },
      })

  const region = Stack.of(scope).region
  const hostedUiDomain = auth.customDomainCertificate
    ? props.domainPrefix
    : `${props.domainPrefix}.auth.${region}.amazoncognito.com`

  const userPoolClient = new cognito.UserPoolClient(scope, `${id}Client`, {
    userPool,
    userPoolClientName: 'browser',
    // A public client: the SPA cannot keep a secret, which is exactly what
    // PKCE exists to compensate for.
    generateSecret: false,
    oAuth: {
      flows: { authorizationCodeGrant: true },
      scopes: OAUTH_SCOPES,
      callbackUrls: props.callbackUrls,
      logoutUrls: props.logoutUrls,
    },
    // Google and nothing else. Leaving this unset would add `COGNITO`, which
    // is what makes a native username/password sign-in reachable from the
    // hosted UI.
    supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
    preventUserExistenceErrors: true,
    enableTokenRevocation: true,
    idTokenValidity: auth.idTokenValidity ?? Duration.hours(1),
    accessTokenValidity: auth.idTokenValidity ?? Duration.hours(1),
    refreshTokenValidity: auth.refreshTokenValidity ?? Duration.days(30),
  })

  // CDK does not infer this: a client naming `Google` in
  // `SupportedIdentityProviders` fails to create if the provider does not
  // exist yet, and CloudFormation is free to order the two either way.
  userPoolClient.node.addDependency(google)

  // **The one thing the L2 cannot express.** `configureAuthFlows` returns
  // `undefined` for both an absent and an empty `authFlows`, which omits
  // `ExplicitAuthFlows` from the template — and an omitted `ExplicitAuthFlows`
  // makes Cognito apply its legacy defaults, which include
  // `ALLOW_USER_SRP_AUTH`. D6's whole claim that machine sign-in is
  // *structurally* impossible in prod rests on this list, so it is pinned on
  // the L1 rather than coaxed out of the L2. A `Site` unit test asserts it.
  const cfnClient = userPoolClient.node.defaultChild as cognito.CfnUserPoolClient
  cfnClient.explicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH']

  return {
    userPool,
    userPoolClient,
    userPoolDomain,
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}`,
    authConfig: {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${userPool.userPoolId}`,
      clientId: userPoolClient.userPoolClientId,
      domain: hostedUiDomain,
    },
  }
}

/** `cdk-core.ty.ler.dev` → `cdk-core-ty-ler-dev`. Cognito prefixes allow only `[a-z0-9-]`. */
export function defaultDomainPrefix(domain: string): string {
  return domain.replace(/\./g, '-')
}
