import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..', '..');
const sourceRoot = path.join(repositoryRoot, 'src');
const imagesRoot = path.join(sourceRoot, 'assets', 'images');
const canonicalSvgPath = path.join(imagesRoot, 'open-book-icon.svg');

const requireFromSource = createRequire(path.join(sourceRoot, 'package.json'));
const sharp = requireFromSource('sharp');

const canvasSize = 1254;
const paper = '#F7F2E8';
const ink = '#202522';
const inkRgb = [32, 37, 34];
const spine = '#171B18';
const adaptiveMarkSize = 1150;

const assetNames = [
    'icon.png',
    'favicon.png',
    'splash-icon.png',
    'splash-icon-dark.png',
    'android-icon-foreground.png',
    'android-icon-background.png',
    'android-icon-monochrome.png',
];

const pngOptions = {
    compressionLevel: 9,
    adaptiveFiltering: false,
    palette: false,
};

const recolorSvg = (svg, pageColor, spineColor) =>
    svg
        .replaceAll(`fill="${ink}"`, `fill="${pageColor}"`)
        .replaceAll(`fill="${spine}"`, `fill="${spineColor}"`);

const renderMark = async (svg, size = canvasSize) =>
    sharp(Buffer.from(svg))
        .resize(size, size, { fit: 'fill' })
        .png(pngOptions)
        .toBuffer();

const normalizeMonochromeColor = async (mark) => {
    const { data, info } = await sharp(mark)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    for (let offset = 0; offset < data.length; offset += 4) {
        if (data[offset + 3] === 0) {
            continue;
        }
        data[offset] = inkRgb[0];
        data[offset + 1] = inkRgb[1];
        data[offset + 2] = inkRgb[2];
    }

    return sharp(data, {
        raw: {
            width: info.width,
            height: info.height,
            channels: 4,
        },
    })
        .png(pngOptions)
        .toBuffer();
};

const renderMarkOnCanvas = async (mark, background) => {
    const canvas = sharp({
        create: {
            width: canvasSize,
            height: canvasSize,
            channels: 4,
            background,
        },
    });

    return canvas
        .composite([{ input: mark, left: 0, top: 0 }])
        .png(pngOptions)
        .toBuffer();
};

const renderCenteredMark = async (mark) => {
    const offset = Math.floor((canvasSize - adaptiveMarkSize) / 2);
    const canvas = sharp({
        create: {
            width: canvasSize,
            height: canvasSize,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    });

    return canvas
        .composite([{ input: mark, left: offset, top: offset }])
        .png(pngOptions)
        .toBuffer();
};

const renderAssets = async (canonicalSvg) => {
    const inkMark = await renderMark(canonicalSvg);
    const paperMark = await renderMark(
        recolorSvg(canonicalSvg, paper, paper),
    );
    const monochromeMark = await normalizeMonochromeColor(
        await renderMark(recolorSvg(canonicalSvg, ink, ink)),
    );
    const adaptiveMark = await renderMark(canonicalSvg, adaptiveMarkSize);
    const paperBackground = await sharp({
        create: {
            width: canvasSize,
            height: canvasSize,
            channels: 3,
            background: paper,
        },
    })
        .png(pngOptions)
        .toBuffer();

    return new Map([
        ['icon.png', await renderMarkOnCanvas(inkMark, paper)],
        ['favicon.png', await renderMarkOnCanvas(inkMark, paper)],
        ['splash-icon.png', inkMark],
        ['splash-icon-dark.png', paperMark],
        ['android-icon-foreground.png', await renderCenteredMark(adaptiveMark)],
        ['android-icon-background.png', paperBackground],
        ['android-icon-monochrome.png', monochromeMark],
    ]);
};

const writeAssets = async (outputDirectory, assets) => {
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all(
        [...assets].map(([name, contents]) =>
            writeFile(path.join(outputDirectory, name), contents),
        ),
    );
};

const checkAssets = async (assets) => {
    const temporaryDirectory = await mkdtemp(
        path.join(tmpdir(), 'archive-brand-assets-'),
    );

    try {
        await writeAssets(temporaryDirectory, assets);
        const mismatches = [];

        for (const name of assetNames) {
            const trackedPath = path.join(imagesRoot, name);
            let trackedContents;

            try {
                trackedContents = await readFile(trackedPath);
            } catch (error) {
                if (error?.code !== 'ENOENT') {
                    throw error;
                }
                mismatches.push(`${name}: tracked file is missing`);
                continue;
            }

            const renderedContents = await readFile(
                path.join(temporaryDirectory, name),
            );
            if (!trackedContents.equals(renderedContents)) {
                mismatches.push(`${name}: tracked bytes differ from rendered output`);
                continue;
            }

            console.log(`${name}: current`);
        }

        if (mismatches.length > 0) {
            throw new Error(
                `Brand asset check failed:\n${mismatches.map((line) => `- ${line}`).join('\n')}`,
            );
        }
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
};

const main = async () => {
    const checkMode = process.argv.includes('--check');
    const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--check');
    if (unknownArguments.length > 0) {
        throw new Error(`Unknown argument: ${unknownArguments.join(', ')}`);
    }

    const canonicalSvg = await readFile(canonicalSvgPath, 'utf8');
    const assets = await renderAssets(canonicalSvg);

    if (checkMode) {
        await checkAssets(assets);
        console.log('All brand assets are current.');
        return;
    }

    await writeAssets(imagesRoot, assets);
    console.log(`Generated ${assets.size} brand assets in ${imagesRoot}.`);
};

await main();
