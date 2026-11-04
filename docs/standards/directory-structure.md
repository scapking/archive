# 目录结构规范

目录是本项目组织代码的**唯一**手段：一个模块 = 一个目录 + `index.ts` 入口。禁止平铺单文件模块（豁免清单见 R7）。

## 1. 仓库布局

```
/workspace/archive/
├── AGENTS.md            # 协作者与 AI agent 强制规则（本规范的最小集）
├── README.md
├── LICENSE
├── docs/
│   └── standards/       # 规范全文（本目录）
│       ├── README.md
│       ├── glossary.md
│       ├── directory-structure.md
│       ├── naming.md
│       └── layering.md
├── src/                 # ★ Expo 项目根（package.json / app.json 在此）
│   ├── app/             # 路由层：仅 expo-router 路由文件
│   ├── service/         # 服务层：通用网络传输（post / socket），业务协议客户端归 features
│   │   ├── index.ts     # 对外 API 收口
│   │   ├── post/
│   │   │   ├── errors.ts
│   │   │   └── index.ts
│   │   └── socket/
│   │       ├── errors.ts
│   │       └── index.ts
│   ├── config/          # 配置层：每业务域一目录
│   │   └── archive/
│   │       └── index.ts
│   ├── core/            # 基础设施层：通用能力接口，每能力一目录（glossary §3 登记表）
│   │   ├── config-store/
│   │   │   └── index.ts         # 还有 create-config-store.ts / secure-storage.ts
│   │   ├── database/            # 通用 SQL（含 errors.ts）
│   │   ├── data-store/          # 通用文档数据
│   │   ├── cache-store/         # 通用缓存
│   │   ├── file-storage/        # 通用文件（含 errors.ts）
│   │   ├── migration/           # 通用迁移（含 errors.ts）
│   │   ├── notifications/       # 通用通知（含 errors.ts）
│   │   ├── camera/ location/ audio/ video/ image-picker/
│   │   ├── clipboard/ crypto/ sharing/ web-browser/ linking/
│   ├── features/        # 功能层：按业务域一目录（R8 结构约定），层入口 index.ts
│   └── assets/          # 静态资产
│       ├── fonts/
│       └── images/
├── tests/               # （未来）跨模块集成测试；存在时才创建
└── deploy/              # （未来）部署配置；存在时才创建
```

## 2. 规则

### R1 目录即模块
**规则**：config、core 下的每个模块必须是目录，入口为 `index.ts`；features、service 为集合层——根 `index.ts` 是层入口（对外收口，唯一豁免的平铺文件），层下每个成员必须是目录（成员自己的 `index.ts` 为入口）。
**判定**：
```bash
find src/config src/core -maxdepth 1 -name '*.ts' -type f 2>/dev/null                                  # 空
find src/service src/features -maxdepth 1 -name '*.ts' -type f 2>/dev/null | grep -v '/index.ts'        # 空
```
**正例**：✅ `src/config/archive/index.ts`、✅ `src/features/index.ts`（层入口）
**反例**：❌ `src/config/archive.ts`（H1 禁平铺单文件）；❌ `src/features/utils.ts`

### R2 职责不重叠
**规则**：同一职责只允许一个目录承担（glossary 已逐一指定存放位置）。禁止为同一职责建第二个位置，无论命名多相近。
**判定**：新增目录前，在 glossary 的登记表/业务域表中检索职责关键词；已存在 → 复用，不存在 → 先修订 glossary 再建。
**正例**：✅ 键值配置持久化只存在于 `core/config-store`
**反例**：❌ 又建一个 `core/persist` / `core/settings-store` 做键值配置持久化

### R3 无空占位
**规则**：禁止 `.gitkeep`、0 字节占位文件、空目录。目录在**第一个真实文件**落地时创建；职责未启动就不存在。
**判定**：`find . -name '.gitkeep' -not -path './.git/*' -not -path '*/node_modules/*'` 输出为空；`find src -type d -empty -not -path '*/node_modules/*'` 输出为空。
**历史**：仓库曾有 8 个 .gitkeep 占位与 0 字节配置文件，2026-10-29 已全部清除，不得回潮。

