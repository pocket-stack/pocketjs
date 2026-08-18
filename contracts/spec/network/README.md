# PocketJS private network ABI v1

本目录固定 `pocketjs:internal/network-v1` 的 Guest ↔ native 边界。它不是公共 package export，也不授予网络权限。**native Protocol Core 对每条 command 继续执行已验证的 Build Plan、ResolvedNetworkPolicy 和资源上限。**

## 生成边界

[`definition.ts`](./definition.ts) 是 numeric ABI 的单一数据源。它生成：

- [`generated/network-v1.ts`](./generated/network-v1.ts)：Guest Binding 使用的 TypeScript 常量；
- [`generated/pocketjs_network_v1_abi.h`](./generated/pocketjs_network_v1_abi.h)：native adapter 使用的 C 常量和固定宽度 identity/turn 结构。

command opcode、event code、feature id 和错误码在同一个 ABI major 内只允许追加，不能重排、删除或复用。增加 identifier 时同时增加 ABI minor。ABI major 必须精确相等；native minor 可以高于 Guest 要求的 minor，但不能向旧 Guest 投递它不认识的 code。

```sh
bun contracts/spec/network/generate.ts
bun contracts/spec/network/generate.ts --check
bun test contracts/spec/network/network-v1.test.ts
```

测试会从 `definition.ts` 在内存中重新生成两个产物并逐字节比较，同时用 C11 `-Wall -Wextra -Werror` 编译 native header。

## Mount handshake

bundle factory 捕获冻结的 `NetworkV1BindingTable` 后，在任何应用 initializer、callback 或应用可触发的 microtask 之前执行 handshake。handshake 固定包含：

- ABI major/minor；
- 非零 `runtimeGeneration`；
- 已验证 ResolvedBuildPlan `planHash` 的 32-byte SHA-256 digest；
- Build Plan 中值为 `true` 的 `network.*` feature 的严格递增 numeric id 列表。

**plan hash、runtime generation 和 feature id 列表必须精确一致。** feature 列表不能包含 native descriptor 能实现但 Build Plan 没有授予的能力。未知、重复或乱序 feature id 都会在应用入口执行前拒绝 mount。

v1.0 的 handshake 和六个 binding method 必须保留为 table 自身的冻结 data property；v1.1 追加同样为 own data property 的 `getLimits()`。新 Guest 要求 native minor 至少为 1，更高 ABI minor 可以继续追加 property，但不能替换或删除已有 property。table、handshake、limits snapshot 与它们的嵌套数组不能使用 accessor 在验证前后返回不同值。

当前 stock target registry 仍不声明网络 capability；本 ABI 的存在不会打开 `network.http.client` 或 TLS。

## ABI 1.1 limits snapshot

`getLimits({ runtimeGeneration, protocol, role })` 是 owner thread 上的同步只读查询。protocol/role 的 `0` 表示 build-wide 维度；其他值使用生成文件中的固定 numeric id。它不执行运行期协商，也不能增加 Build Plan 权限。

Host 返回冻结且 accessor-free 的 snapshot：

- runtime generation 与 protocol/role 必须精确回显 query；
- `values` 最多 64 项，按 bounded dotted ASCII name 严格排序且不重复；
- 每项满足 `0 <= minimum <= default <= hard <= Number.MAX_SAFE_INTEGER`，其中零 minimum 表示 manifest 没有抬高该项的 admitted floor；
- `featureIds` 是 mount handshake 对当前 protocol/role 的精确有序子集，不能加入 descriptor 支持但 Build Plan 未授予的 feature；
- Guest Binding 在返回公共 `NetworkLimits` 前复制并深度冻结 snapshot，应用不能修改 Host table 或用查询扩大单次 operation limit。

## Identity 与顺序

每条 command 和 completion 都携带：

- `runtimeGeneration`；
- resource、operation 和 body 的 `(id, generation)` handle；
- 当前 runtime generation 内单调递增、范围为 `1..Number.MAX_SAFE_INTEGER` 的 sequence。

