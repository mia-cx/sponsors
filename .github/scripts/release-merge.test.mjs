import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isReleaseMerge, releaseValidated } from './release-merge.mjs'

const repository = 'mia-cx/sponsors'
const sha = 'a'.repeat(40)
const head = 'b'.repeat(40)
const pr = (overrides = {}) => ({
  number: 7,
  merged_at: '2026-10-20T00:00:00Z',
  merge_commit_sha: sha,
  base: { ref: 'main' },
  head: { sha: head, ref: 'changeset-release/main', repo: { full_name: repository } },
  ...overrides,
})

const run = (overrides = {}) => ({
  event: 'pull_request',
  path: '.github/workflows/ci.yml',
  head_sha: head,
  head_branch: 'changeset-release/main',
  head_repository: { full_name: repository },
  // GitHub drops merged PRs from this list, including sponsors release PR #7.
  pull_requests: [],
  status: 'completed',
  conclusion: 'success',
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
  assert.equal(isReleaseMerge([pr({ base: { ref: 'staging' } })], { sha, repository }), false)
  assert.equal(isReleaseMerge([], { sha, repository }), false)
})

test('CI on the exact release PR head is reusable even after its pull_requests list empties', () => {
  assert.equal(releaseValidated([run()], pr()), true)
  assert.equal(releaseValidated([run({ path: '.github/workflows/ci.yml@refs/pull/7/merge' })], pr()), true)
})

test('CI must match the workflow, event, head, branch, repository and successful completion', () => {
  for (const overrides of [
    { event: 'push' },
    { path: '.github/workflows/other.yml' },
    { path: undefined },
    { head_sha: 'c'.repeat(40) },
    { head_branch: 'feature' },
    { head_repository: { full_name: 'someone/fork' } },
    { head_repository: null },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: null },
  ]) {
    assert.equal(releaseValidated([run(overrides)], pr()), false, JSON.stringify(overrides))
  }
  assert.equal(releaseValidated([], pr()), false)
})

test('validation fetches a missing PR head and fails closed for changed trees, retries and lookup errors', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'sponsors-release-'))
  const source = join(temporary, 'source')
  const checkout = join(temporary, 'checkout')
  const bin = join(temporary, 'bin')
  const script = fileURLToPath(new URL('./release-merge.mjs', import.meta.url))
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    mkdirSync(source)
    mkdirSync(bin)
    git(source, 'init', '-b', 'main')
    git(source, 'config', 'user.name', 'Release test')
    git(source, 'config', 'user.email', 'release@example.com')
    writeFileSync(join(source, 'file'), 'validated tree\n')
    git(source, 'add', 'file')
    git(source, 'commit', '-m', 'PR head')
    const headSha = git(source, 'rev-parse', 'HEAD')
    git(source, 'update-ref', 'refs/pull/7/head', headSha)
    git(source, 'commit', '--allow-empty', '-m', 'Squash merge with the same tree')
    const mergeSha = git(source, 'rev-parse', 'HEAD')
    git(temporary, 'clone', '--no-local', '--depth=1', source, checkout)
    assert.notEqual(spawnSync('git', ['cat-file', '-e', headSha], { cwd: checkout }).status, 0)
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
if (process.env.FAIL_API) process.exit(1)
process.stdout.write(process.env.RUN_PAGES)
`, { mode: 0o755 })
    const pullRequest = pr({ merge_commit_sha: mergeSha, head: { ...pr().head, sha: headSha } })
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      // Require pagination: the matching run can be on a later API page.
      RUN_PAGES: JSON.stringify([{ workflow_runs: [] }, { workflow_runs: [run({ head_sha: headSha })] }]),
    }
    const validate = (overrides = {}, pulls = [pullRequest], target = mergeSha) => {
      const result = spawnSync(process.execPath, [script, target, repository, 'validated'], {
        cwd: checkout,
        env: { ...env, ...overrides },
        input: JSON.stringify([pulls]),
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      return result
    }
    assert.equal(validate().stdout, 'true\n')
    assert.equal(git(checkout, 'rev-parse', `${headSha}^{tree}`), git(checkout, 'rev-parse', `${mergeSha}^{tree}`))
    for (const overrides of [
      { GITHUB_EVENT_NAME: 'workflow_dispatch' },
      { GITHUB_REF: 'refs/heads/staging' },
      { RUN_PAGES: '[{"workflow_runs":[]}]' },
    ]) {
      assert.equal(validate(overrides).stdout, 'false\n')
    }
    assert.equal(validate({}, []).stdout, 'false\n')
    assert.equal(validate({}, [pr({ ...pullRequest, merged_at: null })]).stdout, 'false\n')
    for (const overrides of [{ FAIL_API: '1' }, { RUN_PAGES: 'invalid JSON' }]) {
      const result = validate(overrides)
      assert.equal(result.stdout, 'false\n')
      assert.match(result.stderr, /::warning::Unable to reuse/)
    }
    writeFileSync(join(source, 'file'), 'changed after validation\n')
    git(source, 'commit', '-am', 'Different merge tree')
    const differentSha = git(source, 'rev-parse', 'HEAD')
    git(checkout, 'fetch', 'origin', differentSha)
    const mismatch = validate({}, [{ ...pullRequest, merge_commit_sha: differentSha }], differentSha)
    assert.equal(mismatch.stdout, 'false\n')
    assert.match(mismatch.stderr, /::warning::Release PR tree differs/)
    git(source, 'update-ref', '-d', 'refs/pull/7/head')
    const missingRef = validate()
    assert.equal(missingRef.stdout, 'false\n')
    assert.match(missingRef.stderr, /::warning::Unable to reuse/)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('deploy skips only checks covered by CI and still builds, migrates, deploys and tags', () => {
  const workflow = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8')
  const ci = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8')
  const [version, deploy] = workflow.split('\n  deploy:')
  assert.match(version, /actions: read/)
  assert.match(version, /validated: \$\{\{ steps.validate.outputs.validated \}\}/)
  assert.match(version, /if: github.event_name == 'push' && steps.target.outputs.release == 'true'/)
  assert.match(version, /node .github\/scripts\/release-merge.mjs .* validated < "\$RUNNER_TEMP\/pulls.json"/)
  assert.match(version, /echo "validated=\$validated" >> "\$GITHUB_OUTPUT"/)
  assert.match(deploy, /needs: version\n    if: needs.version.outputs.release == 'true'/)
  assert.equal((deploy.match(/if:/g) ?? []).length, 3)
  for (const command of ['pnpm check', 'pnpm test']) {
    assert.ok(ci.includes(`- run: ${command}\n`))
    assert.ok(deploy.includes(`- run: ${command}\n        if: needs.version.outputs.validated != 'true'`))
  }
  for (const command of ['pnpm build', 'wrangler d1 migrations apply DB --remote', 'wrangler deploy --message', 'gh release create']) {
    assert.ok(deploy.includes(command))
  }
})