### R4 app/ 只放路由
**规则**：`src/app/` 下只允许 expo-router 约定文件（`index` / `_layout` / `+html` / `+not-found` / 路由组 `(group)` / 语义化页面名）。业务逻辑、API 调用、store 一律放 features。
**判定**：app/ 下文件 import 白名单 = `expo-router*`、`react-native*`、`@/features/*`、`../global.css`；超出即违规。

### R5 assets 按种类分子目录
**规则**：`src/assets/` 下仅允许 `fonts/`、`images/`（未来新增种类需先改本文件）。文件名规范见 naming.md。
**判定**：`ls src/assets` ⊆ {fonts, images}。

### R6 顶层目录白名单
**规则**：仓库根下只允许 `AGENTS.md`、`README.md`、`LICENSE`、`.gitignore`、`docs/`、`src/`（及未来的 `tests/`、`deploy/`）。禁止新增其他顶层目录/文档根。almightydb 登记处位于 `src/almightydb/`（2026-10-30 自顶层迁入，随实现代码同域）。
**判定**：`ls` 仓库根逐一对照白名单。

### R7 平铺文件豁免清单
以下平铺文件是**完整枚举**的豁免，新增豁免必须先修订本清单：
`src/` 下的 `package.json`、`app.json`、`tsconfig.json`、`babel.config.js`、`metro.config.js`、`tailwind.config.js`、`global.css`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc`、`.gitignore`、`expo-env.d.ts`、`nativewind-env.d.ts`；`src/app/` 下的路由文件；类型声明文件（`*.d.ts`）；features 与 service 的层入口 `index.ts`（R1）。

### R8 features 结构约定
**规则**：features 按业务域一目录（如 `features/archive/`），域入口 `index.ts`；域内纯逻辑文件以 `-logic.ts` 结尾——**禁止 import `react`、`react-native` 与任何 `.tsx` 组件**，保证逻辑可独立单测；域之间禁止互相 import（跨域协调经各自 index.ts 之外的显式通道，如 service 或 features/index.ts 收口）。
**判定**：`grep -rlnE "from '(react|react-native)" src/features --include='*-logic.ts'` 为空。
**正例**：✅ `features/archive/connection-logic.ts`（纯函数/状态机，可 node 单测）
**反例**：❌ `features/archive/chat-screen-logic.ts` 里 import { View } from 'react-native'

### R9 业务域自建表（复杂关系模型）
**规则**：确有复杂关系模型的业务域（glossary §2：data-store 文档型装不下时），在 `features/<domain>/db/` 内自建表，固定三文件：`schema.ts`（DDL 常量 + 行类型）、`migrations.ts`（`SchemaMigration[]`，version 递增且**只追加**，历史迁移发布后禁改）、`index.ts`（`openDatabase('<domain>.db', { migrations })` 单例 + 类型化查询函数，域内唯一 SQL 出口——域内其他文件禁止散写 SQL）。数据库文件按域隔离（`<domain>.db`），不与 core 五件套共库（`almightydb.db`）。
**判定**：`grep -rn "openDatabase(" src/features` 只出现在 `*/db/index.ts`；migrations 版本号单调递增。
**正例**：✅ `features/archive/db/index.ts` 导出 `listRecentEntries()`
**反例**：❌ `features/archive/trip-screen.tsx` 里直接 `openDatabase('archive.db')`；❌ 把图片二进制塞进 sqlite（glossary §2：user file 走 file-storage）

## 3. 新文件落位决策树

按顺序自问，**命中即停**。任何一步拿不准，答案都是"先补规范再写代码"，禁止自行发明位置：

1. 是 expo-router 路由/布局？→ `src/app/`
2. 是为业务域声明配置字段？→ `src/config/<domain>/index.ts`
3. 是通用网络传输需求（POST / WebSocket）？→ `src/service/`
4. 代码依赖某个业务域（业务协议客户端、读其配置、调其服务、渲染其 UI）？→ `src/features/<domain>/`
5. 与业务无关、且能被 ≥2 个模块复用？→ `src/core/<capability>/`（先过 layering.md 的 core 纯净检查，先登记 glossary）
6. 打包期静态文件？→ `src/assets/<kind>/`
7. 都不是？→ **停**。在 `docs/standards/` 提交规则修订，落位明确后再动代码。

注意第 3、4 步的顺序：**纯协议调用进 service，带 UI/状态编排的业务进 features**。core 的判定标准是"换一个业务项目也能原样搬走"。
