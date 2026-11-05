# 店铺账号重构方案（物理合并版：一张表 / 一个列表 / 一个表单）

> **状态**：✅ **已落地（2026-10-22，P0–P3 全部完成）**；判据逐条核对与「与设计不符之处」见 §7.1
> **日期**：2026-10-22
> **目标**：按「一个店铺只管理一个速卖通账号」重画数据与界面；**消除重复输入**（紫鸟 / ERP 每次重填、手机号与企业重复维护），**不引入多平台、多密码、通用筛选器**这类当前用不上的能力。
> **本轮定性**：开发期以**表结构简单、好维护**为先。店铺与账号**物理合并成一张 `sk_shops`**；数据层面的历史包袱允许在开发完成后人工整理。
> **依据**：真库只读取证（2026-10-22）＋ 代码取证（行号见正文）。
> **前置阅读**：`plans/SHOP_ACCOUNTS_INTAKE_PLAN.md`（岛回收为内建模块的边界）、`plans/DOMAIN_INTEGRATION_PLAN.md`（店铺实体与主数据层）、`decisions/ADR-002-master-data-layer.md`、`decisions/ADR-003-shop-account-physical-merge.md`（本文的架构裁定）。

---

## 0. 结论先行

| 问题 | 结论 |
|---|---|
| 「店铺和店铺账号合并」怎么合 | **物理合并成一张表**：`sk_shops` 同时装店铺身份、账号、企业/工具引用、状态与凭证。店铺与账号不再是一对表，而是**同一行的两种完成度** |
| 两种不完整状态怎么表达 | `name = ''` = 只有账号、还没建店铺；`email = ''` = 只有店铺、账号待补；两者都空拒绝写入（`CHECK`） |
| 为什么现在可以这样 | 真库 16 个账号 / 9 家店：6 家店有账号、10 个账号没店、3 家店没账号；一个账号挂多店 = 0；重复邮箱 = 0；状态无漂移。开发期数据量小、可人工整理 |
| 代价是什么 | 老表的表级 `UNIQUE(platform, name_key)` 必须改成**部分唯一索引**，SQLite 只能重建表；邮件表的外键目标也要从 `sk_shop_sets` 换成 `sk_shops`，同样要重建。**一次性迁移，之后永久简单** |
| 下游 `shop_id` 会断吗 | 不会。9 家店的 id 原样保留（1–9）；10 个纯账号拿新 id（10–19）；`pl_shop_sku` / `pl_shop_items` / `sk_name_map` 对 1–9 的引用不动 |
| 重复输紫鸟 / ERP 怎么解 | 新增**工具账号**表：一个登录一条记录、一份密码；店铺只存 `ziniao_account_id` / `erp_account_id` |
| 手机号 / 支付宝放哪 | 放**企业**：手机号复用 `sk_companies.contact_phone`，新增 `alipay_account`；店铺侧只读展示 |
| 国际支付宝密码放哪 | 放店铺行的加密字段（每店可不同） |
| 平台怎么处理 | 不再有平台选择器；界面固定显示「速卖通」。数据列 `platform` 保留（默认 `ae`），只为兼容历史值与测试夹具 |
| 状态 / 开店时间放哪 | 就在这一行。状态统一为 **`active` / `archived`**（账号侧原来的 `paused / banned / closed` 真库为 0，并入 `archived`，具体原因写备注） |
| 没有企业信息的账号怎么迁移 | **不建企业壳**：`company_id = 0`，旧手机号 / 支付宝写进备注（前缀「迁移遗留：」），由界面维护 |
| 新建默认值 | 企业 / 紫鸟 / ERP 默认带出上一次保存时的选择，可见可改；不自动复制密码 |
| 列表筛选 | 企业 / 手机号 / 支付宝做成**同一实体的联动筛选组**；紫鸟、ERP 各自独立；状态独立；不带平台筛选 |
| 本轮明确不做 | 多平台 UI、每店覆盖工具密码、通用筛选器 / 保存视图、分页 / 虚拟滚动、模糊自动匹配、邮箱引擎改造、`DB_OPS` 域拆分、软删除框架 |

**一句话**：店铺和账号就是同一行 —— 有店名就是店，有邮箱就是账号，两者都有就是完整店铺，缺哪个就在列表里补哪个。底层只有一张 `sk_shops`。

---

## 1. 现状盘点

### 1.1 现有四张表

```graph LR
  SET["sk_shop_sets 账号套装<br/>16 行"] -->|shop_set_id<br/>6 条| SHOP["sk_shops 店铺身份<br/>9 行"]
  SET -->|company_id<br/>4 条| COMPANY["sk_companies 企业<br/>3 行"]
  SET -.->|company 文本<br/>自填，可对不上| COMPANY
  SET -->|shop_set_id 外键<br/>ON DELETE CASCADE| MAIL["sk_mail_accounts 邮件账号<br/>3 行"]
  SHOP -->|shop_id| PSKU["pl_shop_sku"]
  SHOP -->|shop_id| PITEM["pl_shop_items"]
  SHOP -->|ref_id| NMAP["sk_name_map"]
```

- 账号套装：`electron/shop-accounts-db.ts:193`，列含 `email / phone / company / alipay / ziniao_account / erp_account / platforms / opened_at / status / tags / note / secret_enc / secret_keys`；`company_id` 是后来增量补的列。
- 店铺身份：`electron/shop-db.ts:158`，`shop_set_id` 在 `:167`，索引在 `:176`；**全量提交**语义见 `:90`（没传的字段会被清空）。
- 企业：`electron/company-db.ts:194`，有 `contact_phone`，**没有支付宝字段**。
- 邮件：`electron/mail-db.ts:172`，外键在 `:174`（`shop_set_id` 唯一 + 级联删除）。
- 写入入口：账号 `upsertShopAccount`（`electron/shop-accounts-db.ts:399`）、店铺 `upsertShop`（`electron/shop-db.ts:629`）。
- 列表：账号一次性全取后在内存过滤（`electron/shop-accounts-db.ts:294`）；店铺走 SQL 分页（`electron/shop-db.ts:483`）。两套列表、两套状态、两套写入。

### 1.2 真库只读取证（2026-10-22）

| 事实 | 数值 | 对设计的含义 |
|---|---:|---|
| 账号套装 / 店铺 / 企业 / 邮件账号 | 16 / 9 / 3 / 3 | 小数据量，不需要分页与虚拟滚动 |
| 账号挂到店铺 | 6 | 剩下 10 个账号没有店铺 → 变成 `name = ''` 的行 |
| 店铺挂到账号 | 6 | 剩下 3 个店铺没有账号 → 变成 `email = ''` 的行 |
| 一个账号挂多家店 | 0 | 可以安全地一店一行；迁移预检发现 >0 就暂停 |
| 不同 ERP 登录数 | 1（12 个账号共用） | 工具账号本体化的收益最大 |
| 有 ERP 密码的账号 | 9 | 密码随工具账号走，不再每店一份 |
| 紫鸟登录 / 支付宝文本 | 0 / 0 | 字段先按模型留好，迁移不产生脏数据 |
| 不同手机号 | 4 | 手机号放企业后，重复维护的 4 个值变成企业侧一次维护 |
| `company_id = 0` / 已关联企业 | 12 / 4 | 企业关联一半以上是空的；文本组能精确归并到现有 3 家 |
| 三家企业 `contact_phone` | 全为空 | 迁移可从账号侧回填 |
| 命中的企业文本组 | 3 组（4 / 5 / 1 个账号）＋ 2 个账号只有手机号没有企业 | 精确归并；2 个孤儿手机号不建企业壳，写备注 |
| 邮件账号落在无店铺的账号上 | 3 / 3 | 账号可以独立于店铺存在；合并后它们落在 `name = ''` 的行上 |
| 平台值 | 账号全是 `["速卖通"]` 或 `[]`；店铺全是 `ae` | 平台没有第二个值，不需要选择器 |
| 重复邮箱（忽略大小写） | 0 | 可以安全建邮箱部分唯一索引 |
| `status` / `opened_at` 两表各一份 | 全部 `active`；16 个账号只有 1 个填了开店时间 | 两份存储没有产生差异；合并后一行只留一份 |
| 下游引用 `sk_shops.id` | `pl_shop_sku` / `pl_shop_items` / `sk_name_map` 合计 110+ 行 | 店铺 id 1–9 必须原样保留 |

