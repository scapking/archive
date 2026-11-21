"""Contract tests for .github/scripts/configure-android-release-signing.py.

The transformer must inject an env-only release signing config into the Expo
template `build.gradle` without ever copying secret values into the file.
"""

import importlib.util
import os
import unittest
import unittest.mock
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = (
    REPO_ROOT / ".github" / "scripts" / "configure-android-release-signing.py"
)

ENV_VARS = (
    "ANDROID_RELEASE_STORE_FILE",
    "ANDROID_RELEASE_STORE_PASSWORD",
    "ANDROID_RELEASE_KEY_ALIAS",
    "ANDROID_RELEASE_KEY_PASSWORD",
)

# Fixture secrets that must never leak into the transformed Gradle text.
FIXTURE_SECRETS = {
    "ANDROID_RELEASE_STORE_FILE": "/tmp/secret-material/release.keystore",
    "ANDROID_RELEASE_STORE_PASSWORD": "s3cr3t-store-password!",
    "ANDROID_RELEASE_KEY_ALIAS": "release-key-alias",
    "ANDROID_RELEASE_KEY_PASSWORD": "s3cr3t-key-password!",
}

TEMPLATE_GRADLE = """apply plugin: "com.android.application"

android {
    namespace "com.anonymous.archive"
    compileSdk rootProject.ext.compileSdkVersion

    defaultConfig {
        applicationId "com.anonymous.archive"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            shrinkResources true
            minifyEnabled true
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
        }
    }
}
"""

ENV_TEMPLATE = "signingConfigs.debug"
ENV_REFERENCE = 'System.getenv("{}")'


def load_transformer():
    spec = importlib.util.spec_from_file_location(
        "configure_android_release_signing", SCRIPT_PATH
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def extract_block(text: str, header: str, start: int = 0) -> str:
    """Return the `header { ... }` block including the header line."""
    start = text.index(header, start)
    open_brace = text.index("{", start)
    depth = 0
    for offset in range(open_brace, len(text)):
        char = text[offset]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : offset + 1]
    raise AssertionError(f"unbalanced braces after {header!r}")


class ConfigureAndroidReleaseSigningTest(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.build_gradle = Path(self.tmp.name) / "build.gradle"
        self.build_gradle.write_text(TEMPLATE_GRADLE, encoding="utf-8")
        self.addCleanup(self.tmp.cleanup)

    def transform(self) -> None:
        module = load_transformer()
        with unittest.mock.patch.dict(os.environ, FIXTURE_SECRETS):
            module.configure_android_release_signing(self.build_gradle)

    def test_debug_signing_config_is_byte_for_byte_unchanged(self) -> None:
        before = extract_block(TEMPLATE_GRADLE, "debug {")
        self.transform()
        after = extract_block(
            self.build_gradle.read_text(encoding="utf-8"), "debug {"
        )
        self.assertEqual(after, before)

    def test_release_signing_config_references_all_four_env_vars(self) -> None:
        self.transform()
        text = self.build_gradle.read_text(encoding="utf-8")
        release_config = extract_block(text, "release {")
        for name in ENV_VARS:
            self.assertIn(ENV_REFERENCE.format(name), release_config)
        self.assertEqual(release_config.count("System.getenv("), 4)

    def test_release_build_type_uses_the_release_signing_config(self) -> None:
        self.transform()
        text = self.build_gradle.read_text(encoding="utf-8")
        build_types = extract_block(text, "buildTypes {")
        release_build_type = extract_block(build_types, "release {")
        self.assertIn("signingConfig signingConfigs.release", release_build_type)
        self.assertNotIn(ENV_TEMPLATE, release_build_type)

    def test_missing_environment_variable_fails_before_writing(self) -> None:
        before = self.build_gradle.read_bytes()
        module = load_transformer()
        env = dict(FIXTURE_SECRETS)
        del env["ANDROID_RELEASE_KEY_PASSWORD"]
        with unittest.mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(ValueError):
                module.configure_android_release_signing(self.build_gradle)
        self.assertEqual(self.build_gradle.read_bytes(), before)

    def test_reruns_are_idempotent(self) -> None:
        self.transform()
        first = self.build_gradle.read_bytes()
        self.transform()
        second = self.build_gradle.read_bytes()
        self.assertEqual(second, first)
        text = second.decode("utf-8")
        self.assertEqual(text.count("signingConfigs {"), 1)
        self.assertEqual(text.count("storeFile file(System.getenv("), 1)

    def test_secret_values_never_appear_in_the_gradle_text(self) -> None:
        self.transform()
        text = self.build_gradle.read_text(encoding="utf-8")
        for value in FIXTURE_SECRETS.values():
            self.assertNotIn(value, text)

    def test_unexpected_gradle_shape_fails_without_writing(self) -> None:
        broken = Path(self.tmp.name) / "broken.gradle"
        broken.write_text(
            'apply plugin: "com.android.application"\n\nandroid {\n'
            '    namespace "com.anonymous.archive"\n}\n',
            encoding="utf-8",
        )
        before = broken.read_bytes()
        module = load_transformer()
        with unittest.mock.patch.dict(os.environ, FIXTURE_SECRETS):
            with self.assertRaises(ValueError):
                module.configure_android_release_signing(broken)
        self.assertEqual(broken.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
