import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(full)));
        else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(full);
    }
    return files;
}

test('the plan domain owns the routes and screen files', () => {
    for (const rel of [
        'app/plans.tsx',
        'app/plan/new.tsx',
        'app/plan/[id].tsx',
        'features/archive/plan-form-screen.tsx',
    ]) {
        assert.ok(existsSync(path.join(srcRoot, rel)), `missing ${rel}`);
    }
    assert.ok(!existsSync(path.join(srcRoot, 'app/notes.tsx')), 'legacy notes route still exists');
    assert.ok(!existsSync(path.join(srcRoot, 'app/note')), 'legacy note route dir still exists');
});

test('no user-facing note copy or createNote symbol survives outside comments', async () => {
    const offenders: string[] = [];
    for (const file of await walk(srcRoot)) {
        const lines = (await readFile(file, 'utf8')).split('\n');
        lines.forEach((line, index) => {
            const trimmed = line.trim();
            if (
                trimmed.startsWith('//') ||
                trimmed.startsWith('*') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('{/*') ||
                trimmed.startsWith('*/')
            ) {
                return;
            }
            if (trimmed.includes('笔记') || /\bcreateNote\b/.test(trimmed)) {
                offenders.push(`${path.relative(repoRoot, file)}:${index + 1}: ${trimmed}`);
            }
        });
    }
    assert.deepEqual(offenders, []);
});