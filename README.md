# FASTQ 双端滑窗质量裁剪后端

这是一个只包含后端的 Windows 本地工具，使用 TypeScript、Node.js 与内置 `node:sqlite` 实现。支持 API 和 CLI，不依赖 Docker、WSL、外部在线 API 或付费服务。

## 功能范围

- 仅处理固定四行 FASTQ：`@头`、单行序列、`+` 描述行、单行质量。
- 仅接受 LF 或 CRLF；最后一个换行可省略；不支持折行序列或空白记录。
- 序列必须是非空大写 `ACGTN`。
- 质量编码固定 Phred+33，字符 ASCII 33–74，分数 0–41；不自动猜测编码。
- 不做组装、比对、接头识别、反向互补或真实样本推断。
- R1/R2 严格按第 `i` 条同步配对，不搜索同名读段，不把错位后的相邻记录重新配对。

## 配对键规则

- 第一条记录头以 `@` 开头，取其后第一个非空 token 为名称，其余描述原样保留。
- 名称以 `/1` 结尾时只能出现在 R1，以 `/2` 结尾时只能出现在 R2。
- 去掉 `/1` 或 `/2` 后得到配对键；没有方向后缀时，完整 token 即配对键。
- R1/R2 第 `i` 条的配对键必须相同。
- 同一导入批次中配对键必须唯一。
- 数量不等、顺序错位、重复键或任一侧末条截断都会令整次导入失败并回滚。

## 裁剪规则

参数：

- `windowSize` / `W`：正整数窗口长度。
- `qualityThreshold` / `T`：0–41 的整数平均质量门槛。
- `minLength` / `L`：最短保留长度，正整数。
- `maxNRatio`：保留段允许的最大 `N` 比例，范围 0–1，等于上限通过。

处理每条记录时：

1. 将质量字符解码为 ASCII 减 33。
2. 从左到右检查每个完整长度为 `W` 的窗口。
3. 第一次出现窗口质量和严格小于 `W*T` 时，在该窗口起点之前截断；等于门槛通过。
4. 未发现失败窗口则保留整条；原长短于 `W` 时不执行质量窗口截断。
5. 序列和质量使用同一半开区间 `[0, cutPosition)` 裁剪。
6. 保留段长度小于 `L`，或 `N` 数量除以保留长度大于上限，则该侧失败；空段必定失败。
7. 不在截断后继续寻找更长片段，也不只删除低质量窗口本身。

演示参数 `W=3, T=20, L=3`：

- 质量 `III!!!` 解码为 `[40,40,40,0,0,0]`。
- 第一失败窗口起点是零基位置 2，质量和 0 小于 60。
- 只保留前 2 个碱基，因短于 `L=3` 失败。
- 配对另一侧 `IIIIII` 无失败窗口，保留 6 个碱基；在 `keep_singletons` 下进入 R2 singleton。

## 配对去向

- 两侧均通过：`paired`。
- 两侧均失败：整对丢弃。
- 仅一侧通过：
  - `discard_pair`：整对丢弃。
  - `keep_singletons`：通过侧进入 `singleton_R1` 或 `singleton_R2`。

输出保持源记录顺序。`paired_R1` 与 `paired_R2` 数量相同且逐项配对键一致；所有输出序列/质量等长，并且一定是原文前缀。

## 环境要求

- Windows PowerShell。
- Node.js 25 或更高版本（使用内置 SQLite）。
- npm。

## 安装与构建

```powershell
npm install
npm run build
```

## 运行测试

```powershell
npm test
```

测试覆盖 CRLF、质量行中的 `@`/`+`、错误加号描述、方向后缀颠倒、数量不等、重复键、零位截断、无失败窗口、两种孤儿策略、独立逐窗基准、事务回滚和重复导出字节一致性。

## 启动 API

默认使用 `PORT=0`，操作系统自动选择空闲端口：

```powershell
npm start
```

显式指定端口：

```powershell
$env:PORT="8080"
npm start
```

SQLite 数据库默认在 `data/app.sqlite`，可用 `DATABASE_PATH` 修改。

### API

健康检查：

```http
GET /health
```

预览结构错误（不入库）：

