# 命名规范

命名必须**自解释且可机械校验**。每条给出判定方式；review 时以判定为准，不凭语感。

## 1. 目录名

**规则**：kebab-case；由完整英文单词组成；允许出现 glossary 中的锁定术语（如 `almightydb`）；HTTP 动词（get/post/put/delete）禁止作为目录名。
**判定**：目录名匹配 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`，且不含缩写白名单之外的缩写。
**缩写白名单**：`api`、`db`、`http`、`id`、`ui`、`url`、`ws`。业务域名（archive）与基础设施登记专名（如 `almightydb`）按 glossary 锁定，不受白名单约束。
**正例**：✅ `config-store`、`almightydb`、`archive`、`zookeeper`
**反例**：❌ `apis/get`、`apis/post`（HTTP 动词无语义，曾经的残留已清除）；❌ `cfg`（白名单外缩写）；❌ `ConfigStore`、`config_store`

## 2. 源文件名

**规则**：
- core 能力目录内的实现文件：kebab-case，建议 `<动词>-<能力名>.ts`（工厂）或 `<能力名>.ts`（其他）；
- features 内普通 ts 文件：kebab-case；
- React 组件文件：PascalCase `.tsx`；
- 每个模块目录入口固定为 `index.ts`。
**判定**：非组件、非 `.d.ts`、非豁免清单（directory-structure.md R7）的文件名匹配 kebab-case 正则；组件文件匹配 `^[A-Z][A-Za-z0-9]*\.tsx$`。
**正例**：✅ `create-config-store.ts`、`use-zookeeper-status.ts`、`ChatScreen.tsx`
**反例**：❌ `createConfigStore.ts`（文件名驼峰）、❌ `utils.ts`（在 core 下无能力语义——utils 是禁用名，见 §5）

## 3. TypeScript 标识符

**规则**：
| 对象 | 风格 | 形式 |
|---|---|---|
| 变量、函数 | camelCase | — |
| 类型、接口、组件 | PascalCase | 接口不加 `I` 前缀 |
| 工厂函数 | camelCase | `createXxx`，且 `Xxx` = 产物名 |
| React hook | camelCase | `useXxx`，`use` 前缀**仅** hook 可用 |
| 常量对象 | camelCase 或 PascalCase | 全大写下划线（`SNAKE_CASE`）仅限模块内字面量常量 |
| store 实例（config 层） | camelCase | `<domain>Config`，如 `archiveConfig` |
| 组件 props 类型 | PascalCase | `<组件名>Props` |

**判定**：`createXxx` 的返回值名称/文档必须能对应 `Xxx`；出现 `useXxx` 非 hook（未在 React 组件内调用、未遵循 hook 规则）即违规。
**反例**：❌ `interface IArchiveConfig`；❌ 普通函数叫 `useData`；❌ `create_config_store`

## 4. 持久化存储 key（AsyncStorage / SecureStore）

**规则**：`<domain>.<purpose>`，全小写，段间单个点号；`purpose` ∈ {config, state, cache}。
**判定**：匹配 `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`。
**正例**：✅ `archive.config`
**反例**：❌ `archiveConfig`、❌ `archive_config`、❌ `archive`（无 purpose 段，扩展后必撞名）

## 5. 禁用名

以下名字在任何位置（目录/文件/标识符）禁止使用，因为它们不承载语义、必然演化成垃圾抽屉：
`utils`、`helpers`、`common`、`misc`、`shared`、`core/core`、`index2`、`new`、`temp`、`final`。
**判定**：`find src -iname '*util*' -o -iname '*helper*' -o -iname '*common*' -o -iname '*misc*' -o -iname '*shared*'`（排除 node_modules）输出为空。
要放"多处置"的东西时，先回答 directory-structure.md 决策树，落位到具体能力目录。

## 6. 环境变量

**规则**：客户端可见变量必须 `EXPO_PUBLIC_` 前缀（Expo 约定）；凭据禁止走环境变量进客户端包，走 config 层 + secret 实现要求（见 glossary §2）。
**判定**：`grep -rn 'process.env.EXPO' src | grep -v EXPO_PUBLIC_` 输出为空。

## 7. 文档命名

**规则**：`docs/` 下文档 kebab-case；规范类文档放 `docs/standards/`；一份文档一个主题，禁止 `notes.md`、`todo.md` 这类无主题名。
**判定**：`find docs -name '*.md'` 匹配 kebab-case 且 `standards/README.md` 登记过。
