/**
 * GIF89a 编码器（纯 JS，零依赖，glossary §3 已登记）：帧序列（RGBA 像素）
 * → 动图 GIF 字节。三端同实现（无 expo/native 依赖，可独立单测）。
 *
 * 组成：
 * - **量化**：中位切分（median cut）全局调色板 ≤256 色——对全部帧抽样建
 *   直方图，按色域最宽通道递归二分至 256 盒，盒均值即调色板项；像素归色走
 *   5-bit 桶缓存（32³ 桶上限，桶内对 256 项线性最近邻，惰性计算一次）；
 * - **压缩**：GIF LZW 变长码（min code size 8，clear/EOD 哨兵，4096 词典上限
 *   自动 clear，码长 9→12 位），输出按 255 字节子块打包；
 * - **装配**：GIF89a 头 + 全局色表（256 项补齐）+ NETSCAPE2.0 无限循环扩展 +
 *   逐帧图像描述符（全尺寸不透明帧，disposal = 1）+ trailer。
 *
 * 已知边界（调用方契约）：全帧尺寸必须一致（混尺寸抛 RangeError，R5 参数
 * 校验）；透明像素不做 alpha 混合（RGBA alpha < 255 视为不透明直用 RGB——
 * 本域帧源是视频抽帧，天然全不透明）。
 */

/** 输入帧：RGBA 像素（4 字节/像素）+ 尺寸 + 停留时长。 */
export interface GifFrame {
    rgba: Uint8Array;
    width: number;
    height: number;
    /** 本帧停留时长（毫秒）；GIF 延迟单位为 1/100 秒，<20ms 收敛到 20ms（浏览器对 <2 的延迟按 100ms 处理，反而更慢）。 */
    delayMs: number;
}

/** 量化抽样预算：每帧采样的像素上限（直方图输入；量级足够代表全帧分布）。 */
const SAMPLE_BUDGET_PER_FRAME = 16384;
/** 调色板上限（GIF 全局色表最大 256 项）。 */
const PALETTE_SIZE = 256;

/**
 * 编码动图 GIF。至少一帧；所有帧必须同尺寸。
 * 返回 GIF89a 字节（调用方落盘 / 分享）。
 */
export function encodeGif(frames: GifFrame[]): Uint8Array {
    if (frames.length === 0) {
        throw new RangeError('gif-encoding.encodeGif: 至少需要一帧');
    }
    const { width, height } = frames[0];
    for (const frame of frames) {
        if (frame.width !== width || frame.height !== height) {
            throw new RangeError(
                `gif-encoding.encodeGif: 帧尺寸不一致（${width}x${height} vs ${frame.width}x${frame.height}）`,
            );
        }
        if (frame.rgba.length !== width * height * 4) {
            throw new RangeError(
                `gif-encoding.encodeGif: 帧像素数不匹配（期望 ${width * height * 4}，实际 ${frame.rgba.length}）`,
            );
        }
    }
    const palette = buildPalette(frames);
    const out: number[] = [];
    // ── 头 + 逻辑屏幕描述符 + 全局色表 ──
    pushAscii(out, 'GIF89a');
    pushLe16(out, width);
    pushLe16(out, height);
    // packed：GCT flag(1) | color resolution(3) | sort(1) | GCT size(3)——256 项 = 8 位 = 7
    out.push(0x80 | 0x00 | 0x00 | 0x07);
    out.push(0); // 背景色索引
    out.push(0); // 像素宽高比（不指定）
    for (let i = 0; i < PALETTE_SIZE; i++) {
        const r = palette[i * 3] ?? 0;
        const g = palette[i * 3 + 1] ?? 0;
        const b = palette[i * 3 + 2] ?? 0;
        out.push(r, g, b);
    }
    // ── NETSCAPE2.0 循环扩展（无限循环）──
    out.push(0x21, 0xff, 0x0b);
    pushAscii(out, 'NETSCAPE2.0');
    out.push(0x03, 0x01, 0x00, 0x00, 0x00);
    // ── 逐帧：图像控制扩展 + 图像描述符 + LZW 数据 ──
    for (const frame of frames) {
        const indices = quantizeFrame(frame, palette);
        const delayCentis = Math.max(2, Math.round(frame.delayMs / 10));
        // GCE：disposal = 1（不处置；全尺寸不透明帧直接覆盖）
        out.push(0x21, 0xf9, 0x04, 0x04);
        pushLe16(out, delayCentis);
        out.push(0x00, 0x00); // 透明索引 0（未使用）+ 块终止
        // 图像描述符：全画布、无局部色表、不交织
        out.push(0x2c);
        pushLe16(out, 0);
        pushLe16(out, 0);
        pushLe16(out, width);
        pushLe16(out, height);
        out.push(0x00);
        // LZW 最小码长 8 + 压缩数据 + 块终止
        out.push(0x08);
        const lzwBytes = lzwEncode(8, indices);
        for (let i = 0; i < lzwBytes.length; i++) out.push(lzwBytes[i]);
        out.push(0x00);
    }
    out.push(0x3b); // trailer
    return new Uint8Array(out);
}

