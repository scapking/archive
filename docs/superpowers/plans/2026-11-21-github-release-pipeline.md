# GitHub Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing Archive application to the public GitHub repository `scapking/archive` and add tag-driven GitHub Actions workflows that compile Android and iOS artifacts and publish them in a GitHub Release.

**Architecture:** Keep the existing Expo managed project under `src/`; generate disposable `android/` and `ios/` projects in CI with `expo prebuild`. A normal CI workflow validates the application, while a `v*` tag workflow builds Android on Ubuntu and iOS on macOS, uploads both artifacts, and creates the Release with the workflow-scoped `GITHUB_TOKEN`.

**Tech Stack:** Expo SDK 58, React Native 0.88, pnpm 10, Expo Router, GitHub Actions, Gradle, Xcode, GitHub CLI.

**Spec:** `AGENTS.md`, `README.md`, `eas.json`, `src/app.json` (repository requirements plus the user's GitHub publication request)

## Global Constraints

- The remote repository is `https://github.com/scapking/archive` and must remain public.
- The user-provided GitHub PAT MUST NOT appear in a tracked file, commit, tag, Git remote URL, Git config, workflow, artifact, or Actions log.
- Authentication for the initial push uses a temporary process environment plus a generic `GIT_ASKPASS` helper outside the repository; the helper is deleted after the push.
- Workflow authentication uses only the ephemeral `${{ github.token }}` context, with `contents: read` by default and `contents: write` only on the Release job.
- The Expo project root is `src/`; native projects are generated only inside disposable CI workspaces and remain ignored by Git.
- The initial release tag is `v1.0.0` and must match `expo.version` in `src/app.json`.
- Android output is an installable internal-release APK because no production Android keystore was supplied.
- iOS output is an unsigned `.ipa` compilation artifact because no Apple signing identity or provisioning profile was supplied; it must not be represented as App Store/TestFlight-ready.
- Existing uncommitted application changes must be preserved and verified, not reset or overwritten.

## Review Focus

- A PAT-like value or authenticated remote URL accidentally enters the repository or Actions configuration.
- A release tag is created for a version that differs from `src/app.json`.
- Generated `android/`, `ios/`, signing material, or local environment files are committed.
- The iOS artifact lacks the `Payload/Archive.app` layout required by an IPA container.
- The Release job receives broader permissions than `contents: write` or runs before both platform builds succeed.

---

### Task 1: Add Pull Request and Branch CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `docs/standards/README.md` (register this plan document)

**Interfaces:**
- Consumes: `src/package.json`, `src/pnpm-lock.yaml`, `src/app.json`.
- Produces: workflow named `CI` that validates pushes to `main` and pull requests.

- [ ] **Step 1: Verify the missing-workflow contract fails**

Run:

```bash
test -f .github/workflows/ci.yml
```

Expected: FAIL with exit code 1 because the workflow does not exist yet.

- [ ] **Step 2: Create the minimal CI workflow**

Use pinned full commit SHAs for `actions/checkout`, `actions/setup-node`, and `pnpm/action-setup`. Set workflow permissions to `contents: read`, disable checkout credential persistence, install with `pnpm install --frozen-lockfile`, run `pnpm typecheck`, regenerate `public/nativewind.css` and require no diff, then run a production Web export as an additional bundle smoke test.

- [ ] **Step 3: Parse and verify the workflow**

Run a Python assertion that loads `.github/workflows/ci.yml` with PyYAML and asserts the `CI` workflow, `contents: read` permission, frozen lockfile install, `pnpm typecheck`, CSS diff check, and Expo export are present. Also assert no PAT-like value exists in the file.

Expected: PASS.

### Task 2: Add Tag-Driven Android and iOS Release Builds

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: tag pushes matching `v*`, `src/package.json`, `src/pnpm-lock.yaml`, `src/app.json`.
- Produces: workflow named `Release`; artifacts named `archive-android-<version>.apk` and `archive-ios-<version>-unsigned.ipa`; a published GitHub Release for the triggering tag.

- [ ] **Step 1: Verify the missing-release-workflow contract fails**

Run:

```bash
test -f .github/workflows/release.yml
```

Expected: FAIL with exit code 1 because the workflow does not exist yet.

- [ ] **Step 2: Create the release workflow**

Define separate `android`, `ios`, and `release` jobs. All jobs use `contents: read` except the Release job, which uses `contents: write`. Pin every action to a full SHA. The Android job runs `expo prebuild --platform android`, builds `assembleRelease` with Gradle, and uploads the APK. The iOS job runs `expo prebuild --platform ios`, installs pods, performs a Release `xcodebuild` with code signing disabled, packages `Payload/Archive.app` as an unsigned IPA, and uploads it. The Release job waits for both builds, validates the tag against `expo.version`, downloads both artifacts, and calls `gh release create` with `--verify-tag` and `--generate-notes` using `${{ github.token }}`.

- [ ] **Step 3: Parse and verify the release workflow**

Run Python assertions that assert the `v*` tag trigger, separate Android/iOS jobs, `xcodebuild`, Gradle `assembleRelease`, artifact upload/download, `contents: write` only on the Release job, `github.token` usage, tag/version validation, and absence of any PAT-like value.

Expected: PASS.

### Task 3: Verify and Commit the Publication Baseline

**Files:**
- Include: all existing tracked and untracked application changes already present in the worktree.
- Include: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `docs/superpowers/plans/2026-11-21-github-release-pipeline.md`, `docs/standards/README.md`.

**Interfaces:**
- Consumes: the verified worktree.
- Produces: one application commit and one CI/release commit on `main`.

- [ ] **Step 1: Run repository checks**

Run `git diff --check`, the standards self-check from `docs/standards/README.md`, `cd src && pnpm typecheck`, `cd src && pnpm web:css`, `git diff --exit-code -- src/public/nativewind.css`, and the workflow assertions from Tasks 1 and 2.

Expected: all checks PASS.

- [ ] **Step 2: Scan for credential leakage**

Search tracked and untracked non-ignored files for GitHub PAT, GitHub fine-grained PAT, AWS access key, and private-key patterns; inspect `.git/config` for credential-bearing URLs.

Expected: no matches and no credential-bearing remote URL.

- [ ] **Step 3: Commit the existing application work**

Stage the existing application changes without generated dependencies/build output and commit with a message describing the Archive M3 features and local-first capabilities.

- [ ] **Step 4: Commit CI and release configuration**

Stage only `.github/workflows/`, the plan document, and its standards registration; commit with `ci: add GitHub release pipeline`.

### Task 4: Push Safely and Publish `v1.0.0`

**Files:**
- No additional tracked files.

**Interfaces:**
- Consumes: local `main`, remote `scapking/archive`, the user PAT supplied for this operation.
- Produces: remote `main`, remote tag `v1.0.0`, successful CI, successful Android/iOS builds, and a GitHub Release.

- [ ] **Step 1: Add a token-free remote and push**

Run `git remote add origin https://github.com/scapking/archive.git`. Use a temporary generic askpass script under `/tmp/opencode`, pass the PAT only as a process environment variable, push `main`, and delete the helper immediately afterward.

Expected: push succeeds and `git remote -v` contains no token.

- [ ] **Step 2: Verify the public remote tree contains no PAT**

Query the public GitHub API for the pushed tree or clone the public repository into `/tmp/opencode` and run the credential-pattern scan there.

Expected: no PAT-like value is present.

- [ ] **Step 3: Create and push the version tag**

Confirm `src/app.json` reports `1.0.0`, create annotated tag `v1.0.0` at the CI commit, and push only that tag through the same temporary askpass mechanism.

Expected: the remote tag points exactly to the CI commit.

- [ ] **Step 4: Monitor the workflows and release**

Query GitHub Actions for the `CI` and `Release` runs. If either fails, inspect its job logs, identify the first root cause, fix it, re-run the exact verification, and push a corrective commit before retrying the workflow.

Expected: CI, Android, iOS, and Release jobs all conclude successfully.

- [ ] **Step 5: Verify published release assets**

Query the GitHub Releases API and confirm the `v1.0.0` release is public, is not a draft or prerelease, and contains one Android APK and one unsigned iOS IPA.

Expected: both assets are present with non-zero sizes.
