# 工程规范（Standards）

本目录是 mobile 仓库全部工程规范的**唯一**权威来源。`AGENTS.md`（仓库根）是本目录的最小强制集摘要；两者冲突时**以本目录为准**，并须立即修复 AGENTS.md。

## 阅读顺序

| 文档 | 内容 | 什么时候读 |
|---|---|---|
| [glossary.md](glossary.md) | 术语唯一含义、业务域、数据形态、基础设施登记表 | **每次开工前**；所有歧义的最终裁决处 |
| [directory-structure.md](directory-structure.md) | 目录职责、目录化规则 R1–R8、新文件落位决策树 | 新建任何文件/目录前 |
| [naming.md](naming.md) | 目录/文件/标识符/存储 key/环境变量命名 | 新建任何文件/目录/标识符前 |
| [layering.md](layering.md) | 五层依赖方向、core 纯净、import 收口、循环禁止 | 写任何 import 前 |
| [error-handling.md](error-handling.md) | 错误契约：code 命名空间、retryable、禁静默吞错 | 写任何 throw/catch 前 |

## 规则书写约定（元规范）

为杜绝"同一句话 agent A 理解为 X、agent B 理解为 Y"，本目录所有规则一律采用四段式：

1. **规则**：一句话，含 MUST/禁止，无形容词；
2. **判定**：可机械执行的检查（命令、正则、完整枚举的对照表），执行结果唯一；
3. **正例 / 反例**：✅/❌ 各至少一条，反例注明为什么错。

写不出"判定"一栏的规则不许入库——那是还没想清楚，先讨论。

## 变更流程

1. 规范未覆盖的新情况：**先**在本目录增补规则（含判定与正反例），**再**写代码。禁止先写代码事后补规范，更禁止"这次先特殊处理"。
2. 规范与代码冲突：以规范为准修代码；若规范本身不合理，先修订规范（同一次提交内完成），保持两者永不处于矛盾状态。
3. 新增 core 能力、新增业务域、新增 assets 种类、新增顶层目录、新增豁免：各自的上游文档（glossary / directory-structure）必须同步登记。
4. 规范变更随代码一起走 git，提交信息带 `standards:` 前缀。

## 一致性自检（提交前跑一遍）

```bash
cd /workspace/archive

# 目录化 / 无占位 / 无禁用名 / logic 纯度
find src/config src/core -maxdepth 1 -name '*.ts' -type f 2>/dev/null                               # 空
find src/service src/features -maxdepth 1 -name '*.ts' -type f 2>/dev/null | grep -v '/index.ts'    # 空
find . -name '.gitkeep' -not -path './.git/*' -not -path '*/node_modules/*'                         # 空
find src -type d -empty -not -path '*/node_modules/*'                                               # 空
grep -rlnE "from '(react|react-native)" src/features --include='*-logic.ts' 2>/dev/null             # 空

# 分层方向
grep -rn "from '@/app" src/features src/service src/config src/core                     # 空
grep -rn "from '@/features" src/service src/config src/core                             # 空
grep -rn "from '@/service" src/config src/core                                          # 空
grep -rn "from '@/config" src/core                                                      # 空

# 入口收口
grep -rnE "from '@/core/[a-z-]+/" src                                    # 空
grep -rnE "from '@/config/[a-z-]+/" src                                  # 空

# 类型检查
cd src && pnpm typecheck                                                 # 通过
```

任何一条不为空：按规范修复，而不是修改判定命令。
