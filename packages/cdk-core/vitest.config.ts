import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Vitest's 5 s default is sized for pure functions, and most of this suite
    // is. The CloudFormation tests are not: `Template.fromStack` synthesizes
    // the app, which stages and zips every `Code.fromAsset` — including CDK's
    // own custom-resource provider framework — and on a two-core CI runner
    // with a dozen test files in flight that alone blew past 5 s and failed a
    // run whose assertions were all correct. The timeout is a guard against a
    // hang, not a performance budget: the whole suite takes ~3 s locally.
    testTimeout: 30_000,
  },
})
