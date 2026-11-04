# AGENTS.md — archive 仓库强制规则

适用对象：所有协作者与 AI agent。本文件是 [docs/standards/](docs/standards/README.md) 的最小强制集；冲突时以 standards 为准。**任何操作拿不准时，先读 standards 再动手。**

## 0. 环境事实

- 仓库根 = `/workspace/archive`；**Expo 项目根在 `src/`**（package.json、tsconfig.json 都在这里，跑命令先 `cd src`）。
- 本仓库由 mobile 模板（`/workspace/mobile`）复制而来（2026-11-05），承载**行程 × 日记 local-first 应用**（纯前端工具，无后端依赖）。core 层自模板原样继承（含模板品牌资产 `hatch-logo` / `HATCH_PALETTE`），模板演示页已裁剪。
- 包管理 pnpm；类型检查 `pnpm typecheck`（= `tsc --noEmit`）；无 ESLint。
- 技术栈：Expo SDK 58 + expo-router（typedRoutes）+ NativeWind v4 + zustand；路径别名 `@/*` → `src/*`。
- 中文协作，代码/标识符/路径英文。

## 1. 最高原则：规范先行

1. 规范未覆盖的情况：**先**在 docs/standards/ 补规则（四段式：规则/判定/正例/反例），**再**写代码。
2. 代码与规范冲突：以规范为准修代码。认为规范错了：同一次提交内先改规范再改代码，两者不得并存矛盾。
3. 判定命令结果是唯一裁决（见 standards/README.md 自检一节），不凭语感争论。
4. **UI 开发/改版/动效任务**：开工前按 [docs/design-skills/index.md](docs/design-skills/index.md) 的选用规则读取对应 SKILL.md（frontend-design 必读）；技能内容与仓库规范冲突时仓库规范优先。

## 2. 硬规则（H1–H11）

| # | 规则 | 判定 |
|---|---|---|
| H1 | 模块=目录+`index.ts`，config/core/features 下禁平铺 .ts | `find src/config src/core src/features -maxdepth 1 -name '*.ts'` 为空 |
| H2 | 目录/文件 kebab-case，HTTP 动词不做目录名，禁用 utils/helpers/common/misc/shared | naming.md §1/§2/§5 正则与 find |
| H3 | 数据按形态落位（glossary §2 判定表）：配置→`config-store`（凭据用 secure 选项）；结构化数据→`data-store`（复杂关系模型经 `database` 自建表）；二进制文件→`file-storage`；跨启动缓存→`cache-store`；打包迁移→`migration`。core 只登记 glossary §3 表内的能力目录，新能力先登记再创建 | glossary §2 形态表 + §3 登记表 |
| H4 | 依赖只能向下：app→features→service→config→core；service 禁 import `@/app` `@/features`；core 禁 import `@/app` `@/features` `@/config` | layering.md L1 四条 grep 为空 |
| H5 | core 必须业务无关（换项目可原样搬走），不得出现业务域名 archive（模板品牌资产 `hatch-logo` / `HATCH_PALETTE` 属 core 既有件，不在此列；almightydb 是 core 自身设施） | `grep -rni 'archive' src/core` 为空 |
| H6 | 跨模块 import 只到目录入口，禁深路径 | `grep -rnE "from '@/core/[a-z-]+/" src` 等为空 |
| H7 | 禁止空占位（.gitkeep / 0 字节文件 / 空目录），目录随第一个真实文件创建 | `find . -name '.gitkeep'`、`find src -type d -empty` 为空 |
| H8 | AsyncStorage key 格式 `<domain>.<purpose>`，如 `archive.config` | naming.md §4 正则 |
| H9 | 业务域锁定 **archive**（本仓库当前唯一业务域；新增域先登记 glossary §1 再建目录）；`almightydb` 是本地统一存储基础设施（文件+app生成数据+缓存+迁移），**不是业务域**；core 下禁现业务域名 | `ls src/config src/features` 对照 glossary §1 |
| H10 | 配置字段里凭据类（key/token/secret/password）最终存储必须 SecureStore；迁移完成前**不得新增明文凭据字段** | layering.md L6 |
| H11 | 错误契约：core 运行时错误必须为 CodedError 子类，code=`<capability>/<kind>`（error-handling.md R2 登记表），带 retryable；**禁止静默吞错**（空 catch 必须有注释或上报）；参数校验用 TypeError/RangeError；薄封装模块透传 expo 错误不包装 | error-handling.md R1–R6 判定命令 |

## 3. 新文件落位（决策树摘要）

路由壳 → `src/app/`；业务域配置 → `src/config/<domain>/`；**通用网络传输（POST / WebSocket）→ `src/service/`**；业务域协议客户端与业务 UI/编排 → `src/features/<domain>/`；业务无关且 ≥2 复用 → `src/core/<capability>/`（先登记 glossary）；打包静态文件 → `src/assets/<kind>/`；都不是 → 停，先补规范。完整版见 directory-structure.md §3。

## 4. 已知偏差表（Known Deviations）

规范生效日 2026-10-29 起登记。偏差必须记录于此并给出清偿计划；未登记的偏差按违规处理：