### 1.3 现状的六个结构问题

1. **工具登录散落在每一行**：`ziniao_account` / `erp_account` 是文本，密码在每行的 `secret_enc` 里；同一个 ERP 登录复制 12 份，改密码要改 12 次。
2. **手机号 / 支付宝在账号上重复**：同一企业的多个账号各填一遍，企业表里还有一份 `contact_phone`，两边可以不一致。
3. **店铺与账号两张列表**：账号页有「名下店铺」子表，店铺登记页又有一张全量店铺表；同一个店铺的信息分两处看、两处改。
4. **账号平台是多值 JSON**：`platforms` 存数组，列表按数组筛选；实际只有速卖通一个值。
5. **店铺状态与账号状态各有一套、词表还不同**：店铺是 `active/archived`，账号是 `active/paused/banned/closed`。同一件事两种说法。
6. **空态不可表达**：账号必须填邮箱，没有邮箱的店铺只能不建档。物理合并后要允许「只有店铺、账号待补」和「只有账号、店铺待建」两种合法状态。

---

## 2. 目标数据模型

### 2.1 总览

```graph LR
  COMPANY["sk_companies 企业<br/>名称 / 手机号 / 支付宝"] -->|company_id| SHOP["sk_shops 店铺 + 账号<br/>店名 / 邮箱 / 状态 / 凭证"]
  Z["sk_tool_accounts 工具账号<br/>kind = ziniao"] -->|ziniao_account_id| SHOP
  E["sk_tool_accounts 工具账号<br/>kind = erp"] -->|erp_account_id| SHOP
  SHOP -->|shop_id| MAIL["sk_mail_accounts 邮件账号"]
  SHOP -->|shop_id 不变| DOWN["pl_shop_sku / pl_shop_items / sk_name_map"]
```

**关键取舍**：`sk_shops` 从「只装平台身份」升级为「店铺 + 账号一体」；`sk_shop_sets` 删除。店铺与账号的关系从「两表 1:1 可选」变成「同一行的两个字段」，没有 join、没有并集、没有「档案」这个概念。

### 2.2 `sk_shops`（唯一主表）

```sql
CREATE TABLE sk_shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL DEFAULT 'ae',
  name TEXT NOT NULL DEFAULT '',               -- '' = 只有账号，还没建店铺
  name_key TEXT NOT NULL DEFAULT '',           -- name 的归一键；name 为空时必须为空
  platform_shop_id TEXT NOT NULL DEFAULT '',   -- 平台店铺 ID（稳定业务键）
  shop_url TEXT NOT NULL DEFAULT '',           -- 匹配键（归一化后的地址）
  shop_url_raw TEXT NOT NULL DEFAULT '',       -- 原文（展示 / 打开店铺）
  site TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',              -- '' = 还没配账号
  company_id INTEGER NOT NULL DEFAULT 0,       -- 0 = 未关联企业
  ziniao_account_id INTEGER NOT NULL DEFAULT 0,
  erp_account_id INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',       -- active / archived
  opened_at TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  secret_enc BLOB,                             -- 店铺密码 / 邮箱密码 / 国际支付宝密码 / IMAP 授权码
  secret_keys TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  -- 一行至少要能说明"这是谁"：店名或邮箱
  CHECK (trim(name) <> '' OR trim(email) <> ''),
  -- name 与 name_key 同生同灭，防止派生键与展示名脱节
  CHECK (
    (trim(name) = '' AND trim(name_key) = '') OR
    (trim(name) <> '' AND trim(name_key) <> '')
  )
);

-- 表级 UNIQUE(platform, name_key) 必须去掉：否则 10 个 name='' 的行会互相撞键
CREATE UNIQUE INDEX uq_sk_shops_platform_name
  ON sk_shops(platform, name_key) WHERE trim(name_key) <> '';
CREATE UNIQUE INDEX uq_sk_shops_email
  ON sk_shops(lower(email)) WHERE trim(email) <> '';
CREATE UNIQUE INDEX idx_sk_shops_platform_sid
  ON sk_shops(platform, platform_shop_id) WHERE platform_shop_id <> '';
CREATE INDEX idx_sk_shops_name_key ON sk_shops(name_key);
CREATE INDEX idx_sk_shops_status ON sk_shops(status);
CREATE INDEX idx_sk_shops_company ON sk_shops(company_id);
CREATE INDEX idx_sk_shops_ziniao ON sk_shops(ziniao_account_id);
CREATE INDEX idx_sk_shops_erp ON sk_shops(erp_account_id);
```

设计点：

- **部分唯一索引是核心**：`name_key = ''` 的行不参与店铺名唯一性，`email = ''` 的行不参与邮箱唯一性。这是「一张表同时容纳两种空态」的前提。
- **不做哨兵 `name_key`**（例如 `~account:12`）：那会把派生键变成身份键，名称归一、搜索、导出都会碰到假值；以后想补建店铺还得清洗。重建表是一次性成本，哨兵是永久债。
- **`platform` 默认 `ae`**：纯账号行也落 `ae`；界面固定显示「速卖通」，不做下拉。历史店铺若有别的平台值，迁移原样保留，界面按值显示（不再提供选择器）。
- **状态只有一套**：`active / archived`。账号侧原来的 `paused / banned / closed` 统一并入 `archived`（真库为 0，具体原因写备注）。
- **凭证只有一组**：`shopPwd / emailPwd / alipayPwd / mailAuthPwd`。紫鸟 / ERP 密码不在这里，在工具账号表。
- **不再有 `shop_set_id`**：店铺与账号之间不再需要外键。

### 2.3 `sk_tool_accounts`（新表，紫鸟 / ERP 共用一个形状）

```sql
CREATE TABLE sk_tool_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('ziniao', 'erp')),
  account TEXT NOT NULL DEFAULT '',            -- 登录名
  account_key TEXT NOT NULL DEFAULT '',        -- lower(trim(account))
  password_enc BLOB,                           -- 一条登录一份密码（encodeSecrets({ pwd })）
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  UNIQUE (kind, account_key),
  CHECK (trim(account) <> '')
);

CREATE INDEX idx_sk_tool_accounts_kind ON sk_tool_accounts(kind);
```

- **一条登录一份密码**：这是用户描述的现状（一个紫鸟 / ERP 管多个速卖通账号），不做「每店覆盖密码」。
- **`account_key` 归一键**：避免 `ABC` / `abc` 建出两条。
- **删除保护**：仍被店铺引用时禁止删除，并显示「被 N 个店铺使用」。
- **密码单独解密**：新增只接受工具账号 id 的 reveal 操作，不复用店铺行的密码字段。

### 2.4 企业：手机号 + 支付宝的唯一落点

```sql
-- 新库写进 CREATE TABLE；老库用 PRAGMA table_info 探测后 ALTER
ALTER TABLE sk_companies ADD COLUMN alipay_account TEXT NOT NULL DEFAULT '';
```

- 复用 `sk_companies.contact_phone` 作为手机号；新增 `alipay_account`。
- 一家企业一份手机号、一份支付宝；店铺侧**只读**展示。要改就点「去企业修改」，改一次所有店铺同步。
- 企业删除前检查是否被店铺引用；被引用则拒绝，提示先改挂或删除店铺。

### 2.5 邮件：外键改指 `sk_shops`

```sql
CREATE TABLE sk_mail_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id INTEGER NOT NULL UNIQUE REFERENCES sk_shops(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  -- 其余列不变；folders 也写进 CREATE TABLE（原先只靠增量补列）
  folders TEXT NOT NULL DEFAULT '',
  ...
);
```