`(0, 0)` 是 absent handle；一个字段为零而另一个非零是 ABI 错误。generation 或 runtime 不匹配的 completion 只能执行 native cleanup，不能更新 Guest 对象或完成 Promise。completion sequence 必须严格递增。

generation 达到 `UINT32_MAX`、sequence 达到 `Number.MAX_SAFE_INTEGER` 后不允许回绕；需要复用槽或继续分配时以 `resource_limit`/runtime teardown 失败关闭。

## Command、completion 与 body credit

command 通过 owner thread 上的同步 `dispatch()` 进入 native adapter。`HttpRequestStart` 的 URL、method、header、timeout、TLS 和 limit metadata 已由 Guest Binding 规范化；这些 metadata string/list 与显式 borrowed buffer 都只在该同步调用期间有效，adapter 必须在返回前完成校验和必要的 native snapshot。native Core 仍重新执行权限、feature 和 hard-limit 检查。

v1 固定以下双向 body 信号：

| 信号 | Guest → Core | Core → Guest |
|---|---|---|
| `BODY_PULL(maxBytes)` | 为 response body 授予一个 chunk credit | 请求 Guest request-body producer 产出一个 chunk |
| `BODY_CHUNK` | 同步借用 Guest input，adapter 返回前复制到 native lease | 携带可领取的 native BufferLease descriptor |
| `BODY_END` | request body 正常结束 | response body 正常结束 |
| `BODY_ERROR` | Guest producer 失败 | native producer/协议失败 |
| `BODY_CANCEL` | Guest 不再读取 response body | Core 不再读取 request body |

**每个 body 同时最多存在一个 credit。** `BODY_CHUNK.byteLength` 必须为正且不超过对应 credit；`END`、`ERROR` 和 `CANCEL` 都进入同一个 terminal 状态，此后不能再接收 body 信号。

## BufferLease

native completion 只携带 BufferLease `(id, generation)` 与 byte length，不把 payload 放进 completion descriptor。owner thread 使用以下同步顺序：

1. `BUFFER_LEASE_TAKE` 把 lease 从 `Queued` 转为 `Taken`；
2. 一个或多个 `BUFFER_LEASE_READ_INTO` 把 lease 区间复制到调用方提供的精确 `Uint8Array` window；
3. `BUFFER_LEASE_RELEASE` 把 lease 从 `Taken` 转为 `Released`。

stale generation、取消或 teardown 可以在 Guest take 前执行 `Queued → Released` cleanup。其他 transition，包括重复 take、重复 release 和 take 后 native cleanup，都是 ABI 错误。**borrowed input/output 只在同步 adapter 调用期间有效，不能被 worker、Core 或 completion 保存。**

## NetworkServiceTurn

mount 通过 `registerServiceDispatcher()` 注册一次私有 dispatcher。Host 只在同一个 QuickJS owner thread 上调用它，并为每次调用提供非零 `turnId`、runtime generation、turn kind、event budget 和 payload-byte budget。

dispatcher 只能在该调用内使用 `nextCompletion({ runtimeGeneration, maxPayloadBytes })` 投递已经由 Core 按 sequence 排序的 completion。每次调用传入本 turn 剩余 byte credit；native 返回 `Item`、`Drained` 或 `BudgetExhausted`。下一个 completion 的完整 payload 放不进剩余 credit 时，native 不 dequeue 它并返回 `BudgetExhausted`；零 credit 可以作为不消费 queue 的 ready probe。

dispatcher 结果报告已投递 event 数、已选择 event 所引用的 payload 总 byte length、最后 sequence，以及 `Drained` 或 `MoreReady`。payload byte 在选择 `BODY_CHUNK` completion 时按整个 lease length 计入预算，不依赖应用随后是否或何时 `readInto`。计数不能超过请求预算；没有投递 event 时 bytes 和 last sequence 都必须为零。`MoreReady` 要求 Host 保持 network-ready 并安排后续 NetworkServiceTurn，不等待 UI frame。

completion delivery 之后的 Promise/job/reactive quiescence 与 non-presenting commit 仍由 Host/framework logical-turn 实现负责；dispatcher 不推进 UI virtual time，也不 present。
