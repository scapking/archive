/**
 * 极简 ZIP 读写（仅 store/不压缩方法），用于 migration 的跨设备迁移包。
 *
 * 为什么手写而不是引依赖：包内容完全由本模块生成（manifest.json + files/<key>），
 * 格式固定、无需压缩比；零依赖换来可审计性与三端一致（纯 JS）。
 * 读取端只接受本模块生成的布局：名称白名单校验（防 zip-slip）、CRC32 校验。
 */
import { MigrationError } from './errors';

const ENTRY_NAME_PATTERN = /^(manifest\.json|files(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*)$/;

export interface ZipEntry {
    name: string;
    data: Uint8Array;
}

// ---------- 写入 ----------

export function createZip(entries: ZipEntry[]): Uint8Array {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        if (!ENTRY_NAME_PATTERN.test(entry.name)) {
            throw new MigrationError('migration/invalid-bundle', `zip: 非法条目名 "${entry.name}"`);
        }
        const nameBytes = encoder.encode(entry.name);
        const crc = crc32(entry.data);
        const headerSize = 30 + nameBytes.length;

        const local = new Uint8Array(headerSize);
        const view = new DataView(local.buffer);
        view.setUint32(0, 0x04034b50, true); // local file header signature
        view.setUint16(4, 20, true); // version needed
        view.setUint16(6, 0, true); // flags
        view.setUint16(8, 0, true); // method: store
        view.setUint16(10, 0, true); // mod time
        view.setUint16(12, 0x0021, true); // mod date (1980-01-01)
        view.setUint32(14, crc, true);
        view.setUint32(18, entry.data.length, true); // compressed size
        view.setUint32(22, entry.data.length, true); // uncompressed size
        view.setUint16(26, nameBytes.length, true);
        view.setUint16(28, 0, true); // extra length
        local.set(nameBytes, 30);

        chunks.push(local, entry.data);

        const centralEntry = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(centralEntry.buffer);
        centralView.setUint32(0, 0x02014b50, true); // central directory signature
        centralView.setUint16(4, 20, true); // version made by
        centralView.setUint16(6, 20, true); // version needed
        centralView.setUint16(8, 0, true); // flags
        centralView.setUint16(10, 0, true); // method: store
        centralView.setUint16(12, 0, true); // mod time
        centralView.setUint16(14, 0x0021, true); // mod date
        centralView.setUint32(16, crc, true);
        centralView.setUint32(20, entry.data.length, true);
        centralView.setUint32(24, entry.data.length, true);
        centralView.setUint16(28, nameBytes.length, true);
        centralView.setUint32(42, offset, true); // local header offset
        centralEntry.set(nameBytes, 46);
        central.push(centralEntry);

        offset += headerSize + entry.data.length;
    }

    const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true); // EOCD signature
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);

    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let position = 0;
    for (const chunk of [...chunks, ...central, end]) {
        out.set(chunk, position);
        position += chunk.length;
    }
    return out;
}

// ---------- 读取 ----------

export function readZip(zip: Uint8Array): ZipEntry[] {
    const eocd = findEndOfCentralDirectory(zip);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const entryCount = view.getUint16(eocd + 10, true);
    let pointer = view.getUint32(eocd + 16, true);

    const entries: ZipEntry[] = [];
    for (let index = 0; index < entryCount; index += 1) {
        if (view.getUint32(pointer, true) !== 0x02014b50) {
            throw new MigrationError('migration/invalid-bundle', 'zip: 中央目录损坏');
        }
        const method = view.getUint16(pointer + 10, true);
        const crc = view.getUint32(pointer + 16, true);
        const compressedSize = view.getUint32(pointer + 20, true);
        const nameLength = view.getUint16(pointer + 28, true);
        const localOffset = view.getUint32(pointer + 42, true);
        const name = new TextDecoder().decode(zip.subarray(pointer + 46, pointer + 46 + nameLength));
        pointer += 46 + nameLength;

        if (method !== 0) {
            throw new MigrationError('migration/invalid-bundle', `zip: 不支持压缩方法 ${method}（${name}）——本格式只接受 store`);
        }
        if (!ENTRY_NAME_PATTERN.test(name)) {
            throw new MigrationError('migration/invalid-bundle', `zip: 拒绝非法条目名 "${name}"`);
        }

        const localNameLength = view.getUint16(localOffset + 26, true);
        const extraLength = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localNameLength + extraLength;
        const data = zip.slice(dataStart, dataStart + compressedSize);
        if (crc32(data) !== crc) {
            throw new MigrationError('migration/invalid-bundle', `zip: CRC 校验失败（${name}）`);
        }
        entries.push({ name, data });
    }
    return entries;
}

function findEndOfCentralDirectory(zip: Uint8Array): number {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let offset = zip.length - 22; offset >= 0; offset -= 1) {
        if (view.getUint32(offset, true) === 0x06054b50) return offset;
    }
    throw new MigrationError('migration/invalid-bundle', 'zip: 缺少 EOCD，不是本模块生成的 zip');
}

// ---------- CRC32（ISO 3309，zip 标准） ----------

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let index = 0; index < data.length; index += 1) {
        crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