- 列名 `shop_set_id` → `shop_id`；外键目标 `sk_shop_sets(id)` → `sk_shops(id)`；保留 `ON DELETE CASCADE` 与唯一约束。
- **邮件表必须重建**，不是只改列名：SQLite 的 `RENAME COLUMN` 不会把外键目标从 `sk_shop_sets` 改成 `sk_shops`。重建时保留账号 id，`sk_mail_messages` / `sk_mail_folders` / `sk_mail_attachments` 的外键继续有效。
- 删除店铺行时如果挂着邮件账号，确认框必须明确写出「将同时删除 1 个邮件账号及本地缓存」。
- 账号独立于店铺存在，所以邮件账号也可以挂在 `name = ''` 的行上 —— 这正是合并后仍然成立的能力。

### 2.6 行的四种状态

| 店名 `name` | 邮箱 `email` | 含义 | 列表表现 |
|---|---|---|---|
| 非空 | 非空 | 店铺 + 账号齐全 | 正常行 |
| 非空 | 空 | 只有店铺，账号待补 | 邮箱列显示「账号待补」+「补账号」 |
| 空 | 非空 | 只有账号，店铺待建 | 店铺列显示「未建店铺」+「补建店铺」 |
| 空 | 空 | 非法 | 拒绝写入（数据库 `CHECK` + 写入函数双重拦截） |

- 新建行至少要有一个「店铺名」或「邮箱」；两者都空拒绝。
- 已有行允许清空其中一项，但不能同时清空；要彻底不用就删除整行。
- 迁移不造任何「占位行」：16 个旧账号就是 16 行（6 行合并进已有店铺、10 行 `name=''`），9 家店就是 9 行（其中 3 行 `email=''`），合计 **19 行**。

### 2.7 所有权规则

| 数据 | 唯一落点 | 说明 |
|---|---|---|
| 店铺名 / 平台 / 平台店铺 ID / 地址 / 站点 | `sk_shops` | 店铺列 |
| 邮箱 / 店铺密码 / 邮箱密码 / 邮箱授权码 | `sk_shops` | 账号列 |
| 状态 / 开店时间 / 标签 / 备注 | `sk_shops` | 只有一处 |
| 国际支付宝密码 | `sk_shops`（加密） | 每店可不同 |
| 企业 / 手机号 / 支付宝 | `sk_companies` | 店铺侧只读 |
| 紫鸟 / ERP 登录与密码 | `sk_tool_accounts` | 多店共享 |
| 邮件账号配置 | `sk_mail_accounts` | 外键指向 `sk_shops.id` |

### 2.8 为什么这比「逻辑合并」简单

| 复杂度 | 逻辑合并（两表 1:1） | 物理合并（本文） |
|---|---|---|
| 主表数量 | 2 张 + 工具账号 | 1 张 + 工具账号 |
| 列表查询 | `FULL OUTER JOIN` | `SELECT` |
| 行身份 | 「档案 id 或店铺 id」二选一，界面用 `p:<id>` / `s:<id>` | 一个 id |
| 状态 / 开店时间 | 迁移期两处存储，要定谁赢 | 一处 |
| 「只有店铺」 | 没有档案，字段显示「—」 | 同一行的空邮箱 |
| 新建「只有店铺」 | 要判断 `profileTouched`，避免造空档案 | 直接写一行 |
| 删除 | 「删档案」与「删店铺」两套 | 一个删除 |
| 迁移成本 | 较低（改名 + 加列） | 一次性重建两张表 |
| 长期维护 | 每加一个字段都要判断住哪张表 | 只改一张表 |

---

## 3. 界面重构

### 3.1 信息架构

「基础数据 › 店铺账号」组内页签调整为：

| 页签 | kind id | 内容 |
|---|---|---|
| **店铺** | `accounts`（沿用） | 合并后的店铺 + 账号列表（原「账号库」） |
| **店名归一** | `registry`（沿用） | 只保留「未登记的店铺名」队列与映射动作；删掉全量已登记店铺表 |
| **企业** | `companies` | 企业档案 + 手机号 + 支付宝；显示关联店铺数 |
| **工具账号** | `tools`（新增） | 紫鸟 / ERP 登录；显示被多少店铺使用 |

其他组（货品档案、物流运费）不变。新增 `tools` 需要同步 `src/modules/shop-accounts/MasterDataView.vue:109` 的 `KINDS`、`:153` 的 `GROUPS`，以及 `tests/shopAccountsIntake.spec.ts` 的页签清单（当前在 `:202` 附近钉了 `账号库 / 店铺登记 / 企业`）和 `tests/uxEntryNames.spec.ts` 的入口名清单。

### 3.2 合并列表

列：**店铺 / 邮箱 / 企业 / 手机号 / 支付宝 / 紫鸟 / ERP / 状态 / 操作**。

```text
[搜索 店铺/邮箱/企业/手机号/支付宝/紫鸟/ERP]  [企业▾][手机号▾][支付宝▾][紫鸟▾][ERP▾][状态▾][重置]
店铺          邮箱             企业      手机号      支付宝      紫鸟    ERP    状态   操作
张三店        z***@x.com       甲公司    138****     138****     —      erp01  启用   编辑 复制 删除
未建店铺      y***@x.com       甲公司    138****     138****     —      erp01  启用   编辑 复制 删除
李四店        账号待补          —         —           —           —      —      启用   编辑 复制 删除
```

- 删掉「平台」列（全是速卖通）和「开店时间」列（详情里看，列表不占宽）。
- 店铺列显示店名；`name = ''` 显示「未建店铺」并带「补建店铺」按钮。
- 邮箱列空时显示「账号待补」并带「补账号」按钮。
- 企业 / 手机号 / 支付宝：`company_id = 0` 时显示「—」（可点「关联企业」）。
- 行尾操作：编辑 / 复制 / 删除；密码类动作收进「复制」菜单。
- 排序：有店名的行按 `name_key` 升序，纯账号行排在后面按邮箱升序。
- 列表一次加载全部行，筛选在内存完成；**不分页、不做虚拟滚动**。

### 3.3 联动筛选

搜索框保留，占位文案改为「搜索 店铺 / 邮箱 / 企业 / 手机号 / 支付宝 / 紫鸟 / ERP」。

筛选行：

1. **企业 / 手机号 / 支付宝**：三个下拉，底层同一个 `companyId` 筛选状态。
   - 选企业 → 手机号 / 支付宝自动显示该企业的值；
   - 选某个手机号 → 反查它所属企业，企业下拉同步；
   - 选某个支付宝 → 同上；
   - 手机号 / 支付宝为空的选项不进入这两个下拉；企业仍可在企业下拉里选；
   - 如果同一个手机号被两家企业使用，选项文案带企业名消歧；
   - **不允许**出现「企业 A + 手机号属于企业 B」这种互斥组合；三选一即锁定同一企业。
   - 企业下拉包含「（未关联）」选项，用于筛出 `company_id = 0` 的行。
2. **紫鸟**：独立单选下拉，选项来自工具账号表，显示「登录名（N 个店铺）」，含「（未使用）」。
3. **ERP**：同上，独立单选。
4. **状态**：全部 / 启用 / 停用。
5. **重置**：一次清空搜索与全部筛选。

选项计数按「其他筛选都生效、本维度不生效」计算（标准分面），避免用户选出必然为空的组合；当前选中项即使计数为 0 也保留在选项里，防止界面「跳值」。

**不做**：多选、保存筛选视图、筛选条件持久化、跨页签联动。数据量不支持这些功能的收益。

### 3.4 合并编辑器（一个表单、一次保存）

区块顺序：

1. **店铺**：店铺名 / 平台（固定「速卖通」）/ 平台店铺 ID / 店铺地址 / 站点。
   - `name = ''` 时这一块展开为「补建店铺」；填写店名后保存即成为正式店铺。
2. **账号**：邮箱 / 店铺密码 / 邮箱密码 / 邮箱授权码。
   - `email = ''` 时这一块显示「账号待补」，不阻塞保存；填写邮箱后即可接入邮件。
3. **企业**：企业下拉 + 只读手机号 + 只读支付宝 + 「国际支付宝密码」。
   - 手机号 / 支付宝旁有「去企业修改」，跳到企业页并定位。
   - 企业下拉支持搜索；内联「新建企业」打开企业编辑抽屉，保存后自动选中。
