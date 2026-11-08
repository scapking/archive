# 错误处理规范（Error Handling）

core 的错误契约：让 features 层**可以编程地判断错误**（凭 code 分支）、**可以区分重试**（凭 retryable）、**永远不会被静默吞掉**。

## R1 错误类型契约

**规则**：core 自有模块抛出的运行时错误必须是对应模块错误类的实例：`CodedError` 子类（expo-modules-core），带稳定 `code` 与 `retryable` 标志。禁止抛裸 `new Error(...)` 表示运行时失败。

**判定**：`grep -rn "throw new Error(" src/core --include='*.ts'` 输出为空（参数校验例外，见 R5）。

**正例**：✅ `throw new FileStorageError('file-storage/not-found', ...)`
**反例**：❌ `throw new Error('文件不存在')`（无法编程分支、无归属能力）

## R2 code 命名空间

**规则**：code 格式 `<capability>/<kind>`（全小写 kebab），全仓库唯一。kind 白名单按能力登记于下表；新增 kind 必须先修订本表。

| 能力 | codes |
|---|---|
| config-store | `config-store/read`、`config-store/write`、`config-store/corrupt` |
| crypto | `crypto/weak-params`、`crypto/invalid-envelope`、`crypto/invalid-key`、`crypto/invalid-base64`（加密层自有 `CryptoError`，2026-11-06 登记各 kind 均为确定性输入/参数错误，**retryable 一律 false**；expo-crypto 直用部分仍透传 expo `CodedError`，见 R4） |
| database | `database/failure`、`database/migration` |
| file-storage | `file-storage/invalid-key`、`file-storage/not-found`、`file-storage/io`（moveFromUri/copyFromUri 的源不存在 → not-found；非 file:// 源回退字节路径后的 IO 失败 → io） |
| video-thumbnails | `video-thumbnails/unavailable`（web / 原生模块缺失，retryable=false）、`video-thumbnails/generation`（解码/帧提取失败；瞬时编码器繁忙可重试，retryable=true） |
| migration | `migration/invalid-bundle`、`migration/not-found`、`migration/io`（zip.ts 的包完整性错误同用 `migration/invalid-bundle`） |
| notifications | `notification/unsupported`、`notification/invalid-token`、`notification/failure` |
| sharing | `sharing/unsupported`、`sharing/io`（仅 web 下载回退路径；native 透传 expo 错误） |
| post（service） | `post/network`（retryable）、`post/http` |
| socket（service） | `socket/closed`、`socket/full` |
| 薄封装模块（camera/location/audio/video/image-picker/image-manipulator/clipboard/linking） | 不自定义错误：透传 expo `CodedError`（code 如 `ERR_UNAVAILABLE`），见 R4（crypto 加密层已移出本行，codes 见上行） |

**判定**：各能力错误类的 `code` 字段逐一对照本表；`grep -rnE "code: '[a-z-]+'" src/core` 或读各 errors.ts 的 type 联合。

## R3 禁止静默吞错

**规则**：每个 `catch` 块必须三选一：① 重抛（可包装为带上下文的类型化错误）；② 经 onError/上报钩子发出信号后按文档化语义降级；③ 留有注释说明为何吞掉是安全的。**空 catch（无 ② 无 ③）禁止。**

**判定**：
```bash
grep -rnE "catch\s*(\([^)]*\))?\s*\{\s*\}" src/core --include='*.ts'    # 空 catch，必须为空
grep -rn "catch" src/core --include='*.ts'                               # 逐一人工核对 ①②③
```
**正例**：✅ config-store 的 `onError(...)` 上报 + 降级（corrupt 凭据按缺失处理）；✅ migration `list()` 跳过损坏包（有注释）
**反例**：❌ `catch {}` 什么都不做

## R4 薄封装不包装

**规则**：薄封装模块（上表第六行）透传底层 expo `CodedError`，不二次包装、不吞错。理由：expo 的 code 已稳定且跨平台一致，二次包装只会丢失信息。

**判定**：薄封装模块内 `catch` 关键字出现次数为 0（有平台兜底分支除外，须登记 platform-parity.md）。

## R5 参数校验用标准异常

**规则**：编程错误（调用方传错参数：key 长度错、密钥长度错、base64 非法）抛 `TypeError` / `RangeError`——这不该被捕获重试，应该在开发期暴露。运行时失败（IO、存储、网络）才走 R1 的 CodedError。

**判定**：错误信息以"调用方参数"为主语的用 TypeError/RangeError；其余用 CodedError。

## R6 retryable 语义

**规则**：包装函数对已知的瞬时故障必须置 `retryable: true`（当前已识别：SQLite busy/locked）。features 层的重试逻辑只信 `error.retryable === true`，禁止按 message 字符串猜测。

**判定**：`grep -rn "retryable" src/core --include='*.ts'`——置位点集中在各 errors.ts 的 toXError。

## 与 zustand persist 的特殊约定

config-store 的存储错误会被 zustand persist 吞掉（框架行为，改不了）。因此：

1. `createConfigStore` 强制提供 `onError` 通道（未提供时自动 `console.warn` 兜底）；
2. 存储实现（secure-storage / wrapPlainStorage）每个操作失败先 `onError(...)` 再重抛；
3. 依赖 config 的模块如果关心"配置是否真的存上了"，必须接 `onError`，不能依赖 try/catch。
