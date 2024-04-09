import core from '@actions/core';
import github from '@actions/github';
import type { PullRequestEvent, PushEvent } from '@octokit/webhooks-types';
import { isString } from '@sequelize/utils';
import fs from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

isString.assert(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN env must be provided');

const githubBot = github.getOctokit(process.env.GITHUB_TOKEN);

/**
 * Execute actions as an actual user. This is necessary to update the PR branch.
 */
const userBot = process.env.PAT ? github.getOctokit(process.env.PAT) : githubBot;

function getCommaSeparatedInput(name: string) {
  return core
    .getInput(name)
    .split(',')
    .map(label => label.trim());
}

function getEnumInput<T extends string>(name: string, values: readonly T[]): T {
  const value = core.getInput(name);
  if (!values.includes(value as T)) {
    throw new Error(`${name} must be one of ${values.join(', ')}.`);
  }

  return value as T;
}

const READY_STATES = ['all', 'draft', 'ready_for_review'] as const;

const dryRun = core.getBooleanInput('dry-run');

const conflictLabel = core.getInput('conflict-label');
const conflictMarksAsDraft = core.getBooleanInput('conflict-marks-as-draft');
const conflictRequiresReadyState = getEnumInput('conflict-requires-ready-state', READY_STATES);
const conflictRequiresLabels = getCommaSeparatedInput('conflict-requires-labels');
const conflictExcludedLabels = getCommaSeparatedInput('conflict-excluded-labels');
const conflictExcludedAuthors = getCommaSeparatedInput('conflict-excluded-authors');

const updatePrBranches = core.getBooleanInput('update-pr-branches');
const updateRequiresAutoMerge = core.getBooleanInput('update-requires-auto-merge');
const updateRequiresReadyState = getEnumInput('update-requires-ready-state', READY_STATES);
const updateRequiresLabels = getCommaSeparatedInput('update-requires-labels');
const updateExcludedLabels = getCommaSeparatedInput('update-excluded-labels');
const updateExcludedAuthors = getCommaSeparatedInput('update-excluded-authors');

interface RepositoryId {
  owner: string;
  repo: string;
}

interface PullRequest {
  author: {
    __typename: 'Bot' | 'User' | string;
    login: string;
  };
  autoMergeRequest: null | {
    enabledAt: string;
  };
  baseRef: { name: string };
  headRef: { name: string };
  isDraft: boolean;
  labels: {
    nodes: [
      {
        name: string;
      },
    ];
  };
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  number: number;
}

const pullRequestFragment = `
fragment PR on PullRequest {
  author {
    __typename
    login
  }
  number
  mergeable
  isDraft
  autoMergeRequest {
    enabledAt
  }
  labels(first: 100) {
    nodes {
      name
    }
  }
  baseRef { name }
  headRef { name }
}
`;

const updatedPrs: number[] = [];
const conflictedPrs: number[] = [];

switch (process.env.GITHUB_EVENT_NAME) {
  case 'push':
  case 'workflow_dispatch':
    await processPushEvent();
    break;

  case 'pull_request':
  case 'pull_request_target':
    await processPullRequestEvent();
    break;

  default:
    throw new Error(
      `Event ${process.env.GITHUB_EVENT_NAME} is not supported. Only push, workflow_dispatch, pull_request, and pull_request_target are supported.`,
    );
}

core.setOutput('updated-prs', updatedPrs.join(','));
core.setOutput('conflicted-prs', conflictedPrs.join(','));

async function processPushEvent() {
  isString.assert(process.env.GITHUB_EVENT_PATH);

  const { ref, repository } = JSON.parse(
    // @ts-expect-error -- JSON.parse accepts Buffers
    await fs.readFile(process.env.GITHUB_EVENT_PATH),
  ) as unknown as PushEvent;

  const HEADS_PREFIX = 'refs/heads/';
  if (!ref.startsWith(HEADS_PREFIX)) {
    return;
  }

  const targetBranch = ref.slice(HEADS_PREFIX.length);
  const repositoryId = {
    repo: repository.name,
    owner: repository.owner.name ?? repository.owner.login,
  } as const;

  /**
   * Conflict state is not computed instantaneously.
   * This gives GitHub 5 seconds to compute it.
   */
  await setTimeout(5000);

  const search = `repo:${repositoryId.owner}/${repositoryId.repo} is:open is:pr base:${targetBranch}`;
  for await (const pullRequest of iteratePullRequests({ search })) {
    await processPr(repositoryId, pullRequest);
  }
}

async function processPullRequestEvent() {
  isString.assert(process.env.GITHUB_EVENT_PATH);

  const { action, number, repository } = JSON.parse(
    // @ts-expect-error -- JSON.parse accepts Buffers
    await fs.readFile(process.env.GITHUB_EVENT_PATH),
  ) as unknown as PullRequestEvent;

  const repositoryId = {
    repo: repository.name,
    owner: repository.owner.name ?? repository.owner.login,
  } as const;

  if (action === 'opened' || action === 'synchronize') {
    /**
     * These actions modify the commit history of the PR, which recomputes the conflict state.
     *
     * The conflict state is not computed instantaneously.
     * This gives GitHub 5 seconds to compute it.
     */
    await setTimeout(5000);
  }

  const pullRequest = await getPullRequest({ ...repositoryId, number });

  await processPr(repositoryId, pullRequest);
}

async function processPr(repositoryId: RepositoryId, pullRequest: PullRequest) {
  switch (pullRequest.mergeable) {
    case 'CONFLICTING':
      await handleConflict(repositoryId, pullRequest);
      break;

    case 'MERGEABLE': {
      const promises: Array<Promise<any>> = [
        removeConflictLabel(repositoryId, pullRequest),
        updatePrBranch(repositoryId, pullRequest),
      ];

      await Promise.all(promises);

      break;
    }

    case 'UNKNOWN': {
      console.info(`[PR ${pullRequest.number}] Conflict state is not yet known. Retrying.`);
      // Conflicting state has not been computed yet. Try again in one second
      await setTimeout(1000);

      const updatedPr = await getPullRequest({ ...repositoryId, number: pullRequest.number });
      await processPr(repositoryId, updatedPr);

      break;
    }
  }
}

function prHasAnyLabel(pullRequest: PullRequest, labels: string[]) {
  return pullRequest.labels.nodes.some(label => labels.includes(label.name));
}

async function updatePrBranch(repositoryId: RepositoryId, pullRequest: PullRequest) {
  if (!updatePrBranches) {
    return;
  }

  if (updateRequiresAutoMerge && !pullRequest.autoMergeRequest) {
    return;
  }

  if (updateRequiresLabels.length > 0 && !prHasAnyLabel(pullRequest, updateRequiresLabels)) {
    return;
  }

  if (updateExcludedLabels.length > 0 && prHasAnyLabel(pullRequest, updateRequiresLabels)) {
    return;
  }

  if (updateExcludedAuthors.includes(getUserIdentity(pullRequest.author))) {
    return;
  }

  if (!prMatchesReadyState(pullRequest, updateRequiresReadyState)) {
    return;
  }

  const isBehind = await checkPrIsBehindTarget(repositoryId, pullRequest);
  if (!isBehind) {
    return;
  }

  updatedPrs.push(pullRequest.number);

  console.info(`[${pullRequest.number}] Updating branch.`);

  if (!dryRun) {
    // This operation cannot be done with GITHUB_TOKEN, as the GITHUB_TOKEN does not trigger subsequent workflows.
    return userBot.rest.pulls.updateBranch({
      ...repositoryId,
      pull_number: pullRequest.number,
    });
  }
}

interface CompareBranchResponse {
  repository: {
    ref: {
      compare: {
        behindBy: number;
      };
    };
  };
}

async function checkPrIsBehindTarget(
  repositoryId: RepositoryId,
  pullRequest: PullRequest,
): Promise<boolean> {
  const response: CompareBranchResponse = await githubBot.graphql(
    `
      query ($owner: String!, $repository:String!, $baseRef:String!, $headRef:String!) {
        repository(owner:$owner, name: $repository) {
          ref(qualifiedName: $baseRef) {
            compare(headRef: $headRef) {
              behindBy
            }
          }
        }
      }
    `,
    {
      owner: repositoryId.owner,
      repository: repositoryId.repo,
      baseRef: pullRequest.baseRef.name,
      headRef: pullRequest.headRef.name,
    },
  );

  return response.repository.ref.compare.behindBy > 0;
}

async function handleConflict(repositoryId: RepositoryId, pullRequest: PullRequest): Promise<void> {
  if (!conflictLabel && !conflictMarksAsDraft) {
    return;
  }

  if (!isConflictManagementEnabledForPr(pullRequest)) {
    return;
  }

  conflictedPrs.push(pullRequest.number);

  const promises: Array<Promise<any>> = [];
  if (conflictLabel && !pullRequest.labels.nodes.some(label => label.name === conflictLabel)) {
    console.info(`[PR ${pullRequest.number}] Adding conflict label.`);

    if (!dryRun) {
      promises.push(
        githubBot.rest.issues.addLabels({
          ...repositoryId,
          issue_number: pullRequest.number,
          labels: [conflictLabel],
        }),
      );
    }
  }

  if (conflictMarksAsDraft) {
    console.info(`[PR ${pullRequest.number}] Marking as draft due to conflicts.`);

    if (!dryRun) {
      promises.push(
        githubBot.rest.pulls.update({
          ...repositoryId,
          pull_number: pullRequest.number,
          draft: true,
        }),
      );
    }
  }

  await Promise.all(promises);
}

async function removeConflictLabel(
  repositoryId: RepositoryId,
  pullRequest: PullRequest,
): Promise<void> {
  if (!conflictLabel) {
    return;
  }

  if (!isConflictManagementEnabledForPr(pullRequest)) {
    return;
  }

  if (!pullRequest.labels.nodes.some(label => label.name === conflictLabel)) {
    return;
  }

  console.info(`[PR ${pullRequest.number}] No conflict, removing conflict label.`);
  if (!dryRun) {
    await githubBot.rest.issues.removeLabel({
      ...repositoryId,
      issue_number: pullRequest.number,
      name: conflictLabel,
    });
  }
}

interface GetPrResponse {
  repository: {
    pullRequest: PullRequest;
  };
}

async function getPullRequest(params: { number: number; owner: string; repo: string }) {
  const response: GetPrResponse = await githubBot.graphql(
    `
      ${pullRequestFragment}

      query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            ...PR
          }
        }
      }
    `,
    params,
  );

  return response.repository.pullRequest;
}

interface IterateResponse {
  search: {
    nodes: [PullRequest];
    pageInfo: {
      endCursor: string;
      hasNextPage: boolean;
    };
  };
}

async function* iteratePullRequests(params: { search: string }) {
  let cursor = null;

  while (true) {
    // eslint-disable-next-line no-await-in-loop -- fine in async iterators
    const response: IterateResponse = await githubBot.graphql(
      `
        ${pullRequestFragment}

        query ($search: String!) {
          search(
            first: 100
            type: ISSUE
            query: $search
          ) {
            nodes {
              ...PR
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      `,
      {
        ...params,
        cursor,
      },
    );

    for (const pullRequest of response.search.nodes) {
      yield pullRequest;
    }

    if (response.search.pageInfo.hasNextPage) {
      break;
    }

    cursor = response.search.pageInfo.endCursor;
  }
}

function getUserIdentity(author: PullRequest['author']) {
  if (author.__typename === 'Bot') {
    return `app/${author.login}`;
  }

  return author.login;
}

function prMatchesReadyState(pullRequest: PullRequest, readyState: (typeof READY_STATES)[number]) {
  switch (readyState) {
    case 'all':
      return true;

    case 'draft':
      return pullRequest.isDraft;

    case 'ready_for_review':
      return !pullRequest.isDraft;
  }
}

function isConflictManagementEnabledForPr(pullRequest: PullRequest) {
  if (!prMatchesReadyState(pullRequest, conflictRequiresReadyState)) {
    return false;
  }

  if (conflictRequiresLabels.length > 0 && !prHasAnyLabel(pullRequest, conflictRequiresLabels)) {
    return false;
  }

  if (conflictExcludedLabels.length > 0 && prHasAnyLabel(pullRequest, conflictExcludedLabels)) {
    return false;
  }

  if (conflictExcludedAuthors.includes(getUserIdentity(pullRequest.author))) {
    return false;
  }

  return true;
}