4. **工具账号**：紫鸟下拉 + ERP下拉；各带「新建」。
   - 下拉显示登录名；新建只填登录名与密码，保存后回填选中。
   - 密码不在店铺表单里重复输入；需要改密码去工具账号页。
5. **其他**：状态 / 开店时间 / 标签 / 备注。

行为规则：

- **一次保存**：`upsertShopAccount` 在一个事务里写这一行的全部字段；任一步失败全部回滚。
- **无「名下店铺」子表**：原 `AccountEditor.vue:500` 的区块删除；店铺字段直接进主表单。
- **不是全量提交陷阱**：合并接口按字段显式更新（`undefined = 不动`，`'' = 清空`），未展示的字段（如 `shop_url_raw`、`site`）不得被清空。**旧的 `shopUpsert` 全量语义必须一起改成同样的局部更新**，否则「货与成本」的店铺选择器编辑一次就会把账号字段清空。
- **状态 / 开店时间只写这一行**：不存在「写店铺表还是档案表」的分支。
- **新建默认值**：企业 / 紫鸟 / ERP 默认带出上一次保存成功时的选择（记在 `shop-accounts` 命名空间），下拉里可见、可改；不自动复制密码。
- **补建店铺**：在纯账号行点「补建店铺」，填店名后保存 → 同一行变成完整店铺，不重输账号与密码。
- **补账号**：在纯店铺行点「补账号」，填邮箱后保存 → 同一行变成完整店铺，不重输店铺信息。
- **邮箱唯一冲突**：就地提示「这个邮箱已被另一个店铺账号使用」，不静默改值。
- **店名唯一冲突**：就地提示「同一平台下已有同名店铺」，不自动改名。

### 3.5 工具账号页

表格：**类型 / 登录名 / 被使用 / 备注 / 操作**。

- 新建：类型（紫鸟 / ERP）+ 登录名 + 密码 + 备注。
- 编辑：登录名、备注；密码单独「重置密码」。
- 删除：被引用时禁用，显示「被 N 个店铺使用」。
- 账号归一键冲突时就地提示「同类型下已有这个登录名」。
- 不显示密码明文，复制密码走 reveal 操作。

### 3.6 企业页

- 新增「支付宝账号」列与编辑项；手机号沿用现有 `contact_phone`，界面标签统一为「手机号」。
- 增加「关联店铺」计数；点计数跳到店铺页并带上企业筛选。
- 删除企业：有关联店铺时拒绝，提示先改挂或删除店铺。

### 3.7 店名归一页

- **删掉**全量已登记店铺表与「编辑店铺」表单；这些信息已经在「店铺」页。
- 保留「未登记的店铺名」队列、忽略、映射到已有店铺、新建店铺。
- 「新建店铺并关联」= 创建一行（店名必填、邮箱可空）+ 写名称映射；保存后直接打开合并编辑器补账号信息，不再要求用户去另一个页签重复操作。

### 3.8 复制与批量编辑

复制模板（`src/modules/shop-accounts/store.ts:116` 一带）改为：

| 模板 | 取值 |
|---|---|
| ERP 登录 | 工具账号登录名 + 工具账号密码（reveal） |
| 紫鸟登录 | 工具账号登录名 + 工具账号密码（reveal） |
| 店铺与账号 | 店铺名 / 邮箱 / 店铺密码 / 邮箱密码 / 邮箱授权码 / 手机号 / 支付宝账号 / 国际支付宝密码 / 紫鸟登录 / ERP 登录 / 标签 / 备注 |

- 复制多行时按工具账号 id 缓存已解密密码，避免同一个 ERP 密码重复解密 N 次。
- 批量编辑字段：企业 / 紫鸟 / ERP / 状态 / 标签 / 备注。
- 删除批量里的手机号、支付宝、平台、工具登录名文本（它们不再属于店铺行）。
- 批量操作对纯账号行同样生效（它们也有状态 / 企业 / 工具引用）。

### 3.9 重复操作对照

| 现在要重复做的事 | 重构后 |
|---|---|
| 每新增一个店铺，重输一遍紫鸟 / ERP 账号密码 | 下拉选已有工具账号；要改密码去「工具账号」改一次 |
| 每个店铺重复填同一企业的手机号 / 支付宝 | 企业页填一次，店铺侧只读 |
| 账号页看「名下店铺」，店铺登记页再看一遍同一家店 | 一个「店铺」列表看全，编辑也只在一个表单 |
| 先保存账号，再去「名下店铺」逐个登记店铺 | 一次保存写同一行 |
| 店铺登记页维护全量店铺，实际只想处理未登记名字 | 店名归一页只留未登记队列 |
| 改工具密码要逐店改 | 工具账号页改一次，所有引用店铺生效 |

---

## 4. 写入与删除规则

### 4.1 合并写入（一个事务）

输入形状（IPC）：

```ts
interface ShopAccountUpsertInput {
  id?: number;                 // 行 id；0/缺省 = 新增
  name?: string;               // 缺省 = 保持；'' = 清空（仅当 email 非空）
  platform?: string;           // 缺省 'ae'；界面不传
  platformShopId?: string;
  shopUrl?: string;
  site?: string;
  email?: string;              // 缺省 = 保持；'' = 清空（仅当 name 非空）
  companyId?: number;          // undefined = 保持；0 = 取消关联
  ziniaoAccountId?: number;
  erpAccountId?: number;
  status?: 'active' | 'archived';
  openedAt?: string;
  tags?: string;
  note?: string;
  secrets?: Partial<Record<'shopPwd' | 'emailPwd' | 'alipayPwd' | 'mailAuthPwd', string>>;
  clearSecrets?: Array<'shopPwd' | 'emailPwd' | 'alipayPwd' | 'mailAuthPwd'>;
}
```

校验顺序：

1. 计算写入后的 `name` / `email`；两者都空 → 拒绝（提示「店铺名和邮箱不能同时为空；不再使用请删除这一行」）。
2. `email` 非空时必须包含 `@`；`lower(trim(email))` 不与其他行冲突。
3. `name` 非空时重算 `name_key`，按 `(platform, name_key)` 查重；同名同平台返回明确错误，不自动改店名。
4. `platformShopId` 非空时按 `(platform, platform_shop_id)` 查重。
5. `companyId` 存在；`ziniaoAccountId` / `erpAccountId` 存在且 `kind` 匹配（0 表示未关联）。
6. 工具账号 / 企业不允许在保存时**隐式新建**：必须走工具账号页 / 企业页，或编辑器里的显式「新建」，避免手误产生重复登录。

写入顺序：

1. 读取现有行（更新时）；不存在则报「店铺不存在或已被删除」。
2. 合并字段：`undefined` 保持、`''` 清空、有值覆盖。
3. 合并密码：只覆盖传入的非空密码；`clearSecrets` 明确删除；未传字段保留原值。
4. 刷新 `name_key`（name 变化时）、`updated_at`。
5. 单条 `INSERT` / `UPDATE`，整段走事务。

**店铺侧写入（货与成本 / 店名归一）**：

- `upsertShop` 改为局部更新语义（`undefined = 不动`），不再「没传就清空」。这是物理合并后必须同步改的一条：否则店铺选择器编辑一次会把 `email / company_id / 工具引用 / 凭证` 全部清掉。
- `upsertShop` 仍要求店名非空（店铺侧不创建纯账号行）。
- 更新后仍调用 `adoptShopItemsForShop` 收养采集商品。

### 4.2 删除规则（不做软删除框架）

| 对象 | 规则 |
|---|---|
| 店铺行 | 先数下游引用：`pl_shop_sku.shop_id`、`pl_shop_items.shop_id`、`sk_name_map.ref_id`。有引用 → **禁止删除**，提示「先停用；有商品 / 映射引用时不能删」 |
| 无引用的店铺行 | 直接删除；若挂邮件账号，确认框写明级联删除范围 |
| 纯账号行 | 直接删除；同样提示邮件级联 |
| 工具账号 | 被 `ziniao_account_id` / `erp_account_id` 引用时禁止删除，显示引用数 |
| 企业 | 被 `company_id` 引用时禁止删除，显示关联店铺数 |
| 名称映射 | 有映射的店铺不能删（计入上面的引用检查）；历史映射不自动清理 |

