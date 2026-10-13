# Linden Asset Management 多用户只读 API

Base URL 为本地 `http://localhost:3000` 或部署域名。所有账户接口必须使用用户会话 Cookie，金额为十进制字符串，时间戳为毫秒，响应 `Cache-Control: private, no-store`。

## 登录与持久会话

`POST /api/session` 接收 `{ "username": "xiaowang", "password": "..." }`，必须携带与服务地址相同的 `Origin`。响应设置一年有效期的 `slzb_session` HttpOnly / SameSite=Strict Cookie，生产环境带 Secure。

所有成功认证的账户请求在 Cookie 已使用一天后自动续期。会话绑定用户名、密码哈希、分配的账户 ID、role 和 sessionVersion；用户被移除、停用，账户被停用，密码、角色、绑定、版本或签名密钥改变后，旧 Cookie 失效。退出接口清除当前浏览器 Cookie；管理员撤销登录可以使此前签发的 Cookie 在所有设备失效。

**每次请求只访问服务端绑定的账户。没有客户端 accountId 切换功能，也没有全局 MONITOR_API_TOKEN。** 添加 `accountId`、自定义 Header 或别人的交易对不能扩大访问权限。默认 Demo 也需要用户名及密码登录。

## 接口

| 方法   | 路径                                             | 作用                                           |
| ------ | ------------------------------------------------ | ---------------------------------------------- |
| GET    | `/api/health`                                    | 公共存活探针，不检查交易所                     |
| GET    | `/api/session`                                   | 当前用户名、显示名称、账户名称；未登录返回 401 |
| POST   | `/api/session`                                   | 用户名 + 密码登录                              |
| DELETE | `/api/session`                                   | 退出当前浏览器                                 |
| GET    | `/api/dashboard`                                 | 当前用户绑定账户的聚合视图                     |
| GET    | `/api/holdings`                                  | 当前账户持仓                                   |
| GET    | `/api/pnl`                                       | 当前账户估值、成交盈亏、持仓浮盈及本金         |
| GET    | `/api/trades`                                    | 已同步成交中最近 1,000 笔                      |
| GET    | `/api/trades?symbol=BTCUSDT&fromId=0&limit=1000` | 当前账户单交易对向后分页                       |
| GET    | `/api/orders`                                    | 当前账户全 Spot 钱包当前挂单                   |
| GET    | `/api/history`                                   | 当前账户近 90 天每小时末净值点                 |
| GET    | `/api/connection`                                | 当前账户来源及覆盖状态，不含密钥或其他用户     |
| POST   | `/api/sync`                                      | 当前账户同步并尝试保存快照                     |
| GET    | `/api/cron`                                      | 管理员 Cron Bearer 鉴权，采集所有启用真实账户  |

除健康检查、登录和独立 Cron 外，全部接口都验证用户 Cookie。POST/DELETE 必须携带同源 Origin；没有通过网页更改用户、角色、密码、绑定或 API 密钥的接口；管理员可以选择并修改任何启用账户的成本。

聚合 `/api/dashboard` 和 `/api/sync` 直接返回 Dashboard。其他账户数据端点通常返回 `{ data, updatedAt, warnings }`。会话成功返回 `{ authenticated: true, demo, user: { username, displayName, role }, accountLabel }`。只有未配置自建用户的内置 Demo 才返回 `demo: true` 以显示演示登录提示。

## 合约聚合

真实账户自动读取 USDT 保证金合约。`summary.equity` 为现货权益加 `summary.futuresEquity`（合约 USDT marginBalance）。合约权益已含浮盈和已入账费用，不再加划转值、名义仓位或盈亏；合约权益为 null 时总额为现货小计且 `equityComplete=false`。流水缺失不影响已成功读取的官方权益。

合约持仓返回 `instrument=futures`、`symbol`、`direction`、交易所开仓 `averageCost`、标记价格 `price`、未实现盈亏加已知资金费的 `unrealizedPnl`。`pnlComplete=false` 表示资金费尚未完整同步，仍显示已知浮盈；`summary.holdingPnlComplete` 为聚合对应标志。合约成本不在手工成本管理范围。已移除 `/api/futures` 手填划转接口。

