import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { openDatabase } from '@/core/database';
import { fileStorage } from '@/core/file-storage';
import { SCHEMA_MIGRATIONS as DATA_STORE_SCHEMA } from '@/core/data-store';
import { SCHEMA_MIGRATIONS as CACHE_STORE_SCHEMA } from '@/core/cache-store';
import { MigrationError, toMigrationError } from './errors';
import { createZip, readZip } from './zip';

/**
 * 通用迁移接口：app 生成的数据整体打包导出 / 导入，支撑设备间快速迁移与备份恢复。
 * 覆盖范围 = dataStore 的 documents + fileStorage 的文件 +（可选）cacheStore 的缓存；
 * 经 core/database 自建的自定义表不在迁移范围内（有此需求时在此登记导出器）。
 *
 * 包 = 单个 zip 文件（store 模式，见 zip.ts）：manifest.json + files/<key>。
 * 相比目录包的优势：native 可直接走系统分享、web 可下载/上传——跨设备传输三端可用。
 * 缓存默认不导出（可从源头重建，符合 glossary §2 对 cache 的定义）。
 */
export interface MigrationExportOptions {
    /** 缺省 { files: true, data: true, cache: false } —— 缓存可重建，默认不迁移 */
    include?: {
        files?: boolean;
        data?: boolean;
        cache?: boolean;
    };
}

export interface MigrationImportOptions {
    /** 与现有记录/文件冲突时是否覆盖，默认 true（迁移语义：以包为准） */
    overwrite?: boolean;
}

export interface MigrationBundleInfo {
    id: string;
    createdAt: number;
    counts: {
        files: number;
        records: number;
        cacheEntries: number;
    };
}

export interface MigrationImportResult {
    bundleId: string;
    files: number;
    records: number;
    cacheEntries: number;
}

interface ManifestFile {
    key: string;
    sha256: string;
}

interface Manifest {
    id: string;
    createdAt: number;
    counts: MigrationBundleInfo['counts'];
    files: ManifestFile[];
    records: ManifestRecord[];
    cache: Array<{ key: string; payload: string; expiresAt: number | null }> | null;
}

interface ManifestRecord {
    collection: string;
    id: string;
    payload: string;
    createdAt: number;
    updatedAt: number;
}

const DATABASE_NAME = 'almightydb.db';
// 组合存储体系各能力的 schema：fresh 设备上 import 前先建齐所有表
const ALL_SCHEMA_MIGRATIONS = [...DATA_STORE_SCHEMA, ...CACHE_STORE_SCHEMA];
const BUNDLE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

let bundlesRootDirectory: Directory | null = null;

/** 包根目录（懒初始化：validatePath polyfill 依赖 file-storage 模块先求值，且模块级实例化不可行）。 */
function bundlesRoot(): Directory {
    if (!bundlesRootDirectory) {
        bundlesRootDirectory = new Directory(Paths.document, 'almightydb', 'bundles');
    }
    return bundlesRootDirectory;
}
const MANIFEST_ENTRY = 'manifest.json';
const FILES_ENTRY_PREFIX = 'files/';

