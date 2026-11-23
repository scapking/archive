import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const themeSource = await readFile(path.join(repoRoot, 'src/features/archive/ui/theme.ts'), 'utf8');
const deckSource = await readFile(path.join(repoRoot, 'src/features/archive/ui/deck.tsx'), 'utf8');

function token(name: string, theme: 'LIGHT' | 'DARK'): string {
    const block = themeSource.split(`const ${theme}: Palette = {`)[1] ?? '';
    const match = block.match(new RegExp(`${name}: '#([0-9A-Fa-f]{6})'`));
    assert.ok(match, `token ${name} missing in ${theme}`);
    return match[1];
}

function luminance(hex: string): number {
    const channels = [0, 2, 4].map((offset) => {
        const raw = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
}

test('deck edge tokens clear the legibility floor against the page in both themes', () => {
    for (const theme of ['LIGHT', 'DARK'] as const) {
        const base = token('sceneBg', theme);
        const border = token('border', theme);
        const ratio = contrast(border, base);
        assert.ok(
            ratio >= 1.2,
            `${theme} border vs page contrast ${ratio.toFixed(3)} < 1.2 — stacked card edges are invisible`,
        );
    }
});

test('deck shells give stacked cards a distinct tone and a hairline ring', () => {
    // 背卡（depth>0）壳面用 raised 一档（与页面/前卡的 surface 拉开），且每张
    // 卡都有一圈 ink-border hairline 描边——近色卡叠放时的恒定轮廓线
    assert.match(deckSource, /bg-ink-raised dark:bg-inkd-raised/);
    assert.match(deckSource, /border-ink-border dark:border-inkd-border/);
});