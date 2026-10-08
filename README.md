# FASTQ 双端滑窗质量裁剪与配对去向核验后端

Windows 本地可运行的双端 FASTQ 质量裁剪服务，**只提供 HTTP API 与 CLI**（无前端、无 Docker、无 WSL、无任何在线服务）。
使用 **TypeScript + Node.js（内置 `node:sqlite`）**，零原生依赖、免编译原生模块。

## 功能范围与明确限制

- 仅接受**固定四行 FASTQ**：`@标题` / 序列 / `+...` / 质量串，每条恰好四行。
- 仅支持 **Phred+33** 质量编码，质量字符固定 ASCII **33..74**（解码为 0..41）；**不做**质量编码自动猜测。
- 支持 **LF 与 CRLF**，文件最后一个换行可省略；**不支持**折行序列、空白记录、记录间空行。
- 序列仅允许非空大写 `ACGTN`；质量中的 `@`、`+` 是普通质量字符，不会被当成新记录。
- 第三行必须是单独 `+`，或 `+` 后紧跟与第一行去掉 `@` 后**完全相同**的内容。
- **不做**序列组装、比对、接头识别、反向互补或真实样本分析。

## 配对键规则

- 第一行 `@` 后第一个非空 token 为名称，其余描述原样保存并随输出保留。
- 名称以 `/1`、`/2` 结尾时，后缀必须与所在文件方向一致（R1 文件出现 `/2` 直接报错）。
- 去掉 `/1`、`/2` 后缀后的名称作为配对键；没有后缀则整个 token 作为键。
- R1、R2 第 i 条的配对键必须**相同**且在批内**唯一**，两文件记录数必须相等。
- 顺序错位、重复键、一侧末尾截断都会使**整次导入失败**；系统**不会**向后搜索同名读段补配，也不会在一侧过滤后把下一条与另一侧当前条错配。

## 滑窗裁剪规则

参数：窗口长度 `W`（正整数）、平均质量门槛 `T`（0..41 整数）、最短保留长度 `L`（正整数）、N 碱基比例上限（[0,1]）。

- 对每条原始质量串从左向右扫描所有完整长度为 `W` 的窗口。
- 第一个满足 **质量和 < W × T** 的窗口：在该窗口起点之前截断（`cut = 窗口零基起点`，保留前缀）。
- 质量和 **等于** `W × T` 的窗口**通过**（判定是严格小于）。
- 没有失败窗口则保留整条；原长小于 `W` 时不滑窗、整条进入后续过滤。
- 只保留第一个失败窗口之前的前缀，**不**只挖掉低质窗口，**不**在截断后继续寻找更长片段。
- 截断后再检查：长度 ≥ `L`（空段 `cut=0` 必失败，因 L 为正整数）；保留段 `N 数量 / 保留长度 ≤ 上限`（恰好等于上限通过）。
- 序列与质量按同一个半开区间 `[0, cut)` 一起裁剪；原始记录与窗口触发证据（起点、窗口和、失败原因）全部保留。

## 配对去向

- 两侧都通过 → `paired`（paired_R1 / paired_R2 逐条配对键一致、数量相等）。
- 只有一侧通过：
  - `discard_pair`：整对丢弃；
  - `keep_singletons`：通过的一侧写入对应的 `singleton_R1` / `singleton_R2`。
- 两侧都失败 → 整对丢弃。
- 两种策略可在同一冻结输入（同一批次）上分别运行；绝不为配对输出填造空序列。
- 全部输出保持**源记录顺序**，且满足守恒：输入配对数 = paired + singleton_R1 + singleton_R2 + dropped。

## 持久化与一致性

SQLite 数据库（默认 `./data/fastq.sqlite`）保存：

- 冻结输入版本（批次、记录数、R1/R2 内容 SHA-256、完整原文）；
- 每次运行的参数、孤儿策略与各类别计数；
- 每对的截断位置 `cut1/cut2`、第一失败窗口起点与质量和、失败原因、最终去向；
- 导出清单（文件路径、字节数、SHA-256、导出时间）。

失败导入在一个事务内整体回滚；相同内容导入、相同参数重复提交均**幂等**（返回既有批次/运行）；重启后仍可导出完全相同的结果（导出 FASTQ 与 stats JSON 的字节内容稳定，重复导出 SHA-256 一致）。

处理上限（可用环境变量覆盖，超限明确拒绝且不覆盖已有成功导出）：

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `FASTQ_MAX_BYTES` | 52428800（50 MiB） | 单文件最大字节数 |
| `FASTQ_MAX_LINE_LENGTH` | 1000000 | 单行最大字符数 |
| `FASTQ_MAX_RECORDS` | 2000000 | 单文件最大记录数 |
| `FASTQ_MAX_BODY` | 104857600（100 MiB） | HTTP 请求体最大字节数 |

## 环境要求

- Node.js **>= 22.5**（开发与实测版本为 Node v25.5.0，用到内置 `node:sqlite`；运行时会有一条 SQLite 实验性警告，不影响功能）。
- Windows 本地直接运行；不依赖 Docker、WSL、付费服务或外部在线 API。

## 构建、测试、启动、演示

```powershell
npm install
npm run build      # TypeScript 编译到 dist/
npm test           # 编译 + node:test 全量测试（27 个测试）
npm start          # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo       # 生成 demo FASTQ，跑两种策略并导出
```

指定端口或数据目录：

```powershell
$env:PORT="8080"           # 或 node dist/server/index.js --port 8080
$env:FASTQ_DATA_DIR="D:\fastq-data"
npm start
```

## CLI

```powershell
node dist/cli/index.js import  --r1 demo\R1.fastq --r2 demo\R2.fastq
node dist/cli/index.js process --batch 1 --W 3 --T 20 --L 3 --n 0.5 --strategy keep_singletons
node dist/cli/index.js pair    --run 1 --ordinal 1
node dist/cli/index.js pair    --run 1 --key readA
node dist/cli/index.js export  --run 1
node dist/cli/index.js help
```

全部命令可用 `--data-dir <目录>` 或环境变量 `FASTQ_DATA_DIR` 指定数据目录；输出为 JSON。

## HTTP API

所有请求/响应均为 JSON，错误统一形如 `{"error":{"code","message","record","line","column"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/import/preview` | 解析与配对结构预检（不落新数据；错误返回结构错误码与记录/行列） |
| POST | `/api/import` | 原子导入；body：`{"r1":{"content"\|"Path"},"r2":{...}}` |
| POST | `/api/batches/:id/process` | 提交裁剪；body：`{"params":{windowSize,qualityThreshold,minLength,maxNRatio},"orphanStrategy"}` |
| GET | `/api/batches/:id/runs` | 列出批次下的运行 |
| GET | `/api/runs/:id` | 运行统计 |
| GET | `/api/runs/:id/pair?ordinal=1` 或 `?key=readA` | 查询一对原文、裁剪证据与去向 |
| POST | `/api/runs/:id/export` | 导出 4 个 FASTQ + stats.json |
| GET | `/api/runs/:id/exports` | 已导出文件清单 |

`content` 为直接文本，`path` 为本机可访问文件路径（服务端读取项目内文件）。

示例：

```powershell
$body = @'
{"r1":{"content":"@a/1`nACGTNA`n+a/1`nIII!!!`n"},"r2":{"content":"@a/2`nACGTAC`n+a/2`nIIIIII`n"}}
'@
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/import -Body $body -ContentType 'application/json'
```

## 导出产物

位于 `<数据目录>/exports/run-<runId>/`：

- `paired_R1.fastq`、`paired_R2.fastq`：仅两侧均通过的读段，按源顺序、逐项配对。
- `singleton_R1.fastq`、`singleton_R2.fastq`：仅 `keep_singletons` 下有内容。
- `stats.json`：参数、策略、各类别计数、守恒校验结果与配对键列表。

## 错误码

`EMPTY_FILE`、`TRUNCATED_RECORD`、`BAD_HEADER`、`EMPTY_NAME`、`EMPTY_SEQUENCE`、
`BAD_SEQUENCE`、`BAD_PLUS_LINE`、`EMPTY_QUALITY`、`QUALITY_LENGTH_MISMATCH`、
`BAD_QUALITY_CHAR`、`SIDE_SUFFIX_MISMATCH`、`RECORD_COUNT_MISMATCH`、
`PAIR_KEY_MISMATCH`、`DUPLICATE_KEY`、`EMPTY_BATCH`、`FILE_TOO_LARGE`、
`LINE_TOO_LONG`、`TOO_MANY_RECORDS`、`INVALID_PARAMS`、`BATCH_NOT_FOUND`、
`RUN_NOT_FOUND`、`PAIR_NOT_FOUND`、`FILE_NOT_FOUND`、`BAD_JSON`、`BODY_TOO_LARGE`。

## 演示场景（W=3, T=20, L=3, N 上限 0.5）

- R1 `III!!!` = [40,40,40,0,0,0]：第一失败窗口零基起点 2，cut=2，因 2 < L=3 过短失败。
- 配对 R2 `IIIIII`：无失败窗口保留 6 碱基通过；`keep_singletons` 下进入 singleton_R2。
- 质量 [20,20,20,40]：首窗和 60 = W×T，等于门槛通过。
- 长度 2（不足一个窗口）：不滑窗，直接按 L 判断，过短失败。
- cut=2 且保留段为 `AN`：N 比例 0.5 恰好等于上限，通过。

## 合理假设

- 标题描述取第一个 token 之后的原始文本；输出第三行统一写为单独 `+`（标准 FASTQ 合法形式）。
- 输出统一使用 LF 换行；输入接受 LF/CRLF。
- 文本按 UTF-8 读取（FASTQ 标题允许任意文本，序列/质量字符集为 ASCII）。