| 偏差 | 现状 | 清偿计划 |
|---|---|---|
| ~~凭据明文存储~~ | **已清偿（2026-10-29）**：config-store 新增 `secure` 选项，`archive.config` 的 zookeeperKey/gatewayKey 走系统加密存储（native: SecureStore / Keychain-Keystore；web: localStorage 回退，保密强度有限已注明） | 无遗留 |
| NativeWind web 端样式缺失 | **已登记（2026-10-30）**：css-interop 0.2.6 的虚拟模块补丁在 SDK 58 Metro 内部结构下失效，web 端 className 全部无样式（电脑端 web 视为只读预览，非交付目标；已用 `+html.tsx` 挂 `public/nativewind.css` link 绕过，产物由 `pnpm web:css` 生成）。**真机无样式根因已于 2026-10-30 定位并修复：d58a775 重构丢失 `src/app/_layout.tsx` 的 `import '../global.css'`——metro.config 的 `input` 只指定编译对象，CSS 进 bundle 的唯一入口是该 import（`.cache/<platform>.js` 需被引用才会打包）**，已补回并验证 bundle 含编译数据 | 升级 nativewind/css-interop 修复后移除 forceWriteFileSystem 与 +html link，并回归测试 |
| SDK 58 web 变体是纯 stub → file-storage web 走 OPFS 直连 | **已登记并修复（2026-11-05，二次修正）**：`build/ExpoFileSystem.web.js` 的 FileSystemFile/Directory **全部方法仅 console.warn + reject**（含 documentDirectory 无实现）——validatePath polyfill 只能救构造，读写全废。**处置：`core/file-storage` 增加 `web-opfs.ts`（浏览器原生 OPFS 后端，持久不丢），web 分流；native 路径保持 expo-file-system 不动；新增 `putFromUri`（picker 产物直落）并回灌 mobile 模板**。migration 能力 web 侧仍不可用（底层 stub），登记为已知限制 | expo-file-system 上游提供 web 实现后移除 OPFS 分流与 polyfill，回归三端 |
| expo-router web push 丢弃 query 参数 | **已登记并绕开（2026-11-05）**：`router.push` 携带 query（object `params` 与 string `?a=b` 两种形式实测均然）在 web 构建下 `pushState` 只落裸路径，跨屏参数全部丢失。**处置：跨屏传参一律走路径参数**（`write`、`trip/[id]/write/[date]`、`journal/[id]`，路由适配层把 `[id]`/`[date]` 映射为屏 props），三端行为一致 | 升级 expo-router 修复后可恢复 query 形式，但路径参数亦无回退必要 |
| 双主题 flag 依赖 `public/nativewind.css` 再生成 | **已登记（2026-11-05）**：web 端 css-interop 的 darkMode flag 只从 `+html.tsx` 挂的 `public/nativewind.css` `:root` 变量读取（`pnpm web:css` 产物）；tailwind `darkMode: 'class'` 改动或新增 `dark:` 类后**必须重跑 `pnpm web:css` + 重启 dev server（native 走 `.cache/*`）**，两条管线各自出一份规则。`StyleSheet.setFlag` 在 css-interop 0.2.6 不存在；`colorScheme.set` 只能在 effect/回调调（web 渲染期无 window 会抛错）；web 初始恒 'light'，「跟随系统」由启动时显式 `set('system')` 恢复（root `_layout` 已做） | 升级 nativewind/css-interop 修复 dev 虚拟模块后自动收敛 |

## 5. 历史残留清理记录

2026-10-29 已清除（不得回潮）：almightydb 登记处（**2026-10-30 重建后同日自顶层迁入 `src/almightydb/`**，含 README，属登记例外，不得当作残留清除）、tests/、deploy/、workflow/ 空占位；`src/almightydb/`、`src/features/`、`src/.gitkeep` 等空占位与 0 字节文件（其中 `src/features/` 于 2026-10-30 按用户指令重建——含层入口 `index.ts` 与 R8 结构约定，属登记过的例外，不得再当作残留清除）；`src/config/{almightydb,workflow}.ts` 0 字节文件；`core/apis/{get,post,ws}`、`core/hatch/` 空目录（违反 H2/H5）；`src/.python-version`（Python 残留）；tsconfig 对 features 的无理由 exclude。详见 git 历史 `standards:` 提交。

其中 almightydb 的三处旧占位（顶层目录 / src 目录 / config 文件）因定位不明而清除；同日重新确认其定位为**本地统一存储体系**。当日晚些时候实现方式再定为：core 收口为**平铺的通用能力接口**（database / data-store / cache-store / file-storage / migration 等，见 glossary §3 登记表），almightydb 降级为存储五件套的**统称**而非目录——后续 agent 不得再建 `core/almightydb/` 目录，也不得把 2026-10-29 更早的"almightydb=业务域"口径当作有效信息。

**用户白名单（2026-10-30 用户指令登记）**：顶层 `DEV.md`（0 字节占位，H7 豁免）、`deploy/`（含 .gitkeep）、`workflow/`（含 .gitkeep）、`src/public/` 为用户保存的文件/目录，**任何 agent 不得当作残留清理或自动删除**（§5 上述对 deploy/workflow 的清理记录对这些路径不再适用）。其去留与内容仅由用户本人处置。
