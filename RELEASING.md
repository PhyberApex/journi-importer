# Releasing

Releases are signed and run from GitHub Actions. The registry pins the sha256 and the signature of each release artifact, so a published version can never change; a mistake means a new version. TREK refuses an unsigned update once a plugin has shipped signed, so every release from 1.1.0 on must be signed with the same key.

## One-time setup

| Where | What |
|---|---|
| Repository secret `TREK_SIGNING_KEY` | The content of `~/.trek-plugin/signing.key` from the machine that generated it. One key for all PhyberApex plugins. |
| Repository secret `RELEASE_TOKEN` | A classic GitHub personal access token with the `public_repo` scope. It pushes the release commit and tag, creates the release, pushes to the PhyberApex fork of TREK-Plugins and opens the registry pull request. The workflow token cannot reach the registry. |
| Repository secrets `JOURNI_EMAIL`, `JOURNI_PASSWORD` | The Journi account the end-to-end test imports from. |
| A backup of the signing key | Password manager or similar, outside this machine. Losing the key means a key rotation, which a registry maintainer must approve and every admin must re-trust. |

## Releasing a version

1. `main` is what you want to ship and its latest **e2e** run is green.
2. Open Actions → **release** → Run workflow. Fill in:
   - `version`: the new number, like `1.1.0`. Patch for fixes, minor for new behaviour, major for anything that changes what an installed plugin does with existing data.
   - `notes`: the changelog lines for users, one per line starting with `- `. Leave empty when `CHANGELOG.md` already has a `## 1.1.0` section.
   - `dry_run`: tick it to rehearse. The run then checks, packs and signs, shows the diff it would commit, and stops.
3. The run, in order: end-to-end import against Journi, version bump in both manifests plus the changelog section, commit `Release v1.1.0` on main, the SDK's publish with signing: registry gates, pack, tag, GitHub release with the artifact, preflight, pull request against liketrek/TREK-Plugins.
4. The run summary lists the release and the registry pull request. The version reaches TREK's plugin store when a registry maintainer merges that pull request.

## When something fails

- The e2e step fails: Journi or the import changed. Fix on main first, nothing was released.
- A failed registry gate happens before anything is tagged. Fix it, push, rerun with the same version.
- A later failure rolls back the tag and the release. Rerun with the same version after fixing. The release commit on main stays, which is fine; the rerun sees the manifests already at that version and skips the bump.
- A release that already exists and was never merged into the registry can be overwritten by running the publish command locally with `--force`. Never use it for a merged version.

## Manual fallback

From a clean, up-to-date checkout of `main` with the signing key at `~/.trek-plugin/signing.key` and `gh` authenticated as PhyberApex:

```bash
node scripts/prepare-release.js 1.1.0 "- what changed"
git commit -am "Release v1.1.0" && git push
npx trek-plugin-sdk publish --repo PhyberApex/journi-importer --tag v1.1.0 --sign --notes "$(node scripts/prepare-release.js --notes 1.1.0)"
```

## Checking a release

```bash
gh run list --workflow release --repo PhyberApex/journi-importer
gh release view v1.1.0 --repo PhyberApex/journi-importer
gh pr list --repo liketrek/TREK-Plugins --author PhyberApex
```