export const migration = {
    /** 导出为一个新的迁移包（单个 .zip），返回包元信息。 */
    async export(options: MigrationExportOptions = {}): Promise<MigrationBundleInfo> {
        const include = { files: true, data: true, cache: false, ...options.include };
        try {
            const id = Crypto.randomUUID();
            const manifest: Manifest = {
                id,
                createdAt: Date.now(),
                counts: { files: 0, records: 0, cacheEntries: 0 },
                files: [],
                records: [],
                cache: null,
            };
            const entries: Array<{ name: string; data: Uint8Array }> = [];

            if (include.files) {
                for (const info of await fileStorage.list()) {
                    // stat 会补齐缺失的元数据（含 SHA-256）
                    const stat = await fileStorage.stat(info.key);
                    if (!stat) continue;
                    const data = await fileStorage.get(info.key);
                    entries.push({ name: `${FILES_ENTRY_PREFIX}${info.key}`, data });
                    manifest.files.push({ key: info.key, sha256: stat.checksum ?? '' });
                }
                manifest.counts.files = manifest.files.length;
            }

            const db = await openDatabase(DATABASE_NAME, { migrations: ALL_SCHEMA_MIGRATIONS });
            if (include.data) {
                manifest.records = await db.getAll<ManifestRecord>(
                    'SELECT collection, id, payload, created_at, updated_at FROM documents',
                );
                manifest.counts.records = manifest.records.length;
            }
            if (include.cache) {
                const rows = await db.getAll<{ key: string; payload: string; expires_at: number | null }>(
                    'SELECT key, payload, expires_at FROM cache_entries',
                );
                manifest.cache = rows.map((row) => ({
                    key: row.key,
                    payload: row.payload,
                    expiresAt: row.expires_at,
                }));
                manifest.counts.cacheEntries = manifest.cache.length;
            }

            entries.push({
                name: MANIFEST_ENTRY,
                data: new TextEncoder().encode(JSON.stringify(manifest)),
            });

            bundlesRoot().create({ idempotent: true, intermediates: true });
            await new File(bundlesRoot(), `${id}.zip`).write(createZip(entries));
            return { id: manifest.id, createdAt: manifest.createdAt, counts: manifest.counts };
        } catch (error) {
            throw toMigrationError(error, 'migration.export()');
        }
    },

    /**
     * 导入一个迁移包。source 是：包 id（bundles/ 下的名字）、包文件的绝对 URI、或 zip 字节
     * （web 端用户上传的 zip 直接传字节即可）。默认覆盖同名记录/文件；overwrite=false 跳过冲突项。
     */
    async import(
        source: string | Uint8Array,
        options: MigrationImportOptions = {},
    ): Promise<MigrationImportResult> {
        const overwrite = options.overwrite ?? true;
        try {
            const zipBytes = typeof source === 'string' ? await resolveBundleFile(source).bytes() : source;
            const entries = readZip(zipBytes);
            const manifestEntry = entries.find((entry) => entry.name === MANIFEST_ENTRY);
            if (!manifestEntry) {
                throw new MigrationError('migration/invalid-bundle', 'migration.import: 包内缺少 manifest.json');
            }
            const manifest = JSON.parse(new TextDecoder().decode(manifestEntry.data)) as Manifest;
            validateManifest(manifest);

            let files = 0;
            let records = 0;
            let cacheEntries = 0;
            const db = await openDatabase(DATABASE_NAME, { migrations: ALL_SCHEMA_MIGRATIONS });

            await db.withTransaction(async () => {
                for (const record of manifest.records ?? []) {
                    const verb = overwrite ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
                    const result = await db.run(
                        `${verb} INTO documents (collection, id, payload, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?)`,
                        [record.collection, record.id, record.payload, record.createdAt, record.updatedAt],
                    );
                    records += result.changes;
                }
                for (const entry of manifest.cache ?? []) {
                    const verb = overwrite ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
                    const result = await db.run(
                        `${verb} INTO cache_entries (key, payload, expires_at) VALUES (?, ?, ?)`,
                        [entry.key, entry.payload, entry.expiresAt],
                    );
                    cacheEntries += result.changes;
                }
            });

            const declaredChecksums = new Map(manifest.files.map((file) => [file.key, file.sha256]));
            for (const entry of entries) {
                if (!entry.name.startsWith(FILES_ENTRY_PREFIX)) continue;
                const key = entry.name.slice(FILES_ENTRY_PREFIX.length);
                const stat = await fileStorage.put(key, entry.data);
                const declared = declaredChecksums.get(key);
                if (declared && stat.checksum !== declared) {
                    throw new MigrationError(
                        'migration/invalid-bundle',
                        `migration.import: 文件校验不一致（${key}）——包可能被篡改`,
                    );
                }
                files += 1;
            }

            return { bundleId: manifest.id, files, records, cacheEntries };
        } catch (error) {
            const label = typeof source === 'string' ? source : `${source.byteLength}B`;
            throw toMigrationError(error, `migration.import(${label})`);
        }
    },

    /** 列出全部迁移包；损坏的包跳过。 */
    async list(): Promise<MigrationBundleInfo[]> {
        const root = bundlesRoot();
        if (!root.exists) return [];
        const bundles: MigrationBundleInfo[] = [];
        for (const entry of root.list()) {
            if (!(entry instanceof File) || !entry.name.endsWith('.zip')) continue;
            try {
                const manifest = readManifestFromZip(await entry.bytes());
                bundles.push({ id: manifest.id, createdAt: manifest.createdAt, counts: manifest.counts });
            } catch {
                // 单个包损坏不影响其余包的列举
            }
        }
        return bundles.sort((a, b) => b.createdAt - a.createdAt);
    },

    /** 删除迁移包；不存在同样视为成功（幂等）。 */
    async remove(bundleId: string): Promise<void> {
        if (!BUNDLE_ID_PATTERN.test(bundleId) || bundleId.length > 128) {
            throw new MigrationError('migration/invalid-bundle', `migration.remove: 非法包 id "${bundleId}"`);
        }
        const bundleFile = new File(bundlesRoot(), `${bundleId}.zip`);
        if (!bundleFile.exists) return;
        try {
            bundleFile.delete();
        } catch (error) {
            throw toMigrationError(error, `migration.remove(${bundleId})`);
        }
    },

    /**
     * 取迁移包的本地 URL（native: file://，web: 本会话 blob:），用于分享/下载到其他设备；
     * 导入侧用 import(bytesOrUri) 收回来。
     */
    async url(bundleId: string): Promise<string> {
        const bundleFile = resolveBundleFile(bundleId);
        if (!bundleFile.exists) {
            throw new MigrationError('migration/not-found', `migration.url: 包不存在 "${bundleId}"`);
        }
        if (globalThis.URL?.createObjectURL) {
            return globalThis.URL.createObjectURL(new Blob([bundleFile]));
        }
        return bundleFile.uri;
    },
};