```http
POST /preview
Content-Type: application/json

{
  "r1Path": "data/demo/R1.fastq",
  "r2Path": "data/demo/R2.fastq"
}
```

也可以直接传文本：

```json
{"r1Text":"@a/1\nACGT\n+\nIIII\n","r2Text":"@a/2\nACGT\n+\nIIII\n"}
```

提交冻结导入：

```http
POST /batches
```

提交处理（相同输入、参数和策略幂等）：

```http
POST /batches/{batchId}/runs
Content-Type: application/json

{
  "strategy": "keep_singletons",
  "params": {"windowSize":3,"qualityThreshold":20,"minLength":3,"maxNRatio":0.1}
}
```

查询一对原文、截断位置、证据和去向：

```http
GET /runs/{runId}/pairs/a
GET /runs/{runId}/pairs?ordinal=1
```

导出五类文件：

```http
POST /runs/{runId}/export
```

导出文件为：

- `{runId}_paired_R1.fastq`
- `{runId}_paired_R2.fastq`
- `{runId}_singleton_R1.fastq`
- `{runId}_singleton_R2.fastq`
- `{runId}_stats.json`

## CLI

预览：

```powershell
node dist/src/cli.js preview --r1 data/demo/R1.fastq --r2 data/demo/R2.fastq
```

也可用 `--r1-text`、`--r2-text` 直接提交 FASTQ 文本；`import` 子命令同样支持。

导入：

```powershell
node dist/src/cli.js import --r1 data/demo/R1.fastq --r2 data/demo/R2.fastq
```

若要直接读取 `npm run demo` 创建的数据库，请在下列命令中追加 `--db data/demo/app.sqlite`；不加时使用默认的 `data/app.sqlite`。

运行：

```powershell
node dist/src/cli.js run --db data/demo/app.sqlite --batch 7045463423f34ecc --strategy keep_singletons --params '{"windowSize":3,"qualityThreshold":20,"minLength":3,"maxNRatio":0.5}'
```

查询：

```powershell
node dist/src/cli.js pair --db data/demo/app.sqlite --run 1 --ordinal 1
node dist/src/cli.js pair --db data/demo/app.sqlite --run 1 --key demo
```

导出：

```powershell
node dist/src/cli.js export --db data/demo/app.sqlite --run 1 --out data/demo/exports
```

## 一键演示

```powershell
npm run demo
```

演示会在 `data/demo` 生成 R1/R2、SQLite 数据库和导出文件，展示：

- `III!!!` 对 `IIIIII` 的 R2 单端保留。
- 平均质量和等于阈值时通过。
- 短于一个窗口仍按 `L` 判断。
- `N` 比例恰好等于上限时通过。
- 同一冻结批次分别运行 `keep_singletons` 与 `discard_pair`。

## 限制与错误码

默认处理上限：

- 总字节：512 MiB。
- 单文件记录数：20,000,000。
- 单行长度：1,000,000。

超限会明确拒绝，不会覆盖已有成功导出。当前实现会将文本读入内存，适合本地中等规模 FASTQ；SQLite 中的输入版本、参数、截断位置、失败原因、统计和导出清单用于重启后复现。

常见错误码包括：

- `FASTQ_VALIDATION_FAILED`：结构、质量字符或配对规则失败。
- `TRUNCATED_RECORD`：末条四行记录不完整。
- `INVALID_PLUS_LINE`：第三行描述不合法。
- `ORIENTATION_MISMATCH`：`/1`、`/2` 与文件方向不符。
- `PAIR_COUNT_MISMATCH`：双端记录数不等。
- `PAIR_ORDER_MISMATCH`：同位记录配对键不同。
- `DUPLICATE_PAIR_KEY`：批内配对键重复。
- `INVALID_WINDOW_SIZE`、`INVALID_QUALITY_THRESHOLD`、`INVALID_MIN_LENGTH`、`INVALID_MAX_N_RATIO`：参数非法。
- `EXPORT_MANIFEST_CONFLICT`：已登记的成功导出丢失或被修改。

## 数据目录

项目内使用 `data/`：

- `data/app.sqlite`：默认数据库及 WAL 文件。
- `data/exports/`：默认导出目录。
- `data/demo/`：演示输入、数据库和输出。