**「停用」= `status = 'archived'`**。这是有商品数据的店铺唯一可用的清理方式：行保留、历史引用不断、列表默认仍可见（按状态筛选）。

**没有「只删账号档案、保留店铺」这个动作**：物理合并后它们已经是同一行。要清空账号，就在编辑器里把邮箱与密码清空（行仍有店名，合法）；这比一个单独的删除动作更直观。

---

## 5. 迁移方案

### 5.1 为什么必须重建表

1. 老 `sk_shops` 有**表级 `UNIQUE(platform, name_key)`**。SQLite 不支持 `ALTER TABLE ... DROP CONSTRAINT`；要允许 10 个 `name=''` 的行，只能把它换成**部分唯一索引** → 重建表。
2. 邮件表的外键目标是 `sk_shop_sets(id)`；合并后要指向 `sk_shops(id)`。`ALTER TABLE ... RENAME COLUMN` 只改列名，不改外键目标 → 重建邮件表。
3. 一次性重建换来长期单表；这是本方案唯一的一次性成本。

**迁移键**：`shop.main` v1（`sk_schema_migrations` 记账）。基线 §6「schema 演进」登记为 `shop.main = v1`。

**不能直接用 `migrate(key, steps)` 的原因**：`migrate()` 在外层开事务，而 `PRAGMA foreign_keys=OFF` 在事务内无效。迁移必须：

```text
检测版本 → 备份 → PRAGMA foreign_keys=OFF（事务外）
  → 开事务：建新表 / 搬数据 / 重建邮件表 / 换表 / foreign_key_check / 写账本
  → 提交 → PRAGMA foreign_keys=ON（finally）
```

账本仍写 `sk_schema_migrations`（key `shop.main`，version 1），与其它域一致；只是事务外壳自己管。

### 5.2 启动顺序（必须显式规定）

各域现在是懒加载建表，谁先被调用谁先 ensure。这次有三处跨表搬运，靠「碰巧的顺序」会出事。在 `electron/main.ts` 的 `app.whenReady()` 里加四行编排（不是迁移框架）：

```text
1. ensureCompanySchema()        // 企业表 + alipay_account 列
2. ensureShopSchema()           // 店铺主迁移（含邮件表重建）
3. ensureMailSchema()           // 邮件表新形状 / FTS / 补列（幂等）
```

- 第 2 步依赖企业表做手机号 / 支付宝回填，所以企业必须在前。
- 第 2 步会重建 `sk_mail_accounts`（如果它已存在）；第 3 步只做幂等收尾。
- 各 handler 里的懒 ensure 保持不变；启动编排保证「第一次 IPC 之前」已经跑完。

### 5.3 预检（只读；有任何一项不满足就暂停并列出）

| 检查 | 预期 | 不满足时 |
|---|---:|---|
| 账号邮箱忽略大小写重复 | 0 | 暂停，列冲突邮箱 |
| 一个账号被多家店引用 | 0 | 暂停，列账号与店铺 |
| 账号 `platforms` 含速卖通 / `ae` / 空以外的值 | 0 | 暂停，列账号 |
| 账号状态不在 `active/paused/banned/closed/archived/''` | 0 | 暂停，列账号 |
| 同一企业组出现多个不同手机号（且企业字段为空） | 0 | 暂停，列企业与手机号 |
| 同一企业组出现多个不同支付宝（且企业字段为空） | 0 | 暂停，列企业与支付宝 |
| 同一工具登录出现多个不同密码 | 0 | 暂停，列登录与账号 |
| 有工具密码但没有登录名 | 0 | 暂停，列账号（不丢密码，先人工处理） |
| 企业文本命中多家企业 | 0 | 暂停，列文本与候选企业 |
| 邮件账号的 `shop_set_id` 找不到账号 | 0 | 暂停，列邮件账号 |
| 账号邮箱格式不含 `@` | 0 | 暂停，列账号 |

真库以上全部为 0。开发期数据可人工整理，所以「暂停」是允许的处置；**不静默择一、不丢密码**。

### 5.4 主迁移步骤（`shop.main` v1）

0. **备份（仅老库）**：`VACUUM INTO` 到 `userData/sellerkit.db.bak-shop-merge-v1-<时间戳>`；备份失败则不迁移。新库跳过。
1. 判定形状：
   - `migrationVersion('shop.main') >= 1` → 直接返回。
   - 没有 `sk_shop_sets` 且 `sk_shops` 已是新形状（无 `shop_set_id` 列）→ 写 v1 账本，返回。
   - 没有 `sk_shop_sets` 且没有 `sk_shops` → 返回（新库；由 `dbMigrate(SCHEMA)` 建新形状，随后补写 v1）。
2. 跑历史补丁：给 `sk_shop_sets` 补 `opened_at` / `company_id`；若旧 `sk_accounts` 存在，按现有 `migrateLegacyAccounts` 的字段映射灌进 `sk_shop_sets`（临时建旧表也可，随后一起删）。
3. 给老 `sk_shops` 补 `platform_shop_id` / `shop_url` / `shop_url_raw`（复用 `ensureShopColumns()`）。
4. 读全部旧行：`sk_shops` / `sk_shop_sets` / `sk_companies` / `sk_mail_accounts`；解出账号密码（`decodeSecrets`）。
5. 跑 §5.3 预检；失败则抛错、事务回滚。
6. **企业归并**：
   - `company_id > 0` 且企业存在 → 直接用；
   - 否则旧 `company` 文本按 `trim + 不区分大小写` 精确匹配企业名；唯一命中 → 关联；多命中 → 已在预检暂停；
   - 未命中且文本非空 → 建企业（名称=文本）；
   - 只有手机号 / 支付宝、没有任何企业信息 → **不建企业壳**：`company_id = 0`，把旧手机号 / 支付宝原值写进该行备注（前缀「迁移遗留：」）。
7. **企业手机号 / 支付宝回填**：仅当企业字段为空且该组只有一个不同值；已有值不覆盖；多值已在预检暂停。
8. **工具账号**：按 `(kind, lower(trim(account)))` 归并，插入 `sk_tool_accounts`；密码按登录取唯一一份。得到 `account.id → toolAccountId` 映射。
9. **建 `sk_shops_new`**（§2.2 形状）。
10. **先插 9 家旧店**（显式带 id，保证 1–9 不变）：
    - 找到它引用的账号（`oldShop.shop_set_id`）；
    - 有账号：合并店名 / 平台 / 地址 / 站点 + 账号的邮箱 / 企业 / 工具 id / 状态 / 开店时间 / 标签 / 备注 / 凭证；
    - 无账号：只写店铺字段，`email=''`、`company_id=0`、工具 id=0、`secret_enc=NULL`。
11. **再插 10 个纯账号**（不给 id，SQLite 从 10 起）：`name=''`、`name_key=''`、`platform='ae'`、店铺字段为空、账号字段照搬。每插一条记下 `oldAccount.id → newRow.id`。
12. **重建 `sk_mail_accounts`**：
    - 建 `sk_mail_accounts_new`（`shop_id ... REFERENCES sk_shops(id) ON DELETE CASCADE`）；
    - 按 `oldMail.shop_set_id → 新行 id` 映射搬数据（保留账号 id 与全部列，含 `folders`）；
    - 删旧表、改名、重建索引。
13. 删旧 `sk_shops` → `sk_shops_new` 改名为 `sk_shops` → 删 `sk_shop_sets`。
14. 建 §2.2 的全部索引（旧索引随旧表删除）。
15. `PRAGMA foreign_key_check`：有任何一行失败则抛错、整个事务回滚。
16. 写 `shop.main` v1 账本；提交。
17. `PRAGMA foreign_keys=ON`（finally）；打印迁移摘要（行数 / 工具账号数 / 企业数 / 邮件数 / 警告）。

### 5.5 迁移后行数与映射（验收）

真库预期：

