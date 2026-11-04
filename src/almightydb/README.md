# almightydb

本地统一存储体系的**登记处**（spec & registry，2026-10-30 自仓库顶层迁入 `src/`，与实现代码同域）。代码本体在 `src/core/`（见 [standards/glossary.md §3](../standards/glossary.md) 基础设施登记表），本目录承载该体系的定义、版本与格式约定——改任何格式前先改这里。

## 定位

almightydb = 存储五件套的统称（非目录、非业务域）：app 生成数据、二进制文件、缓存、配置凭据的统一本地持久化，以及数据的整体打包迁移。

## 成员（实现位置）

| 成员 | 职责 | 代码 |
|---|---|---|
| config-store | 标量键值配置 + 凭据（secure） | `src/core/config-store/` |
| database | 通用 SQL（sqlite，迁移注册表） | `src/core/database/` |
| data-store | 结构化数据（documents 表） | `src/core/data-store/` |
| cache-store | TTL 缓存（cache_entries 表） | `src/core/cache-store/` |
| file-storage | 二进制文件（统一 SHA-256 元数据） | `src/core/file-storage/` |
| migration | 打包导出/导入（zip） | `src/core/migration/` |

## 存储布局（设备端）

```
Paths.document/almightydb/
├── files/<key>          # file-storage（key 为相对路径，防穿越）
└── bundles/<uuid>.zip   # migration 迁移包
almightydb.db            # sqlite（data-store + cache-store + file_meta 共库）
```

## schema 版本（PRAGMA user_version）

| 版本 | 表 | 所有者 |
|---|---|---|
| 1 | `documents` | data-store |
| 2 | `cache_entries` | cache-store |
| 3 | `file_meta` | file-storage |

规则：各能力自持 `SCHEMA_MIGRATIONS`，版本号全库递增互不冲突；migration 组合全部 schema 实现 fresh 设备整库重建。新增表 = 追加版本 + 更新本表。

## 迁移包格式（v1）

单个 zip（store 模式，自研读写见 `src/core/migration/zip.ts`）：`manifest.json`（数据记录 + 文件清单含 SHA-256 + 可选缓存）+ `files/<key>`。防 zip-slip（条目名白名单）+ CRC32 校验 + 导入时逐文件复核 SHA-256。格式变更 = 版本字段 + 更新本节。
