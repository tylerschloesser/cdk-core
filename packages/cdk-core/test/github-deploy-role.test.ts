import { App, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'

import { GithubDeployRole } from '../src/github-deploy-role.js'

function synth(props: ConstructorParameters<typeof GithubDeployRole>[2]) {
  const app = new App()
  const stack = new Stack(app, 'TestStack', {
    env: { account: '111122223333', region: 'us-east-1' },
  })
  new GithubDeployRole(stack, 'GithubDeployRole', props)
  return Template.fromStack(stack)
}

const baseProps = {
  repo: 'tylerschloesser/cdk-core',
  roleName: 'cdk-core-github-deploy',
  stackPrefix: 'TestPrefix',
  domain: 'cdk-core.ty.ler.dev',
}

describe('GithubDeployRole', () => {
  it('trusts both sub forms when ownerId/repoId are given', () => {
    const template = synth({ ...baseProps, ownerId: '2300885', repoId: '1358400324' })
    const role = template.findResources('AWS::IAM::Role')
    const [roleResource] = Object.values(role)
    const condition =
      roleResource?.Properties.AssumeRolePolicyDocument.Statement[0].Condition
    expect(condition.StringLike['token.actions.githubusercontent.com:sub']).toEqual(
      expect.arrayContaining([
        'repo:tylerschloesser/cdk-core:ref:refs/heads/main',
        'repo:tylerschloesser/cdk-core:pull_request',
        'repo:tylerschloesser@2300885/cdk-core@1358400324:ref:refs/heads/main',
        'repo:tylerschloesser@2300885/cdk-core@1358400324:pull_request',
      ]),
    )
    expect(condition.StringLike['token.actions.githubusercontent.com:sub']).toHaveLength(4)
  })

  it('trusts only the legacy sub form when ownerId/repoId are omitted', () => {
    const template = synth(baseProps)
    const role = template.findResources('AWS::IAM::Role')
    const [roleResource] = Object.values(role)
    const condition =
      roleResource?.Properties.AssumeRolePolicyDocument.Statement[0].Condition
    expect(condition.StringLike['token.actions.githubusercontent.com:sub']).toEqual([
      'repo:tylerschloesser/cdk-core:ref:refs/heads/main',
      'repo:tylerschloesser/cdk-core:pull_request',
    ])
  })

  it('pins aud to sts.amazonaws.com', () => {
    const template = synth(baseProps)
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              },
            }),
          }),
        ]),
      },
    })
  })

  it('allows sts:AssumeRole on the CDK bootstrap roles', () => {
    const template = synth(baseProps)
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Resource: 'arn:aws:iam::111122223333:role/cdk-hnb659fds-*-111122223333-us-east-1',
          }),
        ]),
      },
    })
  })

  it('scopes DeleteStack to <stackPrefix>-pr-* and never to *', () => {
    const template = synth(baseProps)
    const policies = template.findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
    )

    const deleteStackStatements = statements.filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      return actions.includes('cloudformation:DeleteStack')
    })

    expect(deleteStackStatements).toHaveLength(1)
    const resources = deleteStackStatements[0]
    const resourceList = Array.isArray(resources?.Resource)
      ? resources.Resource
      : [resources?.Resource]
    expect(resourceList).toHaveLength(1)
    expect(resourceList[0]).toMatch(/:stack\/TestPrefix-pr-\*$/)

    for (const resource of resourceList) {
      expect(resource).not.toBe('*')
    }
  })

  it('scopes logs:DeleteLogGroup to /aws/lambda/<stackPrefix>-pr-* and never to *', () => {
    const template = synth(baseProps)
    const policies = template.findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
    )

    const deleteLogGroupStatements = statements.filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      return actions.includes('logs:DeleteLogGroup')
    })

    expect(deleteLogGroupStatements).toHaveLength(1)
    const resources = deleteLogGroupStatements[0]
    const resourceList = Array.isArray(resources?.Resource)
      ? resources.Resource
      : [resources?.Resource]
    expect(resourceList).toHaveLength(1)
    expect(resourceList[0]).toMatch(/:log-group:\/aws\/lambda\/TestPrefix-pr-\*$/)

    for (const resource of resourceList) {
      expect(resource).not.toBe('*')
    }
  })

  it('lists exactly the four cloudfront-keyvaluestore actions', () => {
    const template = synth(baseProps)
    const policies = template.findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
    )

    const kvsStatement = statements.find((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      return actions.some((action: unknown) =>
        typeof action === 'string' && action.startsWith('cloudfront-keyvaluestore:'),
      )
    })

    expect(kvsStatement).toBeDefined()
    expect(kvsStatement?.Action).toEqual(
      expect.arrayContaining([
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
        'cloudfront-keyvaluestore:ListKeys',
        'cloudfront-keyvaluestore:DeleteKey',
        'cloudfront-keyvaluestore:UpdateKeys',
      ]),
    )
    expect(kvsStatement?.Action).toHaveLength(4)
  })

  it('scopes s3:DeleteObject to /* and s3:ListBucket to the bucket itself', () => {
    const template = synth(baseProps)
    const policies = template.findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as Array<Record<string, unknown>>,
    )

    const deleteObjectStatement = statements.find(
      (statement) => statement.Action === 's3:DeleteObject',
    )
    const listBucketStatement = statements.find(
      (statement) => statement.Action === 's3:ListBucket',
    )

    expect(deleteObjectStatement).toBeDefined()
    expect(listBucketStatement).toBeDefined()

    const deleteObjectResource = deleteObjectStatement?.Resource
    const listBucketResource = listBucketStatement?.Resource

    expect(typeof deleteObjectResource === 'string' && deleteObjectResource.endsWith('/*')).toBe(
      true,
    )
    expect(typeof listBucketResource === 'string' && listBucketResource.endsWith('/*')).toBe(
      false,
    )
  })

  it('throws at synth when repo is not exactly owner/name', () => {
    const app = new App()
    const stack = new Stack(app, 'TestStack', {
      env: { account: '111122223333', region: 'us-east-1' },
    })
    expect(
      () =>
        new GithubDeployRole(stack, 'GithubDeployRole', {
          ...baseProps,
          repo: 'not-a-valid-repo',
        }),
    ).toThrow(/owner\/name/)
  })
})