| 对象 | 结果 |
|---|---|
| `sk_shops` | **19 行**：6 行店铺+账号、3 行只有店铺、10 行只有账号 |
| 店铺 id | 1–9 原样保留；10–19 为纯账号新行 |
| `sk_tool_accounts` | **1 条**（ERP），紫鸟 0 条 |
| 企业 | **3 家**（不新增壳）；2 个孤儿手机号账号 `company_id = 0`，备注含「迁移遗留：」 |
| 邮件 | **3 条**，`shop_id` 指向 10–19 中的对应行 |
| `sk_name_map` | 不变（ref_id 1–9 仍有效） |
| `pl_shop_sku` / `pl_shop_items` | 不变（`shop_id` 1–9 仍有效） |

### 5.6 边界情况

| 情况 | 处置 |
|---|---|
| 老店铺引用的账号不存在（悬空 `shop_set_id`） | 该店按「只有店铺」迁移；迁移日志列出 |
| 一个账号被多家店引用 | 预检暂停（真库 0）；不自动选一家 |
| 账号状态为 `paused/banned/closed` | 映射为 `archived`；原因写备注（真库 0） |
| 店铺状态为 `archived` | 保留 `archived` |
| 店铺 `opened_at` 与账号不同 | 账号非空取账号，否则取店铺；日志列出差异 |
| 店铺 `note` 与账号 `note` 都非空 | 账号备注 + 换行 + 店铺备注；店铺备注在真库全空 |
| 账号有密码但无工具登录 | 预检暂停（不丢密码） |
| 邮件表不存在 | 跳过重建；随后 `ensureMailSchema` 直接建新形状 |
| 邮件表已是新形状（`shop_id`） | 跳过重建（视为已迁移） |
| 新库 | 迁移 no-op；`dbMigrate(SCHEMA)` 建新形状；补写 v1 账本 |

### 5.7 冒烟场景（`npm run schema:smoke` 新增）

1. **当前形状 → 新形状**：16 套装 / 9 店 / 3 企业 / 3 邮件，断言：
   - 19 行、6 完整 / 3 只有店铺 / 10 只有账号；
   - id 1–9 未变；10–19 为纯账号；
   - 工具账号 1 条（ERP），密码落在工具表；
   - 企业仍 3 家、2 条 `company_id = 0` 且备注含「迁移遗留：」；
   - 有企业归属的账号，手机号 / 支付宝落到企业；
   - 邮件 3 条，`shop_id` 指向正确的新行；
   - 旧列 `shop_set_id` / `sk_shop_sets` 已不存在；`foreign_key_check` 干净；
   - 重跑一次迁移幂等。
2. **只有店铺、没有账号表**：9 行店铺全部 `email=''`，迁移成功。
3. **只有账号、没有店铺表**：16 行全部 `name=''`，id 从 1 起，迁移成功。
4. **多店引用一个账号**：预检拒绝迁移，旧库原样保留。
5. **工具密码冲突 / 孤儿工具密码**：预检拒绝，旧库原样保留。
6. **旧 `sk_accounts` 形状**：历史映射仍能跑通，再进入新合并。
7. **新库**：直接建出新形状，没有旧列，迁移 no-op。

**回滚**：停应用 → 用备份文件覆盖 `sellerkit.db`（连同 `-wal` / `-shm` 清理）→ 回退版本。迁移是破坏性的（删表 / 删列），没有 SQL 级回滚，备份是唯一退路。

---

## 6. 契约与代码改动清单

### 6.1 主进程 / 数据层

| 文件 | 改动 |
|---|---|
| `electron/shop-db.ts` | **唯一主表 owner**：新 `SCHEMA`；`shop.main` v1 迁移（含邮件重建）；`COLS` / `ShopListItem` / `ShopListQuery` 去掉 `shopSetId`；`listShops` 加 `trim(name) <> ''`，去掉套装筛选；`upsertShop` 改局部更新语义；`mapName` 的目标校验加 `trim(name) <> ''` |
| `electron/shop-accounts-db.ts` | 不再建任何表；`ensureShopAccountSchema()` 改为调用 `ensureShopSchema()`（跨域边登记）；账号列表 / 详情 / reveal / 批量全部改读 `sk_shops`；新增工具账号 CRUD；删除 `platforms / phone / company / alipay / ziniao_account / erp_account` 的读写；状态白名单收敛为 `active/archived`；账号 upsert 改合并形状 |
| `electron/` 下新建 `shop-secrets.ts` | 从 `shop-accounts-db.ts` 抽出 `encodeSecrets / decodeSecrets / decodeSecretsRaw` 与键白名单，供店铺行与工具账号共用；不碰表 |
| `electron/company-db.ts` | 新增 `alipay_account` 列（`SCHEMA` + `PRAGMA table_info` 增量补列）、upsert 入参、行类型、列表字段 |
| `electron/mail-db.ts` | `MAIL_SCHEMA` 的 `shop_set_id` → `shop_id`、外键 → `sk_shops`；`folders` 写进 CREATE TABLE；`MailAccountRow.shopSetId` → `shopId`；`getMailAccountByShopSet` → `getMailAccountByShop`；upsert 入参改名；插入前显式检查店铺行存在 |
| `electron/mail-engine.ts`、`electron/mail-handlers.ts` | `shopSetId` → `shopId`；reveal 仍用行 id |
| `electron/shop-handlers.ts` | `sanitizeShop` 去 `shopSetId`；`shop-list` 去套装筛选；`shop-upsert` 改局部更新；`shop-get` 只返回有店名的行 |
| `electron/shop-accounts-handlers.ts` | 合并 upsert / 删除保护 / 批量；新增工具账号通道；列表返回店铺 + 企业 + 工具字段 |
| `electron/preload.ts` / `src/types.ts` / `src/core/services/ipc.ts` | 三处同步：`ShopAccount*` 形状、工具账号通道、邮件 `shopId`、店铺 `shopSetId` 删除 |
| `src/core/plugin/host.ts` | `DB_OPS['shop-accounts']` 增加工具账号 op、upsert 改合并形状；`DB_OPS.shop` 去 `shopSetId`；同步 `tests/pluginTriage.spec.ts` 的能力域计数与清单 |
| `electron/main.ts` | `app.whenReady()` 加 §5.2 的三步编排 |

### 6.2 渲染层

| 文件 | 改动 |
|---|---|
| `src/modules/shop-accounts/MasterDataView.vue` | `KINDS` / `GROUPS` 增加「工具账号」；「账号库 → 店铺」「店铺登记 → 店名归一」 |
| `src/modules/shop-accounts/components/AccountsPanel.vue` | 合并列表、列调整、联动筛选、补建店铺 / 补账号入口 |
| `src/modules/shop-accounts/components/AccountEditor.vue` | 删「名下店铺」区块（`:500` 起）；合并店铺字段、企业只读、工具账号下拉、国际支付宝密码 |
| `src/modules/shop-accounts/components/ShopRegistryView.vue` | 删已登记店铺表与表单，只留未登记队列；新建店铺后建行 |
| 新建工具账号面板组件 | 列表 / 新建 / 改密 / 删除保护 |
| `src/modules/shop-accounts/store.ts` | 删 `PLATFORM_OPTIONS` / `SHOP_PLATFORM_OPTIONS` / `platformFilter` / 平台分组（`:204`、`:233`、`:491`、`:293`）；加企业 / 工具筛选与计数；状态改 `active/archived`；复制模板改工具账号；批量字段收缩；新增 `lastUsedCompanyId / lastUsedZiniaoAccountId / lastUsedErpAccountId`（保存成功后写入） |
| `src/modules/shop-accounts/components/CopyMenu.vue`、`BatchEditDrawer.vue` | 跟随 store 类型与字段变化 |
| 企业 / 邮件页面 | 企业加支付宝列；邮件 `shopSetId` → `shopId`（`MailSettingsPanel.vue`、`mailStore.ts`、`MailAccessDrawer.vue`） |
| `src/modules/goods/shopApi.ts` | 店铺载荷去 `shopSetId`；确认局部更新语义（未传字段不清空） |

