# Releasing Localidraw

Localidraw is published to npm as [`localidraw`](https://www.npmjs.com/package/localidraw), and as a Docker image,
[`ghcr.io/edspencer/localidraw`](https://github.com/edspencer/localidraw/pkgs/container/localidraw). Every release
comes from GitHub Actions (`.github/workflows/release.yml`), with npm trusted publishing and a provenance attestation. Nobody
publishes a release from a laptop, and no npm token exists. (The one exception is the 0.0.1 placeholder, below.)

## How a release happens

1. **PRs carry changesets.** A PR with a user-facing change adds a `.changeset/*.md` file naming the bump (patch,
   minor or major) and a summary for users ([CONTRIBUTING.md](CONTRIBUTING.md#changesets)).
2. **The Release workflow keeps a version PR open.** On every push to `main` that leaves changesets pending, the
   `release` job runs `npm run changeset:version` and opens or updates a PR titled **"chore: version packages"**
   (branch `changeset-release/main`). That PR consumes the changesets into `CHANGELOG.md`, bumps `version` in
   `package.json` and refreshes `package-lock.json`. More changesets merged meanwhile get folded into the same PR.
3. **Merging the version PR releases.** That push leaves no changesets and a version with no `v<version>` tag, so
   the same workflow run goes on to:
   - `verify-ci`: wait for the CI run on the merge commit and require it to have passed (see below);
   - `publish-npm`: `npm publish` (`prepack` builds `dist/`), then check that the provenance attestation is visible
     on the registry;
   - `github-release`: create the tag `v<version>` at the merge commit, and a GitHub Release whose notes are that
     version's `CHANGELOG.md` section.

   - `build-image` and `publish-image`, alongside the npm jobs: the Docker image (below).

So you decide *when* to release by merging the version PR, and *what* the version is by the changesets. Nobody edits
`version` or `CHANGELOG.md` by hand. `workflow_dispatch` (Actions → Release → Run workflow) re-runs the pipeline for
the current `main`.

The tag and the Release come after npm, so a `v<version>` tag always means that version is on npm.

### The version PR's CI

The version PR is opened by `github-actions[bot]` with the workflow's `GITHUB_TOKEN`, and GitHub doesn't run CI for
it the usual way: workflow runs for a PR from that token aren't triggered (or are parked waiting for approval). Two
consequences:

- **A required check never reports on it.** If `main`'s ruleset requires `CI passed`, the version PR can't merge
  until CI runs. To get a real CI run, close the PR and reopen it (a person reopening it triggers CI), or merge with
  a ruleset bypass.
- **You can't ship unverified regardless.** CI on the push to `main` does run (a person merged it), and `verify-ci`
  blocks the publish unless that run concluded `success` on that exact commit. If it failed for a reason you judge
  unrelated (a flake), re-run CI until it's green, then re-run the Release workflow.

## The Docker image

`build-image` runs on native runners, `ubuntu-latest` for amd64 and `ubuntu-24.04-arm` for arm64, with no emulation.
Each builds the image, starts it and checks it with `scripts/smoke-image.sh`, which is the same check CI runs on every
PR (amd64 only). Only then does it push the image by digest. It also makes an SPDX SBOM of its architecture's image
and attests it next to the image. `publish-image` then merges the two digests with `docker buildx imagetools create`
into `ghcr.io/edspencer/localidraw:<version>` and `:latest`, and attests build provenance for the multi-arch digest.
Check a release with:

```sh
gh attestation verify oci://ghcr.io/edspencer/localidraw:<version> -R edspencer/localidraw
```

The jobs authenticate to GHCR with the workflow's `GITHUB_TOKEN` (`packages: write`), and sign the attestations
over OIDC (`id-token: write`, `attestations: write`). There's no registry secret.

**npm doesn't wait for the image, on purpose.** `publish-npm` needs only `verify-ci`, and `github-release` needs
only `publish-npm`, so a failed image build doesn't hold back the npm package, its tag or its GitHub Release. npm is
what most people install from, and it's the irreversible step that's been proven to work. The image is newer and has
more moving parts (two runners, GHCR, Sigstore).

If an image job fails for a passing reason (a runner, the registry), use **"Re-run failed jobs" on that same run**. A
fresh run of the workflow won't do it: by then `github-release` has tagged `v<version>`, so a new run finds nothing to
release. If the fix needs a code change, the image ships with the next version. Once a version's image tag exists it
never moves: `publish-image` leaves an existing `:<version>` alone rather than retag a rebuilt image whose digest
differs from the one people have pulled.

**The package's visibility.** GHCR makes a new package private. After the first image is pushed, Ed makes it public
once: the package's settings on GitHub → Change visibility → Public. It can also be linked to this repository there,
though the `org.opencontainers.image.source` label usually does that by itself.

## npm auth: trusted publishing

The `publish-npm` job authenticates to npm with **OIDC trusted publishing**. There is no `NPM_TOKEN` secret, and
there must never be one.

What makes it work:

- On npmjs.com, [`localidraw` → Settings](https://www.npmjs.com/package/localidraw/access) has a **trusted
  publisher**: GitHub Actions, repository `edspencer/localidraw`, workflow `release.yml`, no environment, with
  **npm publish** ticked under its **Allowed actions** (a new trusted publisher only allows staged publishes until
  it is). Renaming `release.yml`, or moving the publish to another workflow file, breaks publishing until this is
  updated.
- The job has `permissions: id-token: write`, and `actions/setup-node` with `registry-url:
  https://registry.npmjs.org` (without it npm never tries to authenticate).
- npm ≥ 11.5.1. Node 22 ships npm 10, so the job installs `npm@^11.5.1` before publishing.
- `publishConfig` in `package.json`: `access: public` and `provenance: true`. Trusted publishing would attest
  provenance on its own; asking explicitly makes a missing attestation an error. The job then checks that it landed
  (`npm view localidraw@<version> dist.attestations.provenance`) and fails the run if it didn't.

### Bootstrapping the package: the 0.0.1 placeholder (one-time, by hand)

A trusted publisher can only be attached to a package that already exists, and the first publish of a new package
can't be done over OIDC ([npm/cli#8544](https://github.com/npm/cli/issues/8544)). So before the first release, Ed
publishes a placeholder **`localidraw@0.0.1`** by hand, from a laptop:

1. In an empty folder, a `package.json` with only `name: "localidraw"`, `version: "0.0.1"`, a `description` saying
   it's a placeholder, `license: "MIT"` and `repository` pointing at this repo: no code, no `bin`, no
   dependencies. `npm publish --access public`, logged in as the maintainer.
2. On npmjs.com, add the trusted publisher described above, and tick **npm publish** under its allowed actions.
3. Under the package's publishing access, require 2FA and disallow tokens.

0.0.1 is the only version that will ever have been published from a laptop, and it's permanently unattested. That's
why it holds no code. Until the first real release, `npx localidraw` resolves to the placeholder and fails ("could
not determine executable to run").

The first real release is **0.2.0** (0.1.0 was the spike, never published; its `CHANGELOG.md` entry stays). Once
0.2.0 is out, deprecate the placeholder by hand (it needs a logged-in maintainer):
`npm deprecate localidraw@0.0.1 "placeholder, use the latest version"`.

## When something goes wrong

The pipeline is built so that re-running it finishes a half-done release. npm will never accept the same version
twice (and unpublishing is only possible for 72 hours, and frees nothing: the version number stays burned).

- **The version PR has wrong notes or the wrong bump.** Fix the changesets on `main` (edit or delete the
  `.changeset/*.md` files in a normal PR). The Release workflow rewrites the version PR on the next push. Don't hand
  edit the version PR.
- **`verify-ci` failed.** Nothing was published. Fix `main` (if it's a real failure, the fix's push gets a new run
  and the version PR comes back if there are changesets), or re-run CI and then re-run Release.
- **`publish-npm` failed before publishing** (auth, network, a build error in `prepack`). Nothing was published, and
  there's no tag. Fix the cause and re-run the workflow (Actions → Release → Run workflow, or re-run the failed jobs).
  An auth failure (`E404`/`ENEEDAUTH` on publish) almost always means the trusted publisher settings don't match the
  repo, the workflow file name or the job's `id-token` permission, or that the 0.0.1 placeholder was never published.
- **`E403 … OIDC permission denied for this action`** means npm accepted the OIDC token but the trusted publisher
  isn't allowed to do a direct publish: tick **npm publish** under its **Allowed actions** on npmjs.com, then re-run
  the failed jobs.
- This repo was created after 2026-07-15, so GitHub issues it OIDC tokens with *immutable* subject claims. If a
  publish fails at the token exchange with `package not found` (E404), check
  [npm/cli#9969](https://github.com/npm/cli/issues/9969) first.
- **Published, but a later step failed** (the provenance check timed out, or the GitHub Release step failed). The
  version is on npm and there's no `v<version>` tag, so re-running the workflow detects the release again, *skips*
  the publish ("already on npm") and finishes the provenance check, the tag and the Release.
- **A bad version is out.** Don't try to replace it: fix forward with a new changeset (a patch) and release it.
  `npm deprecate localidraw@<bad> "<why; use x.y.z>"` warns anyone who installs it.

**Never publish a release from a laptop to fix any of this.** A manual publish has no provenance. Everything after
0.0.1 goes through the workflow.

## Dry runs, locally

```sh
npx changeset status --verbose   # what the next version would be, and which changesets make it
npm publish --dry-run            # builds (prepack) and lists exactly what would go into the tarball
npm run smoke:pack               # packs, installs and runs the package as a user would (CI runs this too)
```

`npm publish --dry-run` warns that you aren't logged in; that's expected and harmless. To see what the version PR
would change, run `npm run changeset:version` in a scratch clone, not your working checkout (it rewrites
`package.json`, `CHANGELOG.md` and the lockfile, and deletes the changesets). Use npm 11 for it: npm 10 rewrites the
lockfile differently.
