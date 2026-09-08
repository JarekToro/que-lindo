# Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please)
and built by [tauri-action](https://github.com/tauri-apps/tauri-action); see
`.github/workflows/release.yml`. Nothing is versioned by hand.

## Day to day

Write commits on `main` as [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: let a moment be pinned to a beat
fix: keep the shelf scrolled when a photo is removed
feat!: drop the v1 project file format
```

`feat` bumps the minor version, `fix` and `perf` the patch, and a `!` (or a
`BREAKING CHANGE:` footer) bumps the minor while we are below 1.0. `docs`,
`chore`, `refactor`, `test`, `build` and `ci` never release on their own and
stay out of the changelog. The subject line is the changelog entry, so write
it for the person reading the release notes.

release-please keeps one pull request open, "chore(main): release X.Y.Z",
updating `CHANGELOG.md`, `Cargo.toml`, `app/package.json`, `app/package-lock.json`
and `app/src-tauri/tauri.conf.json`. Edit the PR body if a changelog line needs
rewording; release-please copies it back.

`Cargo.lock` is the one file it cannot reach (the workspace crates are list
entries, which its TOML updater cannot address). The next `cargo build`
rewrites those three lines; commit them with whatever comes next. Nothing
builds with `--locked`.

## Cutting a release

Merge the release PR. That commit is tagged `vX.Y.Z`, the GitHub Release is
created with the changelog section as its notes, the macOS Apple Silicon
`.dmg` is built and attached as `que-lindo_X.Y.Z_aarch64.dmg`, and
`JarekToro/homebrew-apps` is asked to run its `bump.yml`, which livechecks the
release, rewrites the cask's version and sha256, audits it and pushes.

To force a version, add a `Release-As: X.Y.Z` footer to any commit.

The first release was 1.0.0 rather than 0.1.0: with no tag matching the
manifest, release-please falls back to its built-in first version, 1.0.0,
unless `initial-version` is set in `release-please-config.json`.

## Secrets

All optional. The workflow degrades without them.

| Secret | Effect |
|---|---|
| `HOMEBREW_TAP_TOKEN` | Fine-grained PAT (`JarekToro/homebrew-apps`: Actions, read and write). Dispatches the tap's `bump.yml` right after the release. Without it the tap still catches up on its daily schedule. |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Developer ID Application certificate as base64 `.p12`, its password, and the identity name. Signs the app. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple ID, an app-specific password, and the team ID. Notarizes the signed app. |

Until the Apple secrets exist the `.dmg` is unsigned. Gatekeeper reports it as
damaged on Apple Silicon; clear the quarantine flag once:

```sh
xattr -d com.apple.quarantine "/Applications/Qué lindo.app"
```

or install with `brew install --no-quarantine JarekToro/apps/que-lindo`.
