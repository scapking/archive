import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');
const imagesRoot = path.join(srcRoot, 'assets', 'images');
const requireFromSrc = createRequire(path.join(srcRoot, 'package.json'));
const sharp = requireFromSrc('sharp') as typeof import('sharp');

const canvasSize = 1254;
const paper = [247, 242, 232] as const;
const ink = [32, 37, 34] as const;
const legacyWhaleSha256 =
    'db3ba8f0ce0f1b7dcadd1f4f332bcef53d5855ca945b63cabb106f9db0f9a027';

const assetNames = [
    'icon.png',
    'favicon.png',
    'splash-icon.png',
    'splash-icon-dark.png',
    'android-icon-foreground.png',
    'android-icon-background.png',
    'android-icon-monochrome.png',
] as const;

const assetPath = (name: (typeof assetNames)[number]) =>
    path.join(imagesRoot, name);

const sha256 = (contents: Uint8Array) =>
    createHash('sha256').update(contents).digest('hex');

const readRawPixels = async (filePath: string) => {
    const { data, info } = await sharp(filePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return { data, info };
};

const alphaBounds = (
    data: Buffer,
    width: number,
    height: number,
) => {
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    let visiblePixels = 0;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const alpha = data[(y * width + x) * 4 + 3];
            if (alpha === 0) {
                continue;
            }

            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
            visiblePixels += 1;
        }
    }

    return {
        left,
        top,
        right,
        bottom,
        width: right - left + 1,
        height: bottom - top + 1,
        visiblePixels,
    };
};

const assertRequiredFileExists = async (filePath: string) => {
    try {
        await stat(filePath);
    } catch (error) {
        assert.fail(
            `required brand asset is missing: ${path.relative(repoRoot, filePath)} (${String(error)})`,
        );
    }
};