`/api/trades` 默认混合现货和合约；`market=spot|futures` 可筛选最近 1,000 笔中的市场。指定 symbol 时默认现货，用 `/api/trades?market=futures&symbol=PONSUSDT&fromId=0&limit=1000` 查询合约逐笔分页。合约记录有 `instrument=futures` 和 `realizedPnl`（该笔交易所平仓收益，不含 fee）；唯一键需含市场、symbol、id。`connection.futuresTradesComplete` 为已发现合约成交同步状态；合约成交接口最多回溯约三个月，不传 fromId 时读取最近七天。

## 成交分页与完整性

`symbol` 为 5–30 位大写字母/数字，由交易所验证是否存在；查询始终使用当前登录用户绑定账户的密钥，无需配置监控列表。`limit` 为 1–1000，`fromId` 为非负整数 ID；传 limit/fromId 时必须同时传 symbol。

从 `fromId=0` 开始；收到 `nextFromId` 后传入下一次请求，直到 null。不传 fromId 时是交易所最近成交；之后的 nextFromId 只能读取更新的成交，不能用于倒序翻旧记录。

```json
{
  "data": [
    {
      "id": "12345",
      "symbol": "BTCUSDT",
      "side": "BUY",
      "price": "60000",
      "quantity": "0.1",
      "quoteQuantity": "6000",
      "fee": "0.00015",
      "feeAsset": "BNB",
      "time": 1767225600000,
      "isMaker": true
    }
  ],
  "nextFromId": null,
  "coverage": "未传 fromId 时返回最近成交；fromId=0 可从最早可用成交向后分页。"
}
```

`connection.tradesComplete` 表示当前已发现交易对都完成首次分页回溯，且本轮无成交查询失败；不是所有历史操作均已覆盖的保证。`connection.historySync` 返回 `{ scanned, total, oldestCheck }`，时间为毫秒或 null；`connection.symbols` 为已发现有成交的交易对。不同交易对轮转增量查询，最早检查时间表达查询范围的时效性。`ordersComplete=false` 时空列表不是“没有挂单”。

`summary` 新增 `realizedPnl`、`principal`（可为 null），`cash`、`cashFree`、`cashLocked`（十进制字符串，USDT）。`cash` 包含冻结 USDT，不含其他稳定币。`equity` 优先使用 Binance 钱包接口（`quoteAsset=USDT`）返回的 Spot `balance` 加合约权益；现货接口失败或测试网才本地估算现货部分；`equitySource` 为 `exchange` / `calculated`，`equityComplete` 表示总额是否完整。官方估值不依赖本地逐币行情完整性，实时与 Cron 快照都使用同一规则。`unrealizedPnl` 仅汇总非稳定币；其成本或行情缺失时为 null，稳定币持仓浮盈为 null。金额 null 表示未知；持仓表成本完全由管理员输入。持仓浮盈亏立即按管理员成本计算，不等待历史扫描。已实现盈亏按成交记录移动加权平均匹配历史买入；买卖手续费发生时立即扣除，后续卖出不再重复计入已扣费用。第三币手续费按成交分钟历史收盘价近似折算，汇率随账本持久化。`feePnl` 为已读取成交手续费折算 USDT 后的负值；`realizedPnlComplete` 表示首次回溯是否完成且已读取成交能完整核算。同步中可返回暂计 `realizedPnl`，须结合该标志和 `realizedPnlNote` 展示。历史买入不足、缺手续费汇率、存在非 USDT 成交或扫描中尚无成交时为 null。仅买入未卖出时已实现盈亏等于负的买入手续费。下架未发现交易对、闪兑和资金流水不在范围内。

## 管理员成本接口

