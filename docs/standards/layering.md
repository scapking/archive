# 分层依赖规范

五层结构（定义见 glossary §4），依赖方向**只能向下**：

```
app ──→ features ──→ service ──→ config ──→ core ──→ (仅外部依赖 / core 内部)
 │                     │
 └─────────────────────┴──→（app/features 也可直接用 config 与 core）
```

## 规则

### L1 依赖方向
**规则**：只允许 `app→features/service/config/core`、`features→service/config/core`、`service→config/core`、`config→core`、`core→core`。禁止任何反向或跨层跳跃。
**判定**：
```bash
grep -rn "from '@/app" src/features src/service src/config src/core       # 必须为空
grep -rn "from '@/features" src/service src/config src/core               # 必须为空
grep -rn "from '@/service" src/config src/core                            # 必须为空
grep -rn "from '@/config" src/core                                        # 必须为空
```
**反例**：❌ `core/` 里 import `@/config/archive`——依赖业务配置的代码不属于 core；❌ `service/` 里 import `@/features`——服务客户端不感知 UI。

### L2 core 纯净
**规则**：core 内代码不得引用业务域名词（archive）于类型、默认值或 key 中。core 的判定标准：**换一个业务项目可原样搬走**（almightydb 属 core 自身设施，不构成业务耦合）。
**判定**：`grep -rni 'archive' src/core` 输出为空（模板品牌资产 `hatch-logo` / `HATCH_PALETTE` 属 core 既有件，不计）。
**正例**：✅ `createConfigStore(name, defaults)` 对 name 一无所知
**反例**：❌ core 里写死 `'archive.config'`

### L3 入口收口
**规则**：跨模块 import 只能指向目录入口 `@/core/<capability>`、`@/config/<domain>`、`@/features/<domain>`（后者经由其 `index.ts` 导出的公共 API）；禁止深挖到目录内具体文件。
**判定**：
```bash
grep -rnE "from '@/core/[a-z-]+/" src      # 必须为空（带尾斜杠=深路径）
grep -rnE "from '@/config/[a-z-]+/" src    # 必须为空
```
**正例**：✅ `import { createConfigStore } from '@/core/config-store'`
**反例**：❌ `import { createConfigStore } from '@/core/config-store/create-config-store'`

### L4 路径写法
**规则**：跨目录 import 一律 `@/` 别名；模块**内部**（同目录及其子目录）用 `./`、`../` 相对路径；禁止出现向上跨出本模块的 `../`。
**判定**：`grep -rnE "from '\.\./" src/app src/config` 为空；core 与 features 各模块内 `../` 不得越过自身模块根（人工 review 按此判）。
**说明**：`src/app/_layout.tsx` 的 `import '../global.css'` 是 R7 豁免。

### L5 禁止循环依赖
**规则**：任何模块间不允许环（含经 index.ts 间接成环）。
**判定**：新增依赖时沿 import 链检查；发现环 = 设计错误，回决策树重新落位，而不是"改成懒加载绕过去"。

### L6 分层之外的边界提醒

与 layering 配套的两条硬边界（出处 glossary §2，此处给判定）：

- **文件不进键值存储**：`grep -rn 'base64' src/config src/core/config-store` 为空；二进制文件走 file-storage、结构化数据走 data-store、缓存走 cache-store（形态判定见 glossary §2），config-store 只收标量键值。
- **凭据必须走加密存储**：config 字段名含 `key/token/secret/password` 的，其存储实现必须是 SecureStore。当前 `zookeeperKey`/`gatewayKey` 为明文 AsyncStorage，属**已登记偏差**（见 AGENTS.md），迁移前不得新增明文凭据字段。
