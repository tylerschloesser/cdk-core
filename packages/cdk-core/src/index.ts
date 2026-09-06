/**
 * `@tylerschloesser/cdk-core` — the construct surface.
 *
 * Everything downstream derives from this file: the props here are the contract
 * between `Site` (prod), `PreviewSite` (one per site, shared by every PR) and
 * `PreviewDeployment` (one per PR, in the PR stack). See `plan.md` →
 * Construct API for the reasoning behind each default.
 *
 * As of Epoch 3 every construct is real: `siteCertificate`, `Site`,
 * `PreviewSite`, `PreviewDeployment` and `GithubDeployRole` all build
 * resources. The `auth` props on all of them are accepted but ignored with a
 * synth-time warning until Epoch 4.
 */

export type { SiteConfig, SiteAuthConfig } from './config.js'
export { AUTH_STORAGE_KEY, CONFIG_PATH, ID_TOKEN_HEADER } from './config.js'
export type { SiteDomain, BackendProps, AuthProps, AuthEnvironment } from './types.js'

export { siteCertificate } from './certificate.js'
export type { SiteCertificateProps } from './certificate.js'

export { PreviewSite, previewParameterPrefix } from './preview-site.js'
export type { PreviewSiteProps } from './preview-site.js'

export { PreviewDeployment } from './preview-deployment.js'
export type { PreviewDeploymentProps } from './preview-deployment.js'

export { renderRouterSource } from './router/render.js'
export type { RouterSourceProps } from './router/render.js'

export { Site } from './site.js'
export type { SiteProps } from './site.js'

export { GithubDeployRole } from './github-deploy-role.js'
export type { GithubDeployRoleProps } from './github-deploy-role.js'

export { CachePolicies } from './cache-policies.js'

export { backendBehavior, safeDistributionOverrides } from './behaviors.js'
export type { BackendBehaviorContext } from './behaviors.js'

export { backendReadTimeoutSeconds } from './backend.js'

export { renderSpaSource } from './router/spa.js'
