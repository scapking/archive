import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

interface AdaptiveIcon {
    foregroundImage: string;
    backgroundImage: string;
    monochromeImage: string;
    backgroundColor: string;
}

interface SplashOptions {
    image?: string;
    resizeMode?: string;
    backgroundColor?: string;
    dark?: SplashOptions;
}

type PluginEntry = string | [string, Record<string, unknown>];

interface ExpoConfig {
    name: string;
    slug: string;
    scheme: string;
    version: string;
    icon: string;
    ios: {
        bundleIdentifier?: string;
        buildNumber?: string;
        icon?: string;
    };
    android: {
        package?: string;
        versionCode?: number;
        adaptiveIcon: AdaptiveIcon;
    };
    web: { favicon: string };
    plugins: PluginEntry[];
}

interface PackageJson {
    version: string;
}

const readJson = async (filePath: string): Promise<unknown> =>
    JSON.parse(await readFile(filePath, 'utf8'));

const pluginOptions = (config: ExpoConfig, name: string): Record<string, unknown> => {
    const entry = config.plugins.find((candidate) =>
        Array.isArray(candidate) && candidate[0] === name,
    );
    assert.ok(entry, `app.json is missing the ${name} plugin`);
    return entry[1] as Record<string, unknown>;
};

test('release metadata pins the v0.4.1 native version contract', async () => {
    const expo = (await readJson(path.join(srcRoot, 'app.json'))) as {
        expo: ExpoConfig;
    };
    const packageJson = (await readJson(
        path.join(srcRoot, 'package.json'),
    )) as PackageJson;
    const config = expo.expo;

    assert.equal(config.version, '0.4.1');
    assert.equal(packageJson.version, '0.4.1');
    assert.equal(config.android.package, 'com.anonymous.archive');
    assert.equal(config.android.versionCode, 5);
    assert.equal(config.ios.bundleIdentifier, 'com.anonymous.archive');
    assert.equal(config.ios.buildNumber, '5');
    assert.equal(config.ios.icon, './assets/images/icon.png');
});

test('release metadata keeps identity and asset wiring intact', async () => {
    const expo = (await readJson(path.join(srcRoot, 'app.json'))) as {
        expo: ExpoConfig;
    };
    const config = expo.expo;

    assert.equal(config.name, 'Archive');
    assert.equal(config.slug, 'archive');
    assert.equal(config.scheme, 'archive');

    assert.equal(config.icon, './assets/images/icon.png');
    assert.equal(config.web.favicon, './assets/images/favicon.png');

    assert.equal(
        config.android.adaptiveIcon.foregroundImage,
        './assets/images/android-icon-foreground.png',
    );
    assert.equal(
        config.android.adaptiveIcon.backgroundImage,
        './assets/images/android-icon-background.png',
    );
    assert.equal(
        config.android.adaptiveIcon.monochromeImage,
        './assets/images/android-icon-monochrome.png',
    );
    assert.equal(config.android.adaptiveIcon.backgroundColor, '#F7F2E8');

    const splash = pluginOptions(config, 'expo-splash-screen') as SplashOptions;
    assert.equal(splash.image, './assets/images/splash-icon.png');
    assert.equal(splash.resizeMode, 'contain');
    assert.equal(splash.backgroundColor, '#F7F2E8');
    assert.ok(splash.dark, 'splash plugin is missing the dark variant');
    assert.equal(splash.dark?.image, './assets/images/splash-icon-dark.png');
    assert.equal(splash.dark?.resizeMode, 'contain');
    assert.equal(splash.dark?.backgroundColor, '#171B18');
});