test('asset check renders temporary output without rewriting tracked assets', async () => {
    const trackedAssets = new Map<string, { mtimeMs: number; sha256: string }>();

    for (const name of assetNames) {
        const filePath = assetPath(name);
        try {
            const fileStat = await stat(filePath);
            const contents = await readFile(filePath);
            trackedAssets.set(name, {
                mtimeMs: fileStat.mtimeMs,
                sha256: sha256(contents),
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }

    const check = spawnSync(
        process.execPath,
        ['../.github/scripts/generate-brand-assets.mjs', '--check'],
        {
            cwd: srcRoot,
            encoding: 'utf8',
        },
    );

    assert.equal(
        check.status,
        0,
        [
            `asset check exited with status ${String(check.status)}`,
            check.error ? `spawn error: ${check.error.message}` : '',
            check.stdout ? `stdout:\n${check.stdout}` : '',
            check.stderr ? `stderr:\n${check.stderr}` : '',
        ]
            .filter(Boolean)
            .join('\n'),
    );

    for (const [name, before] of trackedAssets) {
        const filePath = assetPath(name);
        const afterStat = await stat(filePath);
        const afterContents = await readFile(filePath);
        assert.equal(
            afterStat.mtimeMs,
            before.mtimeMs,
            `${name} was rewritten during --check`,
        );
        assert.equal(
            sha256(afterContents),
            before.sha256,
            `${name} changed during --check`,
        );
    }
});

test('canonical SVG is a flat three-path open book', async () => {
    const svgPath = path.join(imagesRoot, 'open-book-icon.svg');
    await assertRequiredFileExists(svgPath);
    const svg = await readFile(svgPath, 'utf8');

    assert.match(svg, /<svg\b[^>]*\bviewBox="0 0 1254 1254"/);
    assert.equal((svg.match(/<path\b/g) ?? []).length, 3);

    for (const forbiddenPattern of [
        /<text\b/i,
        /<image\b/i,
        /<linearGradient\b/i,
        /<radialGradient\b/i,
        /<filter\b/i,
        /<fe[A-Z]/i,
        /\bfilter\s*=/i,
        /\bshadow\b/i,
    ]) {
        assert.doesNotMatch(svg, forbiddenPattern);
    }
});

test('every generated PNG is 1254 by 1254 and replaces the whale', async () => {
    for (const name of assetNames) {
        const filePath = assetPath(name);
        await assertRequiredFileExists(filePath);

        const metadata = await sharp(filePath).metadata();
        assert.equal(metadata.width, canvasSize, `${name} has the wrong width`);
        assert.equal(metadata.height, canvasSize, `${name} has the wrong height`);

        const contents = await readFile(filePath);
        assert.notEqual(
            sha256(contents),
            legacyWhaleSha256,
            `${name} still contains the legacy whale asset`,
        );
    }
});

test('icon and favicon use the warm paper canvas and ink book', async () => {
    for (const name of ['icon.png', 'favicon.png'] as const) {
        const filePath = assetPath(name);
        await assertRequiredFileExists(filePath);

        const { data, info } = await sharp(filePath)
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const colors = new Set<string>();

        for (let offset = 0; offset < data.length; offset += info.channels) {
            colors.add(
                `${data[offset]},${data[offset + 1]},${data[offset + 2]}`,
            );
        }

        assert.ok(
            colors.has(paper.join(',')),
            `${name} does not contain the exact warm paper color`,
        );
        assert.ok(
            colors.has(ink.join(',')),
            `${name} does not contain the exact ink color`,
        );
    }
});

test('Android icon background is one solid warm paper canvas', async () => {
    const filePath = assetPath('android-icon-background.png');
    await assertRequiredFileExists(filePath);

    const { data, info } = await sharp(filePath)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    for (let offset = 0; offset < data.length; offset += info.channels) {
        assert.deepEqual(
            [data[offset], data[offset + 1], data[offset + 2]],
            [...paper],
            'Android icon background contains a non-paper pixel',
        );
    }
});

test('splash and adaptive foreground marks have meaningful transparent alpha bounds', async () => {
    for (const name of [
        'splash-icon.png',
        'splash-icon-dark.png',
        'android-icon-foreground.png',
    ] as const) {
        const filePath = assetPath(name);
        await assertRequiredFileExists(filePath);

        const { data, info } = await readRawPixels(filePath);
        const bounds = alphaBounds(data, info.width, info.height);

        assert.equal(data[3], 0, `${name} does not have a transparent corner`);
        assert.ok(
            bounds.width >= 100 && bounds.height >= 100,
            `${name} has an insignificant visible alpha bound`,
        );
        assert.ok(
            bounds.visiblePixels >= 10_000,
            `${name} does not contain a meaningful visible mark`,
        );
    }
});

test('Android monochrome asset is a non-empty alpha silhouette on transparency', async () => {
    const filePath = assetPath('android-icon-monochrome.png');
    await assertRequiredFileExists(filePath);

    const { data, info } = await readRawPixels(filePath);
    const bounds = alphaBounds(data, info.width, info.height);

    assert.equal(data[3], 0, 'monochrome asset does not have a transparent corner');
    assert.ok(bounds.width > 0 && bounds.height > 0);
    assert.ok(bounds.visiblePixels >= 10_000);

    for (let offset = 0; offset < data.length; offset += 4) {
        if (data[offset + 3] === 0) {
            continue;
        }
        assert.deepEqual(
            [data[offset], data[offset + 1], data[offset + 2]],
            [...ink],
            'monochrome asset contains visible decorative color',
        );
    }
});

test('Android adaptive foreground stays inside the central 66 percent safe region', async () => {
    const filePath = assetPath('android-icon-foreground.png');
    await assertRequiredFileExists(filePath);

    const { data, info } = await readRawPixels(filePath);
    const bounds = alphaBounds(data, info.width, info.height);
    const safeInset = Math.ceil((canvasSize * (1 - 0.66)) / 2);

    assert.ok(
        bounds.left >= safeInset && bounds.top >= safeInset,
        'adaptive foreground extends above or left of the safe region',
    );
    assert.ok(
        bounds.right <= canvasSize - safeInset - 1 &&
            bounds.bottom <= canvasSize - safeInset - 1,
        'adaptive foreground extends below or right of the safe region',
    );
});