// ─── 调色板（中位切分）────────────────────────────────────────────────────────

function buildPalette(frames: GifFrame[]): Uint8Array {
    const histogram = new Map<number, number>();
    for (const frame of frames) {
        const pixels = frame.width * frame.height;
        const step = Math.max(1, Math.floor(pixels / SAMPLE_BUDGET_PER_FRAME));
        for (let p = 0; p < pixels; p += step) {
            const o = p * 4;
            // alpha < 255 的像素按不透明处理（帧源为视频抽帧，天然全不透明；
            // 见文件头边界注）
            const packed = (frame.rgba[o] << 16) | (frame.rgba[o + 1] << 8) | frame.rgba[o + 2];
            histogram.set(packed, (histogram.get(packed) ?? 0) + 1);
        }
    }
    const palette = new Uint8Array(PALETTE_SIZE * 3);
    if (histogram.size === 0) return palette;
    // 单盒 = [packed, count][]；按色域最宽通道递归二分至 256 盒
    let boxes: Array<Array<[number, number]>> = [[...histogram.entries()]];
    while (boxes.length < PALETTE_SIZE) {
        // 找色域最宽的可分盒（全通道 range 0 的盒不可分，跳过）
        let widest = -1;
        let widestRange = 0;
        let widestChannel = 0;
        for (let i = 0; i < boxes.length; i++) {
            const box = boxes[i];
            if (box.length < 2) continue;
            for (let channel = 0; channel < 3; channel++) {
                const range = channelRange(box, channel);
                if (range > widestRange) {
                    widestRange = range;
                    widest = i;
                    widestChannel = channel;
                }
            }
        }
        if (widest < 0 || widestRange === 0) break;
        const box = boxes[widest];
        box.sort((a, b) => channelOf(a[0], widestChannel) - channelOf(b[0], widestChannel));
        // 按累计像素数的中点切分（加权中位，天然颜色多的色域分得更细）
        let total = 0;
        for (const [, count] of box) total += count;
        let acc = 0;
        let splitAt = 1;
        for (let i = 0; i < box.length - 1; i++) {
            acc += box[i][1];
            if (acc >= total / 2) {
                splitAt = i + 1;
                break;
            }
        }
        if (splitAt >= box.length) splitAt = box.length - 1;
        boxes.splice(widest, 1, box.slice(0, splitAt), box.slice(splitAt));
    }
    // 盒均值即调色板项（逐通道加权平均，四舍五入）
    for (let i = 0; i < boxes.length && i < PALETTE_SIZE; i++) {
        const box = boxes[i];
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let weight = 0;
        for (const [packed, count] of box) {
            rSum += channelOf(packed, 0) * count;
            gSum += channelOf(packed, 1) * count;
            bSum += channelOf(packed, 2) * count;
            weight += count;
        }
        palette[i * 3] = Math.round(rSum / weight);
        palette[i * 3 + 1] = Math.round(gSum / weight);
        palette[i * 3 + 2] = Math.round(bSum / weight);
    }
    return palette;
}

