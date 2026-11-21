"""Contract tests for the GitHub Actions release and CI workflows.

The tests read the workflow YAML as text (no third-party YAML dependency) and
pin the security-relevant shape: SHA-pinned actions, env-only signing, an
arm64-only verified APK, a sole-writer Release job, and a manual dispatch that
can build a candidate without publishing.
"""

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

RELEASE_SECRETS = (
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
)

GRADLE_ENV_VARS = (
    "ANDROID_RELEASE_STORE_FILE",
    "ANDROID_RELEASE_STORE_PASSWORD",
    "ANDROID_RELEASE_KEY_ALIAS",
    "ANDROID_RELEASE_KEY_PASSWORD",
)

RELEASE_NOTES = (
    "Android APK: Release build, arm64-v8a only, signed with the configured "
    "Archive release key. iOS IPA: unsigned compile artifact; sign it with an "
    "Apple Distribution Certificate and provisioning profile before device "
    "installation or App Store distribution."
)


def load_workflow(name: str) -> str:
    path = REPO_ROOT / ".github" / "workflows" / name
    assert path.is_file(), f"missing workflow file: {path}"
    return path.read_text(encoding="utf-8")


def job_sections(text: str) -> dict[str, str]:
    """Split the `jobs:` block into `job name -> section text` mapping."""
    jobs_index = re.search(r"^jobs:\s*$", text, re.M)
    if jobs_index is None:
        raise AssertionError("workflow has no jobs: block")
    lines = text[jobs_index.end() :].splitlines()
    sections: dict[str, str] = {}
    current: str | None = None
    body: list[str] = []
    for line in lines:
        job_key = re.match(r"^  ([A-Za-z][\w-]*):\s*(?:#.*)?$", line)
        if job_key:
            if current is not None:
                sections[current] = "\n".join(body)
            current = job_key.group(1)
            body = [line]
        elif current is not None:
            body.append(line)
    if current is not None:
        sections[current] = "\n".join(body)
    return sections


def on_section(text: str) -> str:
    match = re.search(r"^on:\s*$(.*?)^permissions:\s*$", text, re.M | re.S)
    if match is None:
        raise AssertionError("workflow has no on: block")
    return match.group(1)


class ReleaseWorkflowContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.release = load_workflow("release.yml")
        self.android = job_sections(self.release)["android"]

    def test_every_action_reference_is_pinned_to_a_full_sha(self) -> None:
        for name in ("release.yml", "ci.yml"):
            text = load_workflow(name)
            refs = re.findall(r"^\s*(?:- )?uses:\s*(\S+)", text, re.M)
            self.assertTrue(refs, f"{name} pins no actions")
            for reference in refs:
                self.assertRegex(
                    reference,
                    r"^[\w./-]+@[0-9a-f]{40}$",
                    f"{name}: action not SHA-pinned: {reference}",
                )

    def test_android_job_signs_and_builds_an_arm64_release_apk(self) -> None:
        self.assertIn(
            ".github/scripts/configure-android-release-signing.py", self.android
        )
        assemble_lines = [
            line
            for line in self.android.splitlines()
            if ":app:assembleRelease" in line
        ]
        self.assertEqual(len(assemble_lines), 1, "expected one assembleRelease call")
        self.assertIn(
            "-PreactNativeArchitectures=arm64-v8a", assemble_lines[0]
        )
        for name in GRADLE_ENV_VARS:
            self.assertIn(name, self.android)
        self.assertIn("$RUNNER_TEMP/archive-release.keystore", self.android)
        self.assertIn("base64 --decode", self.android)
        self.assertIn("chmod 0600", self.android)
        self.assertIn("trap", self.android)
        self.assertIn("EXIT", self.android)
        self.assertIn(': "${ANDROID_KEYSTORE_BASE64:?', self.android)

    def test_secret_names_appear_only_as_secrets_references(self) -> None:
        for name in RELEASE_SECRETS:
            occurrences = [
                match.start() for match in re.finditer(re.escape(name), self.release)
            ]
            self.assertTrue(
                occurrences, f"{name} is never wired into the workflow"
            )
            for position in occurrences:
                preceded_by_secrets = (
                    self.release[position - 8 : position] == "secrets."
                )
                # Shell expansion of the step-scoped env variable: "$NAME" or
                # "${NAME:?...}" — never a literal value on the command line.
                preceded_by_expansion = self.release[position - 1] in ("$", "{")
                line_start = self.release.rfind("\n", 0, position) + 1
                is_env_key = (
                    re.match(
                        rf"^\s*{re.escape(name)}:\s",
                        self.release[line_start : position + len(name) + 2],
                    )
                    is not None
                )
                self.assertTrue(
                    preceded_by_secrets or preceded_by_expansion or is_env_key,
                    f"{name} appears outside a secrets reference or "
                    f"env expansion: {self.release[line_start:position + len(name) + 2]!r}",
                )

    def test_apk_is_verified_before_upload(self) -> None:
        self.assertIn('apksigner" verify --verbose --print-certs', self.android)
        self.assertIn("Verified using v2 scheme: true", self.android)
        self.assertIn("Signer #1 certificate SHA-256 digest", self.android)
        self.assertIn("release-cert-sha256.txt", self.android)
        self.assertIn("debug.keystore", self.android)
        self.assertIn("androiddebugkey", self.android)
        self.assertIn('abis="$(unzip', self.android)
        self.assertIn('test "$abis" = "arm64-v8a"', self.android)
        self.assertIn('aapt2" dump badging', self.android)
        self.assertIn("package: name='com.anonymous.archive'", self.android)
        self.assertIn("versionName=", self.android)
        self.assertIn("versionCode=", self.android)
        self.assertIn('["expo"]["version"]', self.android)
        self.assertIn('["android"]["versionCode"]', self.android)
        self.assertIn('test "$size" -gt 0', self.android)
        self.assertIn("125829120", self.android)
        self.assertIn('test "$size" -le 125829120', self.android)

    def test_release_job_is_the_sole_writer_using_github_token(self) -> None:
        sections = job_sections(self.release)
        self.assertEqual(
            set(sections), {"android", "ios", "release"}, f"jobs: {set(sections)}"
        )
        self.assertIn("contents: write", sections["release"])
        for job in ("android", "ios"):
            self.assertIn("contents: read", sections[job])
            self.assertNotIn("contents: write", sections[job])
            self.assertNotIn("github.token", sections[job])
        self.assertIn("GH_TOKEN: ${{ github.token }}", sections["release"])

    def test_manual_dispatch_can_build_a_ref_without_publishing(self) -> None:
        trigger = on_section(self.release)
        self.assertIn("workflow_dispatch:", trigger)
        self.assertIn("default: main", trigger)
        self.assertIn("type: boolean", trigger)
        self.assertIn("default: false", trigger)
        self.assertIn("required: false", trigger)
        self.assertIn(
            "${{ github.event_name == 'push' && github.ref || inputs.ref }}",
            self.release,
        )
        self.assertIn(
            "${{ github.event_name == 'push' && github.ref_name || inputs.tag }}",
            self.release,
        )
        release_job = job_sections(self.release)["release"]
        self.assertIn(
            "if: github.event_name == 'push' || inputs.publish == true",
            release_job,
        )
        tag_validations = self.release.count("Validate release tag")
        self.assertGreaterEqual(tag_validations, 2)
        self.assertIn(
            "if: github.event_name == 'push' || inputs.publish == true",
            self.android,
        )

    def test_release_notes_state_the_signing_contract(self) -> None:
        self.assertIn(RELEASE_NOTES, self.release)

    def test_release_job_validates_assets_before_publishing(self) -> None:
        release_job = job_sections(self.release)["release"]
        self.assertIn("testzip", release_job)
        self.assertIn("AndroidManifest.xml", release_job)
        self.assertIn("classes.dex", release_job)
        self.assertIn("Payload/Archive.app/Info.plist", release_job)
        self.assertIn("Payload/Archive.app/main.jsbundle", release_job)
        self.assertIn('tag != f"v{app_version}"', release_job)
        self.assertIn("lib/", release_job)
        self.assertIn("arm64-v8a", release_job)

    def test_ci_covers_the_new_contracts(self) -> None:
        ci = load_workflow("ci.yml")
        for needle in (
            "pnpm test",
            "pnpm assets:check",
            "test_configure_android_release_signing.py",
            "test_release_workflow.py",
            "release-metadata.test.ts",
            "pnpm typecheck",
            "nativewind.css",
            "expo export --platform web",
            '"git", "ls-files"',
            "PRIVATE KEY",
        ):
            self.assertIn(needle, ci, f"ci.yml is missing contract: {needle}")


if __name__ == "__main__":
    unittest.main()
