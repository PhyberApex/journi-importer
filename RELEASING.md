# Releasing

Every release is manual and runs from a clean checkout of `main`. The registry pins the sha256 of each release artifact, so a published version can never change; a mistake means a new version.

## Before

1. `main` is green: the latest run of the **e2e** workflow passed with the real Journi account.
2. `git status` is clean and `git pull` is up to date.
3. `gh auth status` shows the PhyberApex account.

## Steps

1. Pick the version: patch for fixes, minor for new behaviour, major for anything that changes what an installed plugin does with existing data.
2. Set `version` in `trek-plugin.json` and `package.json` to the new number.
3. Add a `## X.Y.Z` section at the top of `CHANGELOG.md` that says what changed for a user.
4. Commit and push: `git commit -am "Release vX.Y.Z" && git push`.
5. Publish:

   ```bash
   npx trek-plugin-sdk publish --repo PhyberApex/journi-importer --tag vX.Y.Z
   ```

   This checks the registry gates, packs `plugin.zip`, tags and pushes, creates the GitHub release with the artifact, runs preflight against the release, and opens a pull request against liketrek/TREK-Plugins from the PhyberApex fork. Do not pass `--sign`: the plugin ships unsigned, and signing can never be removed once used.
6. Note the registry pull request URL. The new version reaches TREK's plugin store when a registry maintainer merges it.

## When something fails

- A failed gate in step 5 happens before anything is tagged. Fix it, commit, push, rerun the same command.
- A later failure rolls back the tag and the release. Rerun the same command after fixing.
- A release that already exists and was never merged into the registry can be overwritten with `--force`. Never use it for a merged version.
- "remote upstream already exists" during the submit step is harmless.

## Checking a release

```bash
gh release view vX.Y.Z --repo PhyberApex/journi-importer
gh pr list --repo liketrek/TREK-Plugins --author PhyberApex
```
