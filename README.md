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
          # The GITHUB_TOKEN will handle operations that the GitHub Bot can perform,
          # such as searching the repository, adding/removing labels, and drafting PRs.
          GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}'
          # The PAT is used to perform operations that the GitHub Bot cannot perform: updating the PR branch
          # If not specified, the GITHUB_TOKEN will be used, in which case the GITHUB_TOKEN must be one
          # with the necessary permission to update the PR branch (assuming the feature is enabled).
          PAT: '${{ secrets.PAT }}'
```

## Options

Take a look at [action.yml](./action.yml) for the full list of options.
