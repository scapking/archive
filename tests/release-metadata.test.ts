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

test('release metadata pins the v0.5.0 native version contract', async () => {
    const expo = (await readJson(path.join(srcRoot, 'app.json'))) as {
        expo: ExpoConfig;
    };
    const packageJson = (await readJson(
        path.join(srcRoot, 'package.json'),
    )) as PackageJson;
    const config = expo.expo;

    assert.equal(config.version, '0.5.0');
    assert.equal(packageJson.version, '0.5.0');
    assert.equal(config.android.package, 'com.anonymous.archive');
    assert.equal(config.android.versionCode, 14);
    assert.equal(config.ios.bundleIdentifier, 'com.anonymous.archive');
    assert.equal(config.ios.buildNumber, '14');
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
    // v0.4.2：splash 底色与页面底色 token 三段同源（ink-base #FFFFFF /
    // inkd-base #080A0A）——splash → 过渡页零色差（用户反馈「两层 logo 叠显 +
    // 底色跳变」，boot-screen 头注）
    assert.equal(splash.backgroundColor, '#FFFFFF');
    assert.ok(splash.dark, 'splash plugin is missing the dark variant');
    assert.equal(splash.dark?.image, './assets/images/splash-icon-dark.png');
    assert.equal(splash.dark?.resizeMode, 'contain');
    assert.equal(splash.dark?.backgroundColor, '#080A0A');
});