function channelOf(packed: number, channel: number): number {
    return (packed >> (16 - channel * 8)) & 0xff;
}

function channelRange(box: Array<[number, number]>, channel: number): number {
    let min = 255;
    let max = 0;
    for (const [packed] of box) {
        const v = channelOf(packed, channel);
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return max - min;
}

// ─── 量化（5-bit 桶缓存最近邻）───────────────────────────────────────────────

function quantizeFrame(frame: GifFrame, palette: Uint8Array): Uint8Array {
    const indices = new Uint8Array(frame.width * frame.height);
    const bucketCache = new Map<number, number>();
    const pixels = indices.length;
    for (let p = 0; p < pixels; p++) {
        const o = p * 4;
        const r = frame.rgba[o];
        const g = frame.rgba[o + 1];
        const b = frame.rgba[o + 2];
        // 5-bit 桶：32³ = 32768 上限；同桶色共享最近邻结果（自然图像足够）
        const bucket = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
        let index = bucketCache.get(bucket);
        if (index === undefined) {
            index = nearestPaletteIndex(palette, r, g, b);
            bucketCache.set(bucket, index);
        }
        indices[p] = index;
    }
    return indices;
}

function nearestPaletteIndex(palette: Uint8Array, r: number, g: number, b: number): number {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < PALETTE_SIZE; i++) {
        const o = i * 3;
        const dr = palette[o] - r;
        const dg = palette[o + 1] - g;
        const db = palette[o + 2] - b;
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
            if (distance === 0) break;
        }
    }
    return best;
}

// ─── LZW（GIF 变长码）────────────────────────────────────────────────────────

/** LZW 压缩：索引流 → GIF 变长码字节（含 255 字节子块打包；不带头尾块结构）。 */
function lzwEncode(minCodeSize: number, indices: Uint8Array): Uint8Array {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = endCode + 1;
    // 词典：key = (prefix << 8) | nextIndex（prefix ≤ 4095、index ≤ 255，key 唯一）
    let dictionary = new Map<number, number>();
    // 位流打包（低位先行，GIF 规范）
    let acc = 0;
    let accBits = 0;
    const bytes: number[] = [];
    const emit = (code: number) => {
        acc |= code << accBits;
        accBits += codeSize;
        while (accBits >= 8) {
            bytes.push(acc & 0xff);
            acc >>>= 8;
            accBits -= 8;
        }
    };
    emit(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        const found = dictionary.get(key);
        if (found !== undefined) {
            prefix = found;
            continue;
        }
        emit(prefix);
        if (nextCode === 4096) {
            // 词典满：发 clear 重置（码长回落，词典清空）
            emit(clearCode);
            dictionary.clear();
            codeSize = minCodeSize + 1;
            nextCode = endCode + 1;
        } else {
            // 新码即将占用 codeSize 位之上时先增码长（与解码端对称的判定点）
            if (nextCode >= (1 << codeSize) && codeSize < 12) codeSize++;
            dictionary.set(key, nextCode);
            nextCode++;
        }
        prefix = k;
    }
    emit(prefix);
    emit(endCode);
    if (accBits > 0) bytes.push(acc & 0xff);
    // 255 字节子块打包
    const packed: number[] = [];
    for (let i = 0; i < bytes.length; i += 255) {
        const chunk = bytes.slice(i, i + 255);
        packed.push(chunk.length, ...chunk);
    }
    return new Uint8Array(packed);
}

// ─── 装配工具 ────────────────────────────────────────────────────────────────

function pushAscii(out: number[], text: string): void {
    for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i));
}

function pushLe16(out: number[], value: number): void {
    out.push(value & 0xff, (value >> 8) & 0xff);
}
