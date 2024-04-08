import core from '@actions/core';
import github from '@actions/github';
import type { PullRequestEvent, PushEvent } from '@octokit/webhooks-types';
import { isString } from '@sequelize/utils';
import fs from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

// TODO:
// - compile script
// - add README
// - support the following options
//   - conflict-marks-as-draft:
//   - conflict-notify-comment:
//   - conflict-requires-ready-state:
//   - conflict-requires-labels:
//   - conflict-excluded-labels:
//   - conflict-excluded-authors:
//   - update-requires-auto-merge:
//   - update-requires-ready-state:
//   - update-requires-labels:
//   - update-excluded-labels:
//   - update-excluded-authors:

const PREFIX_HEAD = 'refs/heads/';

isString.assert(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN env must be provided');

const githubBot = github.getOctokit(process.env.GITHUB_TOKEN);

/**
 * Execute actions as an actual user. This is necessary to update the PR branch.
 */
const userBot = process.env.PAT ? github.getOctokit(process.env.PAT) : githubBot;

const conflictLabel = core.getInput('conflict-label');

interface RepositoryId {
  owner: string;
  repo: string;
}

interface PullRequest {
  autoMergeRequest: null | {
    enabledAt: string;
  };
  baseRef: { name: string };
  headRef: { name: string };
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
  number
  mergeable
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

switch (process.env.GITHUB_EVENT_NAME) {
  case 'push':
    await processPushEvent();
    break;

  case 'pull_request':
  case 'pull_request_target':
    await processPullRequestEvent();
    break;

  default:
    throw new Error(
      `Event ${process.env.GITHUB_EVENT_NAME} is not supported. Only push, pull_request, and pull_request_target are supported.`,
    );
}

async function processPushEvent() {
  isString.assert(process.env.GITHUB_EVENT_PATH);

  const { ref, repository } = JSON.parse(
    // @ts-expect-error -- JSON.parse accepts Buffers
    await fs.readFile(process.env.GITHUB_EVENT_PATH),
  ) as unknown as PushEvent;

  const targetBranch = ref.replace(PREFIX_HEAD, '');
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
      await addConflictLabel(repositoryId, pullRequest);
      break;

    case 'MERGEABLE': {
      const promises: Array<Promise<any>> = [removeConflictLabel(repositoryId, pullRequest)];

      if (pullRequest.autoMergeRequest !== null) {
        promises.push(updatePrBranchIfBehind(repositoryId, pullRequest));
      }

      await Promise.all(promises);

      break;
    }

    case 'UNKNOWN': {
      console.info(`Conflict state of PR ${pullRequest.number} is not yet known. Retrying.`);
      // Conflicting state has not been computed yet. Try again in one second
      await setTimeout(1000);

      const updatedPr = await getPullRequest({ ...repositoryId, number: pullRequest.number });
      await processPr(repositoryId, updatedPr);

      break;
    }
  }
}

async function updatePrBranchIfBehind(repositoryId: RepositoryId, pullRequest: PullRequest) {
  const isBehind = await checkPrIsBehindTarget(repositoryId, pullRequest);
  if (!isBehind) {
    return;
  }

  console.info(`Updating PR ${pullRequest.number}.`);

  // This operation cannot be done with GITHUB_TOKEN, as the GITHUB_TOKEN does not trigger subsequent workflows.
  return userBot.rest.pulls.updateBranch({
    ...repositoryId,
    pull_number: pullRequest.number,
  });
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

async function addConflictLabel(
  repositoryId: RepositoryId,
  pullRequest: PullRequest,
): Promise<void> {
  if (pullRequest.labels.nodes.some(label => label.name === conflictLabel)) {
    return;
  }

  console.info(`PR ${pullRequest.number} has conflicts, adding conflict label.`);
  await githubBot.rest.issues.addLabels({
    ...repositoryId,
    issue_number: pullRequest.number,
    labels: [conflictLabel],
  });
}

async function removeConflictLabel(
  repositoryId: RepositoryId,
  pullRequest: PullRequest,
): Promise<void> {
  if (!pullRequest.labels.nodes.some(label => label.name === conflictLabel)) {
    return;
  }

  console.info(`PR ${pullRequest.number} does not have conflcits, removing conflict label.`);
  await githubBot.rest.issues.removeLabel({
    ...repositoryId,
    issue_number: pullRequest.number,
    name: conflictLabel,
  });
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
