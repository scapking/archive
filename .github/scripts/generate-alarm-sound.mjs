#!/usr/bin/env node
/**
 * 闹钟提示音生成器（v0.4.7 用户令 #2：「声音文件注意别引入大二进制资产，
 * 可程序生成短 wav 入 assets」）。
 *
 * 产物：src/assets/sounds/alarm-chime.wav —— 22050Hz 16-bit 单声道 ~1.6s，
 * 「叮咚」双音 × 2 循环，包络首尾归零 → player.loop 无缝。约 70KB，
 * 远小于任何真实铃声资产；确定性合成（无随机源），重跑产物字节一致。
 *
 * 用法：node .github/scripts/generate-alarm-sound.mjs [--write]
 *   不带 --write 时只输出 sha256 + 字节数（--check 语义，供 CI 复核产物未漂移）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outPath = path.join(repoRoot, 'src', 'assets', 'sounds', 'alarm-chime.wav');

const SAMPLE_RATE = 22050;
const BITS = 16;
// 音符：A5(880Hz) / F#6(1479.98Hz) 经典「闹钟叮咚」；各 0.32s + 0.08s 间隙 × 2 组 = 1.6s
const NOTES = [
    { freq: 880.0, dur: 0.32 },
    { freq: 1479.98, dur: 0.32 },
    { freq: 880.0, dur: 0.32 },
    { freq: 1479.98, dur: 0.32 },
];
const GAP = 0.08;
const TOTAL = NOTES.reduce((sum, n) => sum + n.dur, 0) + GAP * NOTES.length;

/** 音符包络：短 attack + 指数衰减，收尾归零（无缝循环的关键）。 */
function envelope(t, dur) {
    const attack = 0.012;
    if (t < 0 || t >= dur) return 0;
    const rise = Math.min(1, t / attack);
    const decay = Math.exp(-6.5 * t / dur);
    // 末 20ms 淡出压实，保证 t=dur 处严格归零
    const release = Math.min(1, (dur - t) / 0.02);
    return rise * decay * release;
}

function synthesize() {
    const frames = Math.round(TOTAL * SAMPLE_RATE);
    const pcm = new Float64Array(frames);
    let cursor = 0;
    for (const note of NOTES) {
        const start = Math.round(cursor * SAMPLE_RATE);
        const len = Math.round(note.dur * SAMPLE_RATE);
        for (let i = 0; i < len && start + i < frames; i += 1) {
            const t = i / SAMPLE_RATE;
            // 主音 + 二次谐波轻点缀（纯音过薄，谐波让短促铃音有“金属感”）
            const wave = Math.sin(2 * Math.PI * note.freq * t)
                + 0.35 * Math.sin(2 * Math.PI * note.freq * 2 * t);
            pcm[start + i] += wave * envelope(t, note.dur) * 0.28;
        }
        cursor += note.dur + GAP;
    }
    return pcm;
}

function encodeWav(pcm) {
    const dataBytes = pcm.length * 2;
    const buffer = Buffer.alloc(44 + dataBytes);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataBytes, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // fmt chunk size
    buffer.writeUInt16LE(1, 20); // PCM
    buffer.writeUInt16LE(1, 22); // mono
    buffer.writeUInt32LE(SAMPLE_RATE, 24);
    buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
    buffer.writeUInt16LE(2, 32); // block align
    buffer.writeUInt16LE(BITS, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < pcm.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, pcm[i]));
        buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
    }
    return buffer;
}

const wav = encodeWav(synthesize());
const digest = createHash('sha256').update(wav).digest('hex');

if (process.argv.includes('--write')) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, wav);
    console.log(`written ${path.relative(repoRoot, outPath)} (${wav.length} bytes, sha256 ${digest.slice(0, 16)}…)`);
} else {
    let current = null;
    try {
        current = createHash('sha256').update(readFileSync(outPath)).digest('hex');
    } catch {
        /* 未生成 */
    }
    if (current === null) {
        console.error('missing src/assets/sounds/alarm-chime.wav — run with --write');
        process.exit(1);
    }
    if (current !== digest) {
        console.error(`drift: expected ${digest}, found ${current} — regenerate with --write`);
        process.exit(1);
    }
    console.log(`ok ${wav.length} bytes sha256 ${digest.slice(0, 16)}…`);
}
