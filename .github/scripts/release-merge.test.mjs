import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isReleaseMerge } from './release-merge.mjs'

const repository = 'mia-cx/sponsors'
const sha = 'a'.repeat(40)
const pr = (overrides = {}) => ({
  merged_at: '2026-10-20T00:00:00Z',
  merge_commit_sha: sha,
  base: { ref: 'main' },
  head: { ref: 'changeset-release/main', repo: { full_name: repository } },
  ...overrides,
})

test('a merged version pull request from this repository is a release', () => {
  assert.equal(isReleaseMerge([pr()], { sha, repository }), true)
})

test('ordinary merges, forks, other commits and unmerged pull requests are not releases', () => {
  assert.equal(isReleaseMerge([pr({ head: { ref: 'feature', repo: { full_name: repository } } })], { sha, repository }), false)
  assert.equal(isReleaseMerge([pr({ head: { ref: 'changeset-release/main', repo: { full_name: 'someone/fork' } } })], { sha, repository }), false)
  assert.equal(isReleaseMerge([pr({ merge_commit_sha: 'b'.repeat(40) })], { sha, repository }), false)
  assert.equal(isReleaseMerge([pr({ merged_at: null })], { sha, repository }), false)
  assert.equal(isReleaseMerge([], { sha, repository }), false)
})
