#!/usr/bin/env python3
"""Configure env-only release signing in the Expo Android build.gradle.

Reads the four ``ANDROID_RELEASE_*`` variables from the environment, validates
that they are all present, then rewrites ``android/app/build.gradle`` so that
a ``signingConfigs.release`` block exists and ``buildTypes.release`` uses it.
The Gradle file only ever contains ``System.getenv(...)`` references — the
secret values themselves are never written to disk.

The transformation is structural: blocks are located by brace matching (quote-
and comment-aware), never by unanchored global replacement, and any deviation
from the expected Expo template shape fails with ``ValueError`` before the
file is written. Writes are atomic (temp file in the same directory +
``os.replace``) and re-running the script is a no-op.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path

ENV_STORE_FILE = "ANDROID_RELEASE_STORE_FILE"
ENV_STORE_PASSWORD = "ANDROID_RELEASE_STORE_PASSWORD"
ENV_KEY_ALIAS = "ANDROID_RELEASE_KEY_ALIAS"
ENV_KEY_PASSWORD = "ANDROID_RELEASE_KEY_PASSWORD"

REQUIRED_ENV_VARS = (
    ENV_STORE_FILE,
    ENV_STORE_PASSWORD,
    ENV_KEY_ALIAS,
    ENV_KEY_PASSWORD,
)

DEBUG_SIGNING_REFERENCE = "signingConfig signingConfigs.debug"
RELEASE_SIGNING_REFERENCE = "signingConfig signingConfigs.release"


def _validate_environment(environ: dict[str, str] | None = None) -> None:
    """Fail before touching any file if a required variable is missing/empty."""
    env = os.environ if environ is None else environ
    missing = [name for name in REQUIRED_ENV_VARS if not env.get(name)]
    if missing:
        raise ValueError(
            "missing required environment variables: " + ", ".join(missing)
        )


def _find_matching_brace(text: str, open_index: int) -> int:
    """Return the index of the ``}`` matching the ``{`` at *open_index*.

    Skips over double/single-quoted strings and comments so braces inside
    literals (e.g. ``"proguard-android.txt"``) never desynchronize the depth.
    """
    depth = 0
    index = open_index
    length = len(text)
    in_string = False
    quote = ""
    in_line_comment = False
    in_block_comment = False
    while index < length:
        char = text[index]
        following = text[index + 1] if index + 1 < length else ""
        if in_line_comment:
            if char == "\n":
                in_line_comment = False
        elif in_block_comment:
            if char == "*" and following == "/":
                in_block_comment = False
                index += 1
        elif in_string:
            if char == "\\":
                index += 1
            elif char == quote:
                in_string = False
        elif char == "/" and following == "/":
            in_line_comment = True
            index += 1
        elif char == "/" and following == "*":
            in_block_comment = True
            index += 1
        elif char in "\"'":
            in_string = True
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError("unbalanced braces in build.gradle")


def _locate_block(text: str, header: str, description: str) -> tuple[int, int, int]:
    """Locate ``header { ... }`` and return (header start, open, close)."""
    header_start = text.find(header)
    if header_start == -1:
        raise ValueError(f"build.gradle does not contain {description}")
    open_index = text.find("{", header_start)
    if open_index == -1:
        raise ValueError(f"build.gradle has {description} without a brace")
    close_index = _find_matching_brace(text, open_index)
    return header_start, open_index, close_index


def _line_indent(text: str, header_start: int) -> str:
    line_start = text.rfind("\n", 0, header_start) + 1
    prefix = text[line_start:header_start]
    return prefix if prefix.strip() == "" else ""


def _release_config_block(indent: str) -> str:
    inner = indent + "    "
    lines = [
        f"{indent}release {{",
        f'{inner}storeFile file(System.getenv("{ENV_STORE_FILE}"))',
        f'{inner}storePassword System.getenv("{ENV_STORE_PASSWORD}")',
        f'{inner}keyAlias System.getenv("{ENV_KEY_ALIAS}")',
        f'{inner}keyPassword System.getenv("{ENV_KEY_PASSWORD}")',
        f"{indent}}}",
    ]
    return "\n".join(lines)


def _ensure_release_signing_config(text: str) -> str:
    """Insert ``signingConfigs.release`` after ``signingConfigs.debug``."""
    _, configs_open, configs_close = _locate_block(
        text, "signingConfigs {", "a signingConfigs block"
    )
    configs_body = text[configs_open:configs_close]
    if configs_body.find("release {") != -1:
        return text
    _, debug_open, debug_close = _locate_block(
        text, "debug {", "a signingConfigs.debug block"
    )
    if debug_open < configs_open or debug_close > configs_close:
        raise ValueError(
            "the expected Expo template shape is absent: "
            "signingConfigs.debug must live inside signingConfigs"
        )
    indent = _line_indent(text, debug_open + 1)
    insertion = "\n\n" + _release_config_block(indent)
    return text[: debug_close + 1] + insertion + text[debug_close + 1 :]


def _point_release_build_type_at_release_config(text: str) -> str:
    """Rewrite ``buildTypes.release`` to use ``signingConfigs.release``."""
    _, types_open, types_close = _locate_block(
        text, "buildTypes {", "a buildTypes block"
    )
    _, release_open, release_close = _locate_block(
        text[types_open:types_close], "release {", "a buildTypes.release block"
    )
    release_open += types_open
    release_close += types_open
    block = text[release_open:release_close]
    if RELEASE_SIGNING_REFERENCE in block:
        return text
    if DEBUG_SIGNING_REFERENCE not in block:
        raise ValueError(
            "the expected Expo template shape is absent: "
            "buildTypes.release has no signingConfig line"
        )
    rewritten = block.replace(DEBUG_SIGNING_REFERENCE, RELEASE_SIGNING_REFERENCE, 1)
    return text[:release_open] + rewritten + text[release_close:]


def configure_android_release_signing(build_gradle_path: Path) -> None:
    """Rewrite *build_gradle_path* with the env-only release signing config."""
    build_gradle_path = Path(build_gradle_path)
    _validate_environment()
    text = build_gradle_path.read_text(encoding="utf-8")
    updated = _ensure_release_signing_config(text)
    updated = _point_release_build_type_at_release_config(updated)
    if updated == text:
        return
    directory = build_gradle_path.parent
    handle = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=directory, delete=False
    )
    try:
        with handle:
            handle.write(updated)
        os.replace(handle.name, build_gradle_path)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Configure the Android release signing config from "
            f"{', '.join(REQUIRED_ENV_VARS)} environment variables."
        )
    )
    parser.add_argument(
        "build_gradle",
        type=Path,
        help="path to the generated android/app/build.gradle",
    )
    arguments = parser.parse_args(argv)
    try:
        configure_android_release_signing(arguments.build_gradle)
    except (ValueError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
