# PR auto-update and conflict handling

This action is used to automatically update a PR with the latest changes from the base branch
and label or draft it PR if there are any conflicts.

## Example usage

```yaml
name: auto-update PRs & label conflicts
on:
  # The push event is the most important event.
  # This event should allow any branch that is going to be used as a target branch for a PR.
  # This event is responsible for updating the PRs with the latest changes from the base branch,
  # and adding the 'conflict' label if there are any conflicts.
  push:
    branches:
      - main
  # can also be used with the pull_request event
  pull_request_target:
    types:
      # If you are using the "label conflicts" feature,
      # This event will be used to remove the 'conflict' label when the PR is updated and the conflicts are resolved.
      - synchronize
      # OPTIONAL: If you use the "label conflicts" feature, adding these two types
      # will allow the workflow to correct any label incorrectly added or removed by a user.
      # It is also useful to run the workflow when labels change
      # if one of the x-requires-labels or x-excluded-labels option is used.
      - labeled
      - unlabeled
      # OPTIONAL: If you are using the "auto merge" feature, and
      # "update-requires-auto-merge" is set to true, this event will be used to update the PR
      # as soon as the auto-merge is enabled.
      - auto_merge_enabled
      # OPTIONAL: If you use "conflict-requires-ready-state" or "update-requires-ready-state",
      # then using one of the following types will allow the workflow
      # to execute as soon as they are in the specified state.
      - ready_for_review
      - converted_to_draft
      # OPTIONAL: In case a PR is opened in an already conflicted or outdated state
      - opened
      # OPTIONAL: The workflow does not run on closed PRs, so this allows the workflow to update
      # the state of the PR if it is reopened.
      - reopened
jobs:
  autoupdate:
    runs-on: ubuntu-latest
    steps:
      # This step is only necessary if you want to update branches from forks,
      # as it uses a completely different process (git) than updating branches from the same repository (api call).
      - name: Configure git
        run: |
          # The username of the "UPDATE_FORK_PAT" owner
          git config --global user.name "username"
          # The email of the "UPDATE_FORK_PAT" owner
          git config --global user.email "email@example.com"
      - uses: sequelize/pr-auto-update-and-handle-conflicts@v1
        with:
          conflict-label: 'conflicted'
          conflict-requires-ready-state: 'ready_for_review'
          conflict-excluded-authors: 'bot/renovate'
          update-pr-branches: true
          update-requires-auto-merge: true
          update-requires-ready-state: 'ready_for_review'
          update-excluded-authors: 'bot/renovate'
          update-excluded-labels: 'no-autoupdate'
        env:
          # The GITHUB_TOKEN to use for all operations, unless one of the two properties
          # below are specified.
          GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}'

          # The default GITHUB_TOKEN does not cause the branch update to trigger subsequent workflows, 
          # which means that CI checks will not run on the updated branch.
          # To solve this, you need to use a different token. Either one that belongs to a user, or to a GitHub App.
          # Defaults to the GITHUB_TOKEN env
          UPDATE_BRANCH_PAT: '${{ secrets.UPDATE_BRANCH_PAT }}'
          
          # Same reasoning as UPDATE_BRANCH_PAT, but for updating branches from a fork.
          # This one _requires_ using a user PAT. A GitHub App PAT will not work if the update includes workflow files.
          # This token must have the Read & Write permissions for "contents" and "workflows"
          # If you do not want to update branches from forks, you can set the "update-requires-source" option to "branches"
          # Defaults to the GITHUB_TOKEN env
          UPDATE_FORK_PAT: '${{ secrets.PAT }}'
          UPDATE_FORK_USERNAME: 'ephys'
```

## Options

Take a look at [action.yml](./action.yml) for the full list of options.