- `GET /api/costs`：仅 `role=admin`，返回选定账户 `{ costs, revision, updatedAt, updatedBy, writable }`。普通用户返回 403。
- `PUT /api/costs`：需要同源 Origin 和管理员会话。正文 `{ "revision": null, "costs": { "BTC": "58000", "BNB": "500" } }`。首次 revision 为 null，后续提交 GET 获得的 UUID。完整替换成本记录；移除币种代表未设置，显式 `"0"` 表示零成本。USDT 只能为 1 或省略。限 500 个币，金额最多 20 位整数及 16 位小数，不能负数。
- 管理员通过 URL 的 accountId 选择任一启用账户，不传则使用默认账户。无效/停用账户返回 404，绝不回退写入其他账户。普通用户不能调用成本管理接口，正文额外字段被拒绝。冲突 409；Vercel 未配置 DATABASE_URL 时写入 503；保存成功只返回成本元数据，不暴露密钥或配置文件。审计存储于服务端。
- 修改只重算未实现盈亏，不改变已实现盈亏；手工成本不会被新成交自动调整。新成本每次聚合请求从持久存储读取，不受交易所 30 秒缓存影响。

`totalPnl/baseline/baselineAt/netFlows/stablecoinValue` 保留兼容旧客户端；界面不再把 totalPnl 当作已实现盈亏。新配置不需要旧 performance 字段。`tradeCount` 是全部已同步成交数，列表最多返回 1,000 笔；单交易对 API 可继续分页。

## Cron

需 `Authorization: Bearer <CRON_SECRET>`；用户 Cookie 无法调用。可用 `?accountId=friend-a` 单独采集一个账户（仅限管理员密钥）。余额/行情读取两路并发，使用共同 45 秒预算，不下载成交。响应包含 `{ ok, results: [{ accountId, saved }] }`；任一账户失败返回 503。无可采集账户返回 404。

## 错误与缓存

格式为 `{ "error": { "code": "UNAUTHORIZED", "message": "请登录你的查看账号。" } }`。

400 参数无效，401 未登录或账号密码错误，403 来源校验失败，404 资源不存在，429 请求限流，502 交易所异常，503 服务配置或采集失败。密码错误、用户不存在、停用时都返回相同登录错误，避免泄露用户存在性。

同一账户的聚合查询在同一实例合并并缓存 30 秒，不同账户独立。服务器每次都先验证会话及最新账户绑定，再访问缓存。实例间没有共享缓存，账户之间绝不共享客户端数据。单交易对分页不缓存。没有认证信息、配置文件内容、密码哈希或交易所密钥的读写接口。

## 管理员账户切换

GET/POST `/api/session` 均返回默认 `accountId`。管理员额外获得 `accounts: [{ id, label, viewers }]`（仅启用账户，viewers 是查看用户显示名），无密钥；普通用户不返回该列表。管理员可在 `/api/dashboard`、`/api/sync`、各账户数据端点及 `/api/costs` 加 `?accountId=...`。会话保持管理员身份，审计仍记录真实修改人。管理员默认账户被停用时，默认打开第一个启用账户。

前端切换会清空旧持仓并丢弃旧请求响应，成本编辑器随账户重新创建。存在未保存成本或正在保存时禁止切换，保存或重新加载后恢复。

## 管理目录（固定管理员模式）

`GET /api/admin` 返回脱敏账户列表、查看用户、固定管理员标识、revision 和最近 100 条操作记录。不会返回 API Key/Secret、密码或密码哈希。

`POST /api/admin` 要求固定管理员 Cookie、同源 Origin 和最新 revision。JSON 使用以下 action：

- `createAccount` / `updateAccount`：`account` 包含 id、label、source（binance/demo）、environment（mainnet/testnet）、enabled、principal（非负金额字符串或 null）；apiKey/apiSecret 可省略，修改时均留空保留原值，替换需成对填写。
- `createUser` / `updateUser`：`user` 包含 username、displayName、accountId、enabled；新用户必填 password（8–256 位），修改时省略则保留。role/passwordHash 等额外字段拒绝。
- `revokeSessions` / `deleteUser`：username。

所有写操作返回更新后的同一脱敏结构。初始 revision 为 null，后续为 UUID。401 未登录，403 非管理员/固定身份不可修改，400 格式错误，409 版本冲突，503 未配置持久存储或初始化条件不足。普通用户即使自行调用这些接口也不能读取或修改管理数据。