### 6.3 测试与冒烟

- 静态守卫：`tests/shopAccountsIntake.spec.ts`（页签 / 组 / `data-act`）、`tests/uxEntryNames.spec.ts`（入口名）、`tests/pluginTriage.spec.ts`（能力域）、`tests/pluginSettingsIsland.spec.ts`（如涉及岛设置分类）。
- 主进程冒烟：`scripts/schema-migration-smoke.cjs`（§5.7 七个场景）、`scripts/shop-db-smoke.cjs`（去 `shopSetId`；钉「纯账号行不出现在 `shopList`」与「局部更新不清账号字段」）、`scripts/shop-item-db-smoke.cjs`、`scripts/product-sku-smoke.cjs`、`scripts/picking-db-smoke.cjs`、`scripts/style-authority-smoke.cjs`、`scripts/preload-ipc-shape-smoke.cjs`、`scripts/reset-dev-data.mjs`。
- 夹具同步：凡造 `sk_shops` 的 DDL / upsert 载荷，去掉 `shop_set_id`；`sk_shop_sets` 的夹具全部改成 `sk_shops`（店名 + 邮箱）。
- UI 冒烟：`scripts/master-data-ui-smoke.mjs`（四个页签、两种空态、联动筛选、补建店铺 / 补账号）、`scripts/goods-ui-smoke.mjs`（店铺载荷去 `shopSetId`）。
- 邮件：`scripts/mail-engine-smoke.cjs`、`scripts/mail-body-protocol-smoke.cjs`、`scripts/mail-inline-images-smoke.cjs`（`shopId` + `sk_shops` 行）。
- 全仓残留扫描：`sk_shop_sets` / `shop_set_id` / `shopSetId` 当前命中 21 个文件、141 处；迁移完成后除迁移代码与历史文档外应为 0。
  **实测结果（2026-10-22 收工）**：`src/**` 与 `electron/**` 的业务代码里 `shopSetId` **0 处**；`sk_shop_sets` / `shop_set_id` 只剩三类合法去处 ——
  ① `electron/shop-db.ts` 的迁移本体（读老形状、建临时落点、收尾 `DROP`）；② 冒烟脚本里**刻意造的旧形状夹具**（`shop-db-smoke` 的 `sk_shop_sets` 建表、`shop-item-db-smoke` 的 `DDL_PREV` / `DDL_OLDEST`）；
  ③ 带日期的解释性注释与历史文档（CHANGELOG / 笔记 / 本计划）。九处 `upsertShop({... shopSetId: 0 ...})` 的死键已删（`product-sku` ×3、`picking-db`、`style-authority`、`shop-item-db`、`preload-ipc-shape` ×3）——
  留着不会报错（合并后的入参忽略多余键），但会让下一个人以为这一列还在。

### 6.4 文档与基线

- `docs/baseline/PROJECT_BASELINE.md` §6：表清单删 `sk_shop_sets`、加 `sk_tool_accounts`；`sk_shops` 说明改为「店铺 + 账号」；邮件外键改 `shop_id`；§6「schema 演进」登记 `shop.main = v1`。稳态对象数预计仍为 **37 业务表 / 40 对象**（−1 +1），以实测 `grep` 为准。
- `CHANGELOG.md` `[Unreleased]` 写本轮变更（方案改写 + ADR-003 + 实施后的代码改动）。
- `docs/notes/2026-10-30-shop-account-merge-and-status.md`：记录「为什么开发期选择物理合并、代价是什么、迁移的不可逆点」；在 `docs/notes/README.md` 登记。
- `docs/README.md`：本计划行改成物理合并版；`decisions/` 增加 ADR-003；文档计数按 `find docs -name '*.md'` 当场订正。
- `docs/decisions/ADR-002-master-data-layer.md`：状态加「部分被 ADR-003 取代」；正文「`sk_shops` 是凭据无关身份层」的设计点标注不再成立，C1–C4 保留。

---

## 7. 实施阶段与门禁

| 阶段 | 内容 | 完成判据 |
|---|---|---|
| **P0 迁移与 schema** | `shop.main` v1 重建；工具账号表；企业支付宝列；邮件表重建；启动编排；`schema:smoke` 七场景 | 真库克隆上迁移成功；19 行 / 6+3+10；id 1–9 未变；工具账号 1 条；企业 3 家；邮件 3 条；`foreign_key_check` 干净；重跑幂等；原库未动 |
| **P1 契约与写入** | 合并 upsert / 局部更新 `upsertShop` / 删除保护 / 工具账号 CRUD / preload + types + ipc + DB_OPS | `tsc` / `vue-tsc` / `verify` / `ipc:shape:smoke` 绿；店铺与账号各写 1 条实跑；局部更新不清账号字段 |
| **P2 界面合并** | 店铺列表 + 联动筛选 + 合并编辑器 + 工具账号页 + 企业支付宝 + 店名归一收缩 | `master-data:ui` 真点两个来回（完整行 / 两种空态）；`goods:ui` / `today:ui` / `order-profit:ui` / `shipping-rate:ui` 无回归 |
| **P3 复制 / 批量 / 收尾** | 复制模板改工具账号、批量字段收缩、邮件 UI 字段、文档与基线回写、全仓残留清理 | `mail:smoke` / `mail:body:smoke` / `plugins:island:smoke`；`verify:docs`；`npm run build` |

每阶段结束跑：`npx tsc -p tsconfig.electron.json --noEmit` → `npx vue-tsc --noEmit` → `npm run lint` → `npm run verify` → `npm test`；动数据层的阶段加 `npm run schema:smoke`；动界面加对应 `*:ui`。

**真库验收必须用克隆**：`cp -cR "<真实 userData>" <临时目录>` 后跑 Electron，别用全新隔离目录（没有真实数据，测不出迁移问题），也绝不直接在真实 userData 上试迁移。

### 7.1 落地结果（2026-10-22，P0–P3 全部完成）

