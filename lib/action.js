import core from '@actions/core';
import github from '@actions/github';
import { isString } from '@sequelize/utils';
import fs from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
isString.assert(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN env must be provided');
const githubBot = github.getOctokit(process.env.GITHUB_TOKEN);
/**
 * Execute actions as an actual user. This is necessary to update the PR branch.
 */
const userBot = process.env.PAT ? github.getOctokit(process.env.PAT) : githubBot;
function getCommaSeparatedInput(name) {
    return core
        .getInput(name)
        .split(',')
        .map(label => label.trim());
}
function getEnumInput(name, values) {
    const value = core.getInput(name);
    if (!values.includes(value)) {
        throw new Error(`${name} must be one of ${values.join(', ')}.`);
    }
    return value;
}
const READY_STATES = ['all', 'draft', 'ready_for_review'];
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
const updatedPrs = [];
const conflictedPrs = [];
switch (process.env.GITHUB_EVENT_NAME) {
    case 'push':
        await processPushEvent();
        break;
    case 'pull_request':
    case 'pull_request_target':
        await processPullRequestEvent();
        break;
    default:
        throw new Error(`Event ${process.env.GITHUB_EVENT_NAME} is not supported. Only push, pull_request, and pull_request_target are supported.`);
}
core.setOutput('updated-prs', updatedPrs.join(','));
core.setOutput('conflicted-prs', conflictedPrs.join(','));
async function processPushEvent() {
    isString.assert(process.env.GITHUB_EVENT_PATH);
    const { ref, repository } = JSON.parse(
    // @ts-expect-error -- JSON.parse accepts Buffers
    await fs.readFile(process.env.GITHUB_EVENT_PATH));
    const HEADS_PREFIX = 'refs/heads/';
    if (!ref.startsWith(HEADS_PREFIX)) {
        return;
    }
    const targetBranch = ref.slice(HEADS_PREFIX.length);
    const repositoryId = {
        repo: repository.name,
        owner: repository.owner.name ?? repository.owner.login,
    };
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
    await fs.readFile(process.env.GITHUB_EVENT_PATH));
    const repositoryId = {
        repo: repository.name,
        owner: repository.owner.name ?? repository.owner.login,
    };
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
async function processPr(repositoryId, pullRequest) {
    switch (pullRequest.mergeable) {
        case 'CONFLICTING':
            await handleConflict(repositoryId, pullRequest);
            break;
        case 'MERGEABLE': {
            const promises = [
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
function prHasAnyLabel(pullRequest, labels) {
    return pullRequest.labels.nodes.some(label => labels.includes(label.name));
}
async function updatePrBranch(repositoryId, pullRequest) {
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
    // This operation cannot be done with GITHUB_TOKEN, as the GITHUB_TOKEN does not trigger subsequent workflows.
    return userBot.rest.pulls.updateBranch({
        ...repositoryId,
        pull_number: pullRequest.number,
    });
}
async function checkPrIsBehindTarget(repositoryId, pullRequest) {
    const response = await githubBot.graphql(`
      query ($owner: String!, $repository:String!, $baseRef:String!, $headRef:String!) {
        repository(owner:$owner, name: $repository) {
          ref(qualifiedName: $baseRef) {
            compare(headRef: $headRef) {
              behindBy
            }
          }
        }
      }
    `, {
        owner: repositoryId.owner,
        repository: repositoryId.repo,
        baseRef: pullRequest.baseRef.name,
        headRef: pullRequest.headRef.name,
    });
    return response.repository.ref.compare.behindBy > 0;
}
async function handleConflict(repositoryId, pullRequest) {
    if (!conflictLabel && !conflictMarksAsDraft) {
        return;
    }
    if (!isConflictManagementEnabledForPr(pullRequest)) {
        return;
    }
    conflictedPrs.push(pullRequest.number);
    const promises = [];
    if (conflictLabel && !pullRequest.labels.nodes.some(label => label.name === conflictLabel)) {
        console.info(`[PR ${pullRequest.number}] Adding conflict label.`);
        promises.push(githubBot.rest.issues.addLabels({
            ...repositoryId,
            issue_number: pullRequest.number,
            labels: [conflictLabel],
        }));
    }
    if (conflictMarksAsDraft) {
        console.info(`[PR ${pullRequest.number}] Marking as draft due to conflicts.`);
        promises.push(githubBot.rest.pulls.update({
            ...repositoryId,
            pull_number: pullRequest.number,
            draft: true,
        }));
    }
    await Promise.all(promises);
}
async function removeConflictLabel(repositoryId, pullRequest) {
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
    await githubBot.rest.issues.removeLabel({
        ...repositoryId,
        issue_number: pullRequest.number,
        name: conflictLabel,
    });
}
async function getPullRequest(params) {
    const response = await githubBot.graphql(`
      ${pullRequestFragment}

      query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            ...PR
          }
        }
      }
    `, params);
    return response.repository.pullRequest;
}
async function* iteratePullRequests(params) {
    let cursor = null;
    while (true) {
        // eslint-disable-next-line no-await-in-loop -- fine in async iterators
        const response = await githubBot.graphql(`
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
      `, {
            ...params,
            cursor,
        });
        for (const pullRequest of response.search.nodes) {
            yield pullRequest;
        }
        if (response.search.pageInfo.hasNextPage) {
            break;
        }
        cursor = response.search.pageInfo.endCursor;
    }
}
function getUserIdentity(author) {
    if (author.__typename === 'Bot') {
        return `app/${author.login}`;
    }
    return author.login;
}
function prMatchesReadyState(pullRequest, readyState) {
    switch (readyState) {
        case 'all':
            return true;
        case 'draft':
            return pullRequest.isDraft;
        case 'ready_for_review':
            return !pullRequest.isDraft;
    }
}
function isConflictManagementEnabledForPr(pullRequest) {
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