function resolveBundleFile(source: string): File {
    if (source.includes('://')) return new File(source);
    if (!BUNDLE_ID_PATTERN.test(source) || source.length > 128) {
        throw new MigrationError('migration/invalid-bundle', `migration: 非法包 id "${source}"`);
    }
    return new File(bundlesRoot(), `${source}.zip`);
}

function readManifestFromZip(zipBytes: Uint8Array): Manifest {
    const manifestEntry = readZip(zipBytes).find((entry) => entry.name === MANIFEST_ENTRY);
    if (!manifestEntry) throw new MigrationError('migration/invalid-bundle', 'migration: 包内缺少 manifest.json');
    return JSON.parse(new TextDecoder().decode(manifestEntry.data)) as Manifest;
}

function validateManifest(manifest: Manifest): void {
    for (const record of manifest.records ?? []) {
        if (!BUNDLE_ID_PATTERN.test(record.collection)) {
            throw new MigrationError('migration/invalid-bundle', `migration.import: manifest 内非法 collection "${record.collection}"`);
        }
        if (!BUNDLE_ID_PATTERN.test(record.id)) {
            throw new MigrationError('migration/invalid-bundle', `migration.import: manifest 内非法记录 id "${record.id}"`);
        }
    }
    for (const file of manifest.files ?? []) {
        // 与 file-storage 的 key 规范一致：多段相对路径，段内 [a-zA-Z0-9._-]，杜绝穿越
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/.test(file.key)) {
            throw new MigrationError('migration/invalid-bundle', `migration.import: manifest 内非法文件 key "${file.key}"`);
        }
    }
    for (const entry of manifest.cache ?? []) {
        if (entry.key.includes('..') || entry.key.startsWith('/')) {
            throw new MigrationError('migration/invalid-bundle', `migration.import: manifest 内非法 cache key "${entry.key}"`);
        }
    }
}
