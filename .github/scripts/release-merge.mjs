import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Find the merged release PR that authorizes publication of this exact commit. */
export const releasePullRequest = (pullRequests, { sha, repository }) =>
  pullRequests.find(
    (pr) =>
      typeof pr.merged_at === 'string' &&
      pr.merge_commit_sha === sha &&
      pr.base.ref === 'main' &&
      pr.head.ref === 'changeset-release/main' &&
      pr.head.repo?.full_name === repository,
  )

/** Only a merged release PR from this repository authorizes publication of this exact commit. */
export const isReleaseMerge = (pullRequests, context) => Boolean(releasePullRequest(pullRequests, context))

/** Reuse only CI for this release PR head; GitHub empties pull_requests after merging. */
export const releaseValidated = (workflowRuns, pullRequest) =>
  workflowRuns.some(
    (run) =>
      run.event === 'pull_request' &&
      run.path?.split('@')[0] === '.github/workflows/ci.yml' &&
      run.head_sha === pullRequest.head.sha &&
      run.head_branch === pullRequest.head.ref &&
      run.head_repository?.full_name === pullRequest.head.repo.full_name &&
      run.status === 'completed' &&
      run.conclusion === 'success',
  )

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const validated = (pullRequests, context) => {
  if (process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') return false
  const pullRequest = releasePullRequest(pullRequests, context)
  if (!pullRequest?.head.sha) return false
  const pages = JSON.parse(execFileSync('gh', [
    'api',
    `repos/${context.repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pullRequest.head.sha}&status=success&per_page=100`,
    '--paginate', '--slurp',
  ], { encoding: 'utf8' }))
  if (!releaseValidated(pages.flatMap((page) => page.workflow_runs), pullRequest)) return false
  // Squash merges and deleted branches can leave the PR head out of the checkout.
  git('fetch', '--no-tags', 'origin', `refs/pull/${pullRequest.number}/head`)
  if (git('rev-parse', `${context.sha}^{tree}`) === git('rev-parse', `${pullRequest.head.sha}^{tree}`)) return true
  console.warn('::warning::Release PR tree differs from the merge; running fresh checks.')
  return false
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sha, repository, mode] = process.argv.slice(2)
  if (!sha || !repository) throw new Error('release-merge needs a commit SHA and repository')
  if (mode === 'validated') {
    let result = false
    try {
      result = validated(JSON.parse(readFileSync(0, 'utf8')).flat(), { sha, repository })
    } catch (cause) {
      console.warn('::warning::Unable to reuse release PR validation; running fresh checks.', cause.message)
    }
    process.stdout.write(`${result}\n`)
  } else {
    const pages = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(`${isReleaseMerge(pages.flat(), { sha, repository })}\n`)
  }
}