| 阶段 | 判据核对 | 与设计不符之处（以代码为准） |
|---|---|---|
| **P0** | ✅ 迁移前 `VACUUM` 副本上重放 `shop.main` v1：**19 行 = 6 双栖 + 3 纯店铺 + 10 纯账号**；店铺 id **1–9 原样**（`pl_shop_sku` / `pl_shop_items` / `sk_name_map` 引用不断链）、10 个纯账号拿续号 10–19；`sk_tool_accounts` **1 条**；邮件 `sk_mail_accounts` **3 条 + 851 封邮件一条不丢**（FK 已改指 `sk_shops(id)`）；`PRAGMA foreign_key_check` 干净；`ensureShopSchema()` 连跑三次**幂等**；原库未被这次重放写过 | ① 本域迁移**不走 `migrate()` 步骤表**（`PRAGMA foreign_keys=OFF` 在事务内无效），账本仍写 `sk_schema_migrations`；② 判据里的「`schema:smoke` 七场景」**落空**：`schema:smoke` 只覆盖走步骤表的域，本域两条老库场景落在 **`npm run shop:smoke`**（现 **39 项**）；③ 企业 **3 → 4**（一个账号自带企业名被认出来，不是造壳）；手机号/支付宝回填 **3 家**；`备注` 保留 2 条 = 无企业信息的账号**照旧没建企业壳**（§8 裁定成立） |
| **P1** | ✅ `tsc` / `vue-tsc` / `npm run verify`（IPC 三方契约 + 店铺必填字段 + 跨域边）/ `ipc:shape:smoke`（55 项）绿；店铺与账号各写 1 条实跑；`upsertShop` **局部更新不清账号列**由冒烟钉住 | 删除保护比设计多一层：`deleteShopAccount` 除 `pl_shop_sku` / `pl_shop_items` / `sk_name_map` 引用即拒绝外，**邮件账号 + 本地邮件缓存刻意级联删**（`ON DELETE CASCADE`），确认框用 `hasMailAccount` 明说 —— 不是疏漏 |
| **P2** | ✅ `master-data:ui` 真点两个来回（完整行 / 两种空态，宽 + 窄各一遍，收工复跑仍绿）、`today:ui` **全绿**（收工复跑：上一轮判"不可判"的两个来回已跑通）、`shipping-rate:ui` 绿（宽 + 窄）；五个下拉联动 + 选项计数（标准分面：其他筛选生效、本维度不生效）；新行默认带出上一次的企业 / 紫鸟 / ERP；`plugins:island:smoke` 3/3 岛握手 + 设置贡献 + 重启恢复 | `goods:ui` / `order-profit:ui` 在本域改动落地当时绿，**收工复跑转红**，红点全在**同机另一个工具正在写的「进价」那条线**上（`goods:ui`：「三条页签含进价」「只筛未维护进价的款」两条 + `vue-tsc` 报 `useProductList.ts:137 onlyMissingCost` 不在 `api.list` 入参类型里；`order-profit:ui`：`[cost-rates]` 段超时、缺「去维护」按钮）。与本域无关（店铺下拉取数、`shopSetId` 载荷都在 P2 当时验过），**不据它们判本域回归，也不替对方补** |
| **P3** | ✅ 复制模板已改工具账号维度（`store.ts` 模板条目含「工具账号：登录名 + 密码按需解密」）；批量字段收缩为 状态 / 企业 / 紫鸟 / ERP / 标签 / 备注（手机号与支付宝随企业表迁出，`BatchEditDrawer.vue` 头注释记录）；邮件 UI 字段 `shopSetId` → `shopId`；九处死键清理（见 §6.3）；`mail:inline:smoke` 绿；**`mail:body:smoke` 绿（16 项 + 一条显式「不适用」）**；`npm run build` 绿；`npm test` 45 文件 / 860 用例绿；`lint` 0 error；`verify` 三条全绿；`db:inventory` 40 对象 / 37 业务表（`sk_shop_sets` 不在册） | ① `mail:smoke` **需 `MAIL_USER`/`MAIL_PASS` 凭据**，本轮未跑（本域只改外键目标，未碰 IMAP 引擎）；② `mail:body:smoke` 此前"长时间无输出"**不是并发**：它把第二层 CSP 的来源**写死成 `ui-plugins/shop-accounts/index.html`**，那个岛 2026-10-14 已回收为内建模块、文件不存在 ⇒ 在 `app.whenReady()` **之前**抛错，而 Electron 遇 load 期异常只打一行 `App threw an error during load` **不会退出**，看着就是卡死。已改为按事实扫描（谁真的引用 `sk-mail://` 就读谁的 `index.html`；当前无岛嵌正文 ⇒ 显式打印"不适用"，不拿副本凑数）。同类死引用还有一处：夹具插 `sk_mail_accounts (shop_set_id, …)` → `no such column`，已改 `shop_id`；③ `verify:docs` 收工复跑剩 **1 条悬空**（`docs/features/PRODUCT_LIBRARY.md:74` 里那个成本维护面板的旧组件路径，对方那条未完成的搬迁所致：`git status` 显示它在索引里已改名、工作树又被删掉），**不在本域去猜它的新位置** |

**表计数净 0**（−`sk_shop_sets` + `sk_tool_accounts`）：基线 §6 的「40 个对象 / 37 业务表」不变，但手抄推算退役为 **`npm run db:inventory`**（真建库逐域数）。

**收工门禁快照（2026-10-22，同一棵工作树）**：绿 = `tsc -p tsconfig.electron.json` · `lint`（0 error / 525 warning）· `verify`（IPC 三方契约 + 店铺必填字段 + 跨域边）· `npm test`（45 文件 / 860 用例）· `build` · `schema:smoke` · `shop:smoke`(39) · `shop-item:smoke` · `product:sku:smoke` · `picking:smoke` · `style:smoke` · `order:smoke` · `ship-rate:smoke` · `product:smoke` · `ipc:shape:smoke`(55) · `mail:inline:smoke` · `mail:body:smoke` · `db:inventory` · `master-data:ui` · `today:ui` · `shipping-rate:ui` · `plugins:island:smoke`。
红 = `vue-tsc`（1 条，`onlyMissingCost`）、`verify:docs`（1 条，`CostPane.vue`）、`goods:ui`（2 条）、`order-profit:ui`（`[cost-rates]` 超时）—— **四条同因**：另一个工具正在写「进价 / 成本维护」那条线，改动落在本域之外（详见上表 P2/P3 行）。未跑 = `mail:smoke`（缺凭据）。

**2026-10-23 归属闭环（补记，不改上两行原貌）**：上面那四条红已由进价线自己收口——「基础数据 › 进价」整页退役（`CostPane` / `RatesPane` / `CostRatesPane` 三文件删除）、汇率面板一并退场、进价改在产品编辑抽屉维护并在产品列表内联展示（`p-cost` + 「只看缺进价」服务端筛选）。现 `vue-tsc` / `verify:docs` / `goods:ui` / `order-profit:ui` 四条全绿；`PRODUCT_LIBRARY.md` P4 行已改写为「退役记录 + 现状入口」。**本域代码未因此改动一行**。

---

## 8. 明确不做（过度设计清单）

| 不做 | 理由 |
|---|---|
| 保留 `sk_shop_sets` 或做 1:1 逻辑合并 | 用户裁定：开发期表要简单；单表省掉 join、并集、两套状态、空档案判断 |
| 用哨兵 `name_key` 绕过表级唯一约束 | 派生键变成身份键，名称归一 / 搜索 / 导出都会碰到假值；一次性重建更干净 |
| 为 10 个无店铺账号自动建同名店铺 | 账号不等于店铺；假店铺会污染订单归店 |
| 为只有手机号的账号建「未命名企业」壳 | 用户裁定：迁移不造企业，留待界面维护 |
| 多平台选择器 / 多平台字段扩展 | 当前只有速卖通；需要时再加，不预建通用模型 |
| 每店覆盖紫鸟 / ERP 密码 | 用户描述就是一个工具登录管多店；覆盖会让「工具账号」失去唯一真相 |
| 账号侧保留 `paused / banned / closed` 状态 | 真库全为 `active`；统一成启用/停用两态，细节写备注 |
| 通用筛选器 / 保存视图 / 多选筛选 | 19 行数据；五个下拉 + 搜索足够 |
| 分页 / 虚拟滚动 | 现有账号列表本来就是全量加载 |
| 模糊自动匹配企业 / 自动合并重名 | 已有三次「名称当身份」导致的静默失联教训；只做精确匹配 + 人工确认 |
| 删除名称映射 / 级联删订单商品 | 历史追溯要保留；有引用就拒绝删除 |
| 改造邮件同步引擎 / 正文协议 | 本轮只改外键与列名 |
| 拆分 `DB_OPS` 能力域 / 删除权限面 | 与本次数据重构是两个关注面 |
| 审计日志表 / 软删除框架 / ORM | 没有对应需求，成本远大于收益 |
| 为「以后可能多平台」预留 `platforms` 数组 | 已删；需要时按真实需求重建 |

---

## 9. 已拍板（2026-10-22）

1. **物理合并**：店铺与账号是同一张 `sk_shops` 的一行；`name` / `email` 至少一个非空。理由：开发期表要简单、好维护；数据完成后可人工整理。
2. **孤儿手机号不建企业壳**：2 个无企业信息的账号迁移后 `company_id = 0`，旧手机号 / 支付宝写进备注，由界面维护。
3. **删除保护**：有商品 / 商品清单 / 名称映射引用的店铺禁止删除，只允许「停用」。
4. **新建默认值**：企业 / 紫鸟 / ERP 默认带出上一次保存成功时的选择（记在 UI 态），可见可改；不自动复制密码。
5. **状态统一为 `active / archived`**：账号侧原有三态真库为 0，并入停用；具体原因写备注。
6. **迁移接受一次性重建两张表**：`sk_shops`（去掉表级唯一键）与 `sk_mail_accounts`（外键改指）。店铺 id 1–9 保持不变，下游零迁移。
7. **ADR-002 的「身份层与凭据物理分离」不再成立**：凭据仍加密、共享只读 op 仍不返回密码，安全边界保留在 API 层；架构裁定见 ADR-003，C1–C4 继续有效。
