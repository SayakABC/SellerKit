// src/core/plugin/host.ts
// Host API 渲染层 trusted 实现（Phase 2：收敛渲染层六域）。
// 依赖方向：core/services（ipc 服务层）+ core/network（默认 axios 实例），不直接触 window.electronAPI。
// 说明：本实现是"宿主能力面"的 trusted 实现，供插件上下文注入；
//       插件侧拿到的是接口端口（HostApi），权限门（Phase 3+）在桥层二次拦截。

import { writeClipboard } from '@/core/services/clipboard';
import { selectExcelFile, selectImageFile, selectTemplateFile } from '@/core/services/dialog';
import { ipc } from '@/core/services/ipc';
import { toast } from '@/core/services/toast';
import { useModuleStorage } from '@/core/services/storage';
import http from '@/core/network/request';
import type { DialogOptions, FilePayload, HostApi, PluginHttpOptions } from './sdk';

/** 当前应用的平台与版本信息（版本异步拉取一次，缓存于 getter 闭包） */
function createEnv(): HostApi['env'] {
  let version = '';
  void ipc
    .getAppVersion()
    .then((r) => {
      if (r.success && r.data) version = r.data;
    })
    .catch(() => {});
  return {
    isMac: ipc.platform === 'darwin',
    platform: ipc.platform,
    get version() {
      return version;
    },
  };
}

/** 解包 IPC 结果：失败转异常（插件侧统一 try/catch，避免吞错） */
async function unwrap<T>(p: Promise<{ success: boolean; data?: T; error?: string }>): Promise<T> {
  const r = await p;
  if (!r.success) throw new Error(r.error || '宿主调用失败');
  return r.data as T;
}

// 「TV 模版」业务域的入参消毒已抽到 ./sanitizeExcel.ts（纯函数、可单测）。
// 留在 host.ts 会让门禁测试必须 mock 整个宿主能力面（本文件依赖 ipc / axios / toast）；
// 抽出后本文件也回到 AGENTS §1「单文件 ≤ 300 行」门禁内（原 503 行）。
import {
  assertExcelBytes,
  ecStr,
  EC_MAX_HEADERS,
  rejectOverLimit,
  sanitizeRecords,
  sanitizeRules,
} from './sanitizeExcel';

/** 业务库白名单：domain → op → 宿主 IPC 调用（禁止放行任意 SQL） */
/** 统一的 Excel 导入（识别类型 + 落到对的表）；宿主 op 与内建页共用这一份实现 */
import * as importSheet from '@/core/services/importSheet';
import { openSettings as openSettingsEvent } from '@/core/services/shell';
import { loadSkuWeights } from '@/core/services/skuWeights';

/**
 * 运价表的**唯一读口**（M6 运价表回迁，2026-09-30）：宿主快照表里"当前那一份"
 * （`sr_rate_snapshots` 按生效日倒序取第一条）。
 *
 * 为什么放宿主：ADR-002 C3 要求主数据挂中立层 —— 运价表此前存在**可卸载的岛私有 storage** 里，
 * 宿主 op 每次靠岛把整张表传进来（`quote` / `quoteOrders` / `quoteProducts` 都收 `table` 参数）。
 * 那等于"真源在岛"，岛一卸载或两份不等就出两个数。现在岛只**显示**它，计价一律宿主自取。
 *
 * @returns `null` = 一条快照都没有 —— 调用方按"还没有运价表"处理（**不要**静默用空表算）。
 */
async function latestRateSnapshot(): Promise<{
  id: number;
  effectiveFrom: string;
  sourceFile: string;
  sheetName: string;
  table: unknown;
} | null> {
  const r = await ipc.shipRateSnapshotCalc({ limit: 1 });
  if (!r.success) throw new Error(r.error || '读取运价表快照失败');
  const row = (r.data?.rows ?? [])[0];
  if (!row || !row.table) return null;
  return {
    id: Number(row.id) || 0,
    effectiveFrom: String(row.effectiveFrom ?? ''),
    sourceFile: String(row.sourceFile ?? ''),
    sheetName: String(row.sheetName ?? ''),
    table: row.table,
  };
}

/** 计价前的取表：没有快照就报一句人能看懂的话（岛侧据此渲染空态） */
async function requireRateTable(): Promise<{ countries?: unknown[] }> {
  const snap = await latestRateSnapshot();
  const table = snap?.table as { countries?: unknown[] } | undefined;
  if (!table || !Array.isArray(table.countries)) {
    throw new Error('还没有运价表：先在「无忧物流运费」导入一次报价单');
  }
  return table;
}

const DB_OPS: Record<string, Record<string, (payload: any) => Promise<unknown>>> = {
  // 「TV 模版」业务域：Excel 解析与字段规则求值。
  //
  // 为什么这两件事必须在宿主做（与 shipping-rate 域的报价单解析同策略）：
  //  ① 岛运行在 iframe 里，文档 CSP 是 `script-src 'self'`（electron/plugin-ui-protocol.ts），
  //     **没有 'unsafe-eval'** —— 岛内既不能用 new Function 也不能用 eval，
  //     而规则引擎的 jsExpression 类型（用户可在设置页写代码）必须求值 JS 表达式；
  //  ② 岛是手写 ESM、无构建步骤，不该为读 Excel 打包一份 xlsx 依赖。
  // 复用宿主既有实现（@/core/services/excel、@/lib/fieldProcessor）→ 与内建版行为零漂移。
  'excel-copy': {
    // 按路径读取并解析（对话框选用、以及启动时重载上次文件）
    parseExcel: async (p) => {
      const r = await ipc.importExcelByPath(String(p?.filePath ?? ''));
      if (!r.success || !r.data) throw new Error(r.error || '读取 Excel 失败');
      // ① 配置类：体积由被选文件决定，超限即拒绝——否则整个文件会被读进内存再解析。
      assertExcelBytes(r.data.data);
      const { parseExcelBuffer } = await import('@/core/services/excel');
      const parsed = parseExcelBuffer(r.data.data);
      return { headers: parsed.headers, records: parsed.records ?? [] };
    },
    // 按字节解析（拖拽导入用：iframe 拿不到真实磁盘路径，只能把 ArrayBuffer 传过来）
    parseExcelBuffer: async (p) => {
      const buf = p?.data;
      if (!(buf instanceof ArrayBuffer))
        throw new Error('parseExcelBuffer: data 必须是 ArrayBuffer');
      assertExcelBytes(buf);
      const { parseExcelBuffer } = await import('@/core/services/excel');
      const parsed = parseExcelBuffer(buf);
      return { headers: parsed.headers, records: parsed.records ?? [] };
    },
    // 执行字段规则（衍生列），返回新记录 + 新列名 + 错误 + 规则哈希（岛侧用它判断规则是否变更）
    applyRules: async (p) => {
      const { applyFieldProcessor, computeRulesHash } = await import('@/lib/fieldProcessor');
      const rules = sanitizeRules(p?.rules);
      const { records, truncation } = sanitizeRecords(p?.records);
      const rawHeaders = Array.isArray(p?.headers) ? p.headers : [];
      // ① 配置类：原为静默丢尾部，用户只会看到"少了几列"而无任何提示 → 改明确报错。
      if (rawHeaders.length > EC_MAX_HEADERS) {
        rejectOverLimit('表头列数', rawHeaders.length, EC_MAX_HEADERS);
      }
      const headers = rawHeaders.map((h: unknown) => ecStr(h, 200)).filter(Boolean);
      const result = applyFieldProcessor(records as never, headers, rules as never);
      return {
        records: result.records,
        newHeaders: result.newHeaders,
        errors: result.errors,
        rulesHash: computeRulesHash(rules as never),
        // 数据类截断统计（新增字段，向后兼容：不读它的岛行为与改动前一致）
        truncation,
      };
    },
    // 读取模板文本文件（「导入模板文件」得到 content，无需岛侧再走一次 dialog）
    readTextFile: async (p) => unwrap(ipc.readFile(String(p?.filePath ?? ''))),
    // 读取宿主内置模板（把 template.txt 的当前内容同步进来）
    readDefaultTemplate: async () => {
      const filePath = await unwrap(ipc.getDefaultTemplatePath());
      if (!filePath) throw new Error('未找到内置模板路径');
      const f = await unwrap(ipc.readFile(filePath));
      return { filePath, content: f?.content ?? '' };
    },
    checkFileExists: async (p) => unwrap(ipc.checkFileExists(String(p?.filePath ?? ''))),
    saveTemplateFile: (p) =>
      unwrap(ipc.saveTemplate(String(p?.filePath ?? ''), String(p?.content ?? ''))),
  },

  'shop-accounts': {
    ensure: () => unwrap(ipc.shopAccountDbEnsure()),
    list: (p) => unwrap(ipc.shopAccountList(p && typeof p === 'object' ? p : undefined)),
    get: (p) => unwrap(ipc.shopAccountGet({ id: Number(p?.id) || 0 })),
    summary: () => unwrap(ipc.shopAccountSummary()),
    security: () => unwrap(ipc.shopAccountSecurity()),
    upsert: (p) => unwrap(ipc.shopAccountUpsert(p)),
    delete: (p) => unwrap(ipc.shopAccountDelete({ id: Number(p?.id) || 0 })),
    reveal: (p) => unwrap(ipc.shopAccountReveal({ id: Number(p?.id) || 0, field: p?.field })),
    batchUpdate: (p) => unwrap(ipc.shopAccountBatchUpdate(p)),
    // 企业管理（企业基本信息 + 欧代 / 土代 / 德国包装法合规资料）
    companyEnsure: () => unwrap(ipc.companyDbEnsure()),
    companyList: (p) => unwrap(ipc.companyList(p && typeof p === 'object' ? p : undefined)),
    companyGet: (p) => unwrap(ipc.companyGet({ id: Number(p?.id) || 0 })),
    companySummary: () => unwrap(ipc.companySummary()),
    companyUpsert: (p) => unwrap(ipc.companyUpsert(p)),
    companyDelete: (p) => unwrap(ipc.companyDelete({ id: Number(p?.id) || 0 })),
    companyProfileUpsert: (p) => unwrap(ipc.companyProfileUpsert(p)),
    companyProfileDelete: (p) => unwrap(ipc.companyProfileDelete({ id: Number(p?.id) || 0 })),
  },

  // ~~「产品库」岛的五个能力域~~ **整组已删（2026-10-01）** —— 原为 `product`（共享只读 8 op）、
  // `product-admin`（owner 写 10 op）、`product-image`（图片写 4 op）、`product-supplier`（厂家
  // 主数据 4 op）、`shop-products`（商品清单 6 op），合计 **32 op**。
  //
  // 为什么当初要拆：`security.ts` 的 `decidePermission` 对 db 能力**只按岛自报的 `domains` 与
  //   `actions` 放行，两者彼此独立** —— 把写 op 留在共享只读域里，"消费方只声明只读"就只能靠自觉。
  //   故写侧必须结构上单独成域（P3/P4 的既定动作）。
  // 为什么现在能删：拆域的唯一消费者是市场分发的 UI 岛 `ui-plugins/product-library`，该岛已整体
  //   下架、功能收回内建「货与成本」（`src/modules/goods/**`）。内建渲染层跑在**同进程信任域**，
  //   直接调 `ipc.*`、不经 `DB_OPS`，于是这 32 个 op 失去了**全部**消费者 → 按"死物可删"移除
  //   （同 2026-09-30 的 `picking` 域，见下方）。
  // 能力本身一行没丢：数据层 `electron/product-db.ts` / `product-handlers.ts` /
  //   `shop-product-db.ts` / `purchase-db.ts` 与全部 `ipc.*` 通道保持原样。将来真有岛要读写产品，
  //   再按 ADR-002 C4 的"只读子域 + owner 写子域"形态开回来（`src/modules/goods/api.ts` 里
  //   `ipc.*` 与 op 名的对应关系就是现成的映射表）。

  // ~~「拣货」只读域~~ **已删（2026-09-30，C2）**：它是 P5 为 order-insight 岛的「拣货」页签开的，
  // 那个页签在发布前撤回（入口唯一：拣货只有内建「拣货」页一个入口，见 `docs/plans/RESTRUCTURE_PLAN.md` 的 M3/C2）。
  // 域随之失去唯一消费者 → 按"死物可删"移除（能力本身没丢：内建页走 `ipc.pickingRows` + `@/lib/picking`，
  // 将来真有岛要消费，再按"只读子域 + 复用渲染层纯函数"的形态开回来，~20 行）。
  shop: {
    ensure: () => unwrap(ipc.shopDbEnsure()),
    list: (p) => unwrap(ipc.shopList(p && typeof p === 'object' ? p : undefined)),
    get: (p) => unwrap(ipc.shopGet({ id: Number(p?.id) || 0 })),
    upsert: (p) => unwrap(ipc.shopUpsert(p)),
    summary: () => unwrap(ipc.shopSummary()),
    unmapped: () => unwrap(ipc.shopUnmapped()),
    map: (p) =>
      unwrap(
        ipc.shopMap({
          raw: String(p?.raw ?? ''),
          refId: Number(p?.refId) || 0,
          ignored: p?.ignored === true,
          kind: p?.kind,
          note: p?.note,
        }),
      ),
    unmap: (p) => unwrap(ipc.shopUnmap({ raw: String(p?.raw ?? ''), kind: p?.kind })),
  },

  // ~~「订单归类」业务域~~ **已删（2026-10-05，岛整体下架）** —— 原 **37 op**（视觉指纹 /
  // 订单明细读写 / 图片下载·读图·缩略图（单条与合批）/ 孤立图清理 / Excel 解析与导出 /
  // 视觉识别 `analyze` / 处理队列 `oi_queue` 十个 / 款式库 `oi_styles` 六个 / 订单维护五个）。
  //
  // 为什么能删：它是市场分发的 UI 岛 `ui-plugins/order-insight` 的**独占**能力域 ——
  //   其余四个岛（`shop-accounts` / `excel-copy` / `shipping-rate` / `ae-profit`）的
  //   `manifest.capabilities` 都没有声明它。而该岛已整体下架：**五步发货台**
  //   （`src/modules/today/**` 的六个页签）在宿主里做完了它的全部**每日动作**，
  //   剩下的「识别库 / 透视 / 明细」不是每日动作、按裁量一并去掉。
  //   消费者归零 ⇒ 按"死物可删"移除（同 2026-09-30 的 `picking` 域、2026-10-01 的 `product*` 五域）。
  //   "宿主也在用这些表"**不构成保留理由**：内建页与宿主同进程、走自己的 `ipc.*`，
  //   结构上够不到 `DB_OPS`（该对象只经 `window.__sk` 桥暴露给 iframe 岛）。
  // 能力本身一行没丢：数据层 `electron/order-db.ts` / `order-handlers.ts`、视觉引擎
  //   `src/core/ai/**` 与全部 `ipc.order*` 通道**原样保留**；将来真有岛要消费，按 ADR-002 C4 的
  //   "只读子域"形态开回来（现成的映射表就是 `src/modules/today/classify.ts` 里 `ipc.*` 的用法）。
  //
  // ⚠️ 与**存储命名空间**是两件事，别顺手一起改：`useModuleStorage('order-insight')`
  //   （引擎配置 + 列映射）仍在用（宿主「设置 › 识别」写入、`src/modules/today/classify.ts` 读取）
  //   —— 那是**已落盘的用户数据键**，改名会让用户配好的 API Key 与列映射静默消失。

  // 「拿货对账」业务域：供应商 / 拿货单 / 付款 / 对账 / 待拿货缺口
  purchase: {
    ensure: () => unwrap(ipc.purchaseDbEnsure()),
    supplierList: () => unwrap(ipc.purchaseSupplierList()),
    supplierCreate: (p) => unwrap(ipc.purchaseSupplierCreate(p)),
    supplierUpdate: (p) => unwrap(ipc.purchaseSupplierUpdate(p)),
    supplierDelete: (p) => unwrap(ipc.purchaseSupplierDelete({ id: Number(p?.id) || 0 })),
    orderList: () => unwrap(ipc.purchaseOrderList()),
    orderGet: (p) => unwrap(ipc.purchaseOrderGet({ id: Number(p?.id) || 0 })),
    orderCreate: (p) => unwrap(ipc.purchaseOrderCreate(p)),
    orderUpdate: (p) => unwrap(ipc.purchaseOrderUpdate(p)),
    orderSubmit: (p) => unwrap(ipc.purchaseOrderSubmit({ id: Number(p?.id) || 0 })),
    orderDelete: (p) => unwrap(ipc.purchaseOrderDelete({ id: Number(p?.id) || 0 })),
    paymentList: (p) => unwrap(ipc.purchasePaymentList(p && typeof p === 'object' ? p : {})),
    paymentAdd: (p) => unwrap(ipc.purchasePaymentAdd(p)),
    paymentDelete: (p) => unwrap(ipc.purchasePaymentDelete({ id: Number(p?.id) || 0 })),
    reconciliation: (p) => unwrap(ipc.purchaseReconciliation(p && typeof p === 'object' ? p : {})),
    outstanding: () => unwrap(ipc.purchaseOutstanding()),
    ignoreAdd: (p) => unwrap(ipc.purchaseIgnoreAdd(p)),
    ignoreRemove: (p) => unwrap(ipc.purchaseIgnoreRemove(p)),
    ignoreList: () => unwrap(ipc.purchaseIgnoreList()),
    priceHistory: (p) => unwrap(ipc.purchasePriceHistory(p && typeof p === 'object' ? p : {})),
    shopAllocation: (p) => unwrap(ipc.purchaseShopAllocation(p && typeof p === 'object' ? p : {})),
    shopAllocationDetail: (p) =>
      unwrap(ipc.purchaseShopAllocationDetail(p && typeof p === 'object' ? p : {})),
    exportExcel: (p) => unwrap(ipc.purchaseExportExcel(p)),
    // D3 单向通道：向「利润追踪」导出只读拿货成本快照
    costSnapshot: () => unwrap(ipc.purchaseCostSnapshot()),
  },

  // 「利润追踪」业务域：AE 订单明细 / 利润引擎 / 成本衔接 / 汇率（只读为主，写入仅语义化操作）
  ae: {
    ensure: () => unwrap(ipc.aeDbEnsure()),
    receiverStatus: () => unwrap(ipc.aeReceiverStatus()),
    orderList: (p) =>
      unwrap(
        ipc.aeOrderList({
          offset: Number.isFinite(Number(p?.offset))
            ? Math.max(0, Math.trunc(Number(p.offset)))
            : 0,
          limit: Math.min(Math.max(Number(p?.limit) || 50, 1), 200),
          search: typeof p?.search === 'string' ? p.search.slice(0, 120) : '',
        })
      ),
    summary: () => unwrap(ipc.aeSummary()),
    profitStats: (p) =>
      unwrap(
        ipc.aeProfitStats({
          granularity: p?.granularity === 'day' ? 'day' : 'month',
          rangeDays: (() => {
            const n = Number(p?.rangeDays);
            if (!Number.isFinite(n)) return 90;
            return Math.min(Math.max(Math.trunc(n), 1), 1095);
          })(),
        })
      ),
    costMapList: () => unwrap(ipc.aeCostMapList()),
    costMapImport: (p) =>
      unwrap(
        ipc.aeCostMapImport({
          items: (Array.isArray(p?.items) ? p.items : []).slice(0, 5000).map((it: any) => ({
            styleCode: String(it?.styleCode ?? '').slice(0, 64),
            styleName: it?.styleName == null ? '' : String(it.styleName).slice(0, 200),
            unitPriceCents: Number.isFinite(Number(it?.unitPriceCents))
              ? Math.trunc(Number(it.unitPriceCents))
              : 0,
            sampleCount: Number.isFinite(Number(it?.sampleCount))
              ? Math.trunc(Number(it.sampleCount))
              : 0,
            lastBizDate: it?.lastBizDate == null ? '' : String(it.lastBizDate).slice(0, 32),
          })),
        })
      ),
    rateList: () => unwrap(ipc.aeRateList()),
    rateUpsert: (p) =>
      unwrap(
        ipc.aeRateUpsert({
          fromCurrency: String(p?.fromCurrency ?? '')
            .toUpperCase()
            .slice(0, 8),
          rateToCny: Number.isFinite(Number(p?.rateToCny)) ? Number(p.rateToCny) : 0,
        })
      ),
  },

  // 「无忧物流运费」业务域：读报价单 Excel → 归一化运价表；按克重算各国运费。
  //
  // 为什么解析与计价都必须在宿主（与 excel-copy:parseExcel 同策略）：
  //   ① 岛运行在 iframe 里，文档 CSP 是 `script-src 'self'`（electron/plugin-ui-protocol.ts），
  //      **没有 unsafe-eval**；岛也是手写 ESM、无构建步骤，不该为读 Excel 打包一份 xlsx；
  //   ② 报价单把 17 段列结构互不相同的价卡拼在同一张 sheet 上
  //      （见 docs/plans/SHIPPING_RATE_ISLAND_PLAN.md §1），归一化 + 取整口径收在
  //      @/lib/shipRate 与 @/lib/shipRateQuote 里，两头各写一份必然漂移。
  // 因此岛的职责被压到最小：选文件 → 调 op → 渲染返回值。
  'shipping-rate': {
    // 读报价单并归一化。除了 table，还回 sheetNames / picked / candidates ——
    // 岛的"换工作表"下拉与"导入失败后手动指定"都靠它们。
    //
    // ⚠️ 这里**不再回落到第一个 sheet**（旧写法 `want ? … : sheetNames[0]`）。
    //    报价单工作簿是 21 张 sheet 拼在一本里，第一张是「目录」；目标表在第 10 张。
    //    旧的回落写法让"导入运价表"必失败，还把原因误报成「该 sheet 不是报价单结构」——
    //    用户看到的是"数据有问题"，实际是"读错了工作表"。
    // 运价表解析 + 宿主留档（实现单源在 `core/services/importSheet`：内建导入入口与岛共用一份，
    // 免得「同一份报价单在两条路径解析出两张表」）。返回形状保持不变（岛按它渲染候选与告警）。
    parseRateSheet: async (p) =>
      importSheet.importRateSheet(
        { filePath: String(p?.filePath ?? '') },
        { sheetName: ecStr(p?.sheetName, 120), prefer: ecStr(p?.prefer, 120) },
      ),

    // 当前运价表（**岛侧显示用**）：宿主快照里生效日最新的那一份，含来源文件/工作表。
    // 岛不再自己存表 —— 它拿这份只为渲染「国家运价 / 档位 / 告警」，计价一律由宿主自取。
    // `null` = 还没有任何运价表（岛渲染空态，别拿空表去算）。
    rateCurrent: async () => latestRateSnapshot(),

    // 一次性**迁移**口：把岛私有 storage 里的旧表交给宿主快照（M6 回迁）。
    // 只给"升级后第一次打开"用；宿主按内容 sha256 去重，重复调用是空操作。
    // 稳态下岛**不写**运价表 —— 导入走 parseRateSheet（宿主自己留档）。
    rateAdopt: async (p) =>
      unwrap(
        ipc.shipRateSnapshotSave({
          table: p?.table,
          sourceFile: ecStr(p?.sourceFile, 500),
          sheetName: ecStr(p?.sheetName, 200),
        }),
      ),

    // 按克重算全表（一次调用拿全部国家的结果；岛侧不做任何算术）。
    // 表由**宿主自取**当前快照（M6 起不再由岛传入）。
    quote: async (p) => {
      const table = await requireRateTable();
      const grams = Number(p?.grams);
      if (!Number.isFinite(grams) || grams <= 0) throw new Error('quote: 克重必须是正数');
      const { quoteAll, isCategory } = await import('@/lib/shipRateQuote');
      const category = isCategory(p?.category) ? p.category : 'auto';
      return {
        grams: Math.round(grams),
        results: quoteAll(table as never, grams, {
          category,
          variant: ecStr(p?.variant, 40),
          rounding: p?.rounding === 'ceil' ? 'ceil' : 'round',
        }),
      };
    },

    // ---- 按订单算运费（SHIPPING_RATE_ISLAND_PLAN §8 的数据衔接）----
    //
    // ⚠️ 2026-10-01：**「商品信息 Excel → 商品ID 克重」那条链已整条删除**（用户领域裁定：
    //    克重是 SKU 属性，商品ID 上没有克重）。原 `importProductWeights` / `productWeightStats` 两个 op
    //    随之退场；本域的重量来源只剩一处 —— 产品库 `pl_variants.weight_g`（按款×色×码）。

    // 逐单试算：订单原始行（宿主自取，最小投影）→ 提取 收货国家 + 款色码 → 联 SKU 克重 → 批量计价。
    // 运价表同样**宿主自取**（M6 起不再由岛传入）。
    // 返回的逐单结果只含紧凑字段；raw_fields 大载荷到宿主为止，不过岛。
    quoteOrders: async (p) => {
      const table = await requireRateTable();
      const limit =
        typeof p?.limit === 'number' && Number.isFinite(p.limit)
          ? Math.min(Math.max(Math.round(p.limit), 1), 2000)
          : 500;
      const r = await ipc.orderShippingRows({ limit });
      if (!r.success) throw new Error(r.error || '读取订单失败');
      const { extractShipping, quoteOrders: quoteOrdersImpl } = await import('@/lib/shipRateOrders');
      const { isCategory } = await import('@/lib/shipRateQuote');

      const extracted = (Array.isArray(r.data) ? r.data : []).map((row) => ({
        id: Number(row?.id) || 0,
        orderNo: String(row?.orderNo ?? ''),
        ...extractShipping(row?.rawFields ?? {}),
      }));
      // 克重：**只从产品库 SKU 表取**（与「算钱」「发货台」同一份判定 `resolveWeightG`）。
      // 订单行只要识别出了款色码就能联上；识别不出的行如实报「缺重量」（reasonClass=noWeight）。
      const rowsFull = Array.isArray(r.data) ? r.data : [];
      const { resolveWeightG } = await import('@/lib/orderCost');
      const skuWeights = await loadSkuWeights();

      const input = rowsFull.map((row, i) => {
        const ex = extracted[i];
        return {
          id: ex.id,
          orderNo: ex.orderNo,
          country: ex.country,
          itemId: ex.itemId,
          weightG: resolveWeightG(
            {
              styleCode: (row as { styleCode?: unknown })?.styleCode,
              color: (row as { color?: unknown })?.color,
              size: (row as { size?: unknown })?.size,
            },
            skuWeights,
          ),
        };
      });
      const category = isCategory(p?.category) ? p.category : 'auto';
      const result = quoteOrdersImpl(table as never, input, {
        category,
        rounding: p?.rounding === 'ceil' ? 'ceil' : 'round',
      });
      return result;
    },

    // 按产品试算：产品库（pl_products + pl_variants 克重）× 用户点名的目的国 → 逐 SKU 运费。
    //   · 重量锚点 = 产品库 SKU 子表（`pl_variants.weight_g`）—— **全应用唯一的克重来源**
    //     （2026-10-01 起；「按订单试算」也同样读它，两边不再各读一张表）。
    //   · 目的国由岛从运价表国家下拉里**点名**传入（与 parseRateSheet 的 sheetName 同语义：
    //     严格按点名解析，表里没有就报错，不静默改判）。
    //   · 款式没建 SKU / SKU 没填克重 → 各自成行报「未维护克重」，与「无价」「拒算」分开计数。
    quoteProducts: async (p) => {
      const table = await requireRateTable();
      const country = ecStr(p?.country, 80);
      if (!country) throw new Error('quoteProducts: 请指定目的国家/地区');
      const search = ecStr(p?.search, 200);
      const cap =
        typeof p?.limit === 'number' && Number.isFinite(p.limit)
          ? Math.min(Math.max(Math.round(p.limit), 1), 2000)
          : 1000;

      // 产品分页拉全（listProducts 单页上限 500；productIds 进 variantList 前还要再分批）
      const products: Array<{ id: number; code: string; name: string }> = [];
      for (let offset = 0; offset < cap; offset += 500) {
        const r = await ipc.productList({ search, status: '', offset, limit: Math.min(500, cap - offset) });
        if (!r.success) throw new Error(r.error || '读取产品库失败');
        const batch = r.data?.rows ?? [];
        for (const it of batch) {
          products.push({ id: Number(it?.id) || 0, code: String(it?.code ?? ''), name: String(it?.name ?? '') });
        }
        if (batch.length < 500 || products.length >= (r.data?.total ?? 0)) break;
      }

      // SKU 分批拉全（IN 列表 500 一批，与 orderShippingRows 的 id 切片同口径）
      const variants: Array<{ productId: number; color: string; size: string; name: string; weightG: number }> = [];
      for (let i = 0; i < products.length; i += 500) {
        const v = await ipc.productVariantList({ productIds: products.slice(i, i + 500).map((x) => x.id) });
        if (!v.success) throw new Error(v.error || '读取 SKU 失败');
        for (const it of v.data?.rows ?? []) {
          variants.push({
            productId: Number(it?.productId) || 0,
            color: String(it?.color ?? ''),
            size: String(it?.size ?? ''),
            name: String(it?.name ?? ''),
            weightG: Number(it?.weightG) || 0,
          });
        }
      }

      // 组装计价行：有 SKU 的按 SKU 展开（SKU 标签 = '颜色 尺码'，老数据回落 name）；
      // 没建 SKU 的款式单独成行（skuLabel 空串 = 纯款式行），重量置 null 让纯函数报「未维护克重」。
      const byProduct = new Map<number, typeof variants>();
      for (const v of variants) {
        const list = byProduct.get(v.productId) ?? [];
        list.push(v);
        byProduct.set(v.productId, list);
      }
      const items = products.flatMap((pr) => {
        const vs = byProduct.get(pr.id) ?? [];
        if (!vs.length) return [{ productId: pr.id, code: pr.code, name: pr.name, skuLabel: '', weightG: null }];
        return vs.map((v) => ({
          productId: pr.id,
          code: pr.code,
          name: pr.name,
          skuLabel: [v.color, v.size].filter(Boolean).join(' ') || v.name,
          weightG: v.weightG > 0 ? v.weightG : null,
        }));
      });

      const { quoteProducts: quoteProductsImpl } = await import('@/lib/shipRateProducts');
      const { isCategory } = await import('@/lib/shipRateQuote');
      const category = isCategory(p?.category) ? p.category : 'auto';
      return quoteProductsImpl(table as never, country, items, {
        category,
        rounding: p?.rounding === 'ceil' ? 'ceil' : 'round',
      });
    },
  },
};

/** 邮件白名单（只读 IMAP 语义；凭据与账号维护由宿主完成） */
const MAIL_OPS: Record<string, (payload: any) => Promise<unknown>> = {
  ensure: () => unwrap(ipc.mailDbEnsure()),
  stats: () => unwrap(ipc.mailStats()),
  accountList: () => unwrap(ipc.mailAccountList()),
  accountUpsert: (p) => unwrap(ipc.mailAccountUpsert(p)),
  accountDelete: (p) => unwrap(ipc.mailAccountDelete({ id: Number(p?.id) || 0 })),
  accountTest: (p) => unwrap(ipc.mailAccountTest(p)),
  syncNow: (p) =>
    unwrap(
      ipc.mailSyncNow(p?.accountId == null ? undefined : { accountId: Number(p.accountId) || 0 })
    ),
  syncCancel: (p) => unwrap(ipc.mailSyncCancel({ accountId: Number(p?.accountId) || 0 })),
  syncState: () => unwrap(ipc.mailSyncState()),
  messagesList: (p) => unwrap(ipc.mailMessagesList(p && typeof p === 'object' ? p : undefined)),
  messageGet: (p) => unwrap(ipc.mailMessageGet({ id: Number(p?.id) || 0 })),
  messageRead: (p) => unwrap(ipc.mailMessageRead(p)),
  bodyFetch: (p) =>
    unwrap(
      ipc.mailBodyFetch({
        messageId: Number(p?.messageId ?? p?.id) || 0,
        accountId: p?.accountId == null ? undefined : Number(p.accountId) || 0,
      })
    ),
  attachmentSave: (p) =>
    unwrap(
      ipc.mailAttachmentSave({
        messageId: Number(p?.messageId ?? p?.id) || 0,
        attachmentId: Number(p?.attachmentId) || 0,
      })
    ),
  attachmentPreview: (p) =>
    unwrap(
      ipc.mailAttachmentPreview({
        messageId: Number(p?.messageId ?? p?.id) || 0,
        attachmentId: Number(p?.attachmentId) || 0,
      })
    ),
  attachmentOpen: (p) =>
    unwrap(
      ipc.mailAttachmentOpen({
        messageId: Number(p?.messageId ?? p?.id) || 0,
        attachmentId: Number(p?.attachmentId) || 0,
      })
    ),
  foldersList: (p) => unwrap(ipc.mailFoldersList({ accountId: Number(p?.accountId) || 0 })),
  cacheStatus: () => unwrap(ipc.mailCacheStatus()),
  cacheClear: () => unwrap(ipc.mailCacheClear()),
  cacheOpen: () => unwrap(ipc.mailCacheOpen()),
  ftsStatus: () => unwrap(ipc.mailFtsStatus()),
  ftsRebuild: () => unwrap(ipc.mailFtsRebuild()),
  purge: (p) => unwrap(ipc.mailPurge(p && typeof p === 'object' ? p : undefined)),
  providers: () => unwrap(ipc.mailProviderList()),
};

/**
 * 创建 HostApi 渲染层 trusted 实现。
 * storage 收敛为命名空间持久化（modules.<ns>，复用 useModuleStorage 底层 IPC）；
 * db/mail 收敛为"白名单 domain + op"（不放行任意 SQL / 不接触凭据）。
 */
export function createHostApi(): HostApi {
  const env = createEnv();

  const host: HostApi = {
    storage: {
      async load<T>(ns: string): Promise<T | undefined> {
        // 底层存储按命名空间返回 Partial 对象；宿主层显式收窄为 T（命名空间即记录对象）
        const data = await useModuleStorage(ns).load();
        return data === null || data === undefined ? undefined : (data as unknown as T);
      },
      async save<T>(ns: string, v: T): Promise<void> {
        await useModuleStorage(ns).save(v as Record<string, unknown>);
      },
      async clear(ns: string): Promise<void> {
        await useModuleStorage(ns).clear();
      },
    },
    clipboard: {
      async writeText(text: string): Promise<void> {
        const ok = await writeClipboard(text);
        if (!ok) throw new Error('clipboard write rejected by host');
      },
    },
    http: {
      async get<T>(url: string, opts?: PluginHttpOptions): Promise<T> {
        const res = await http.get<T>(url, opts);
        return res.data as T;
      },
      async post<T>(url: string, body?: unknown, opts?: PluginHttpOptions): Promise<T> {
        const res = await http.post<T>(url, body, opts);
        return res.data as T;
      },
    },
    dialog: {
      async openFile(opts: DialogOptions): Promise<FilePayload | null> {
        if (opts.kind === 'excel') {
          const f = await selectExcelFile();
          if (!f) return null;
          return { kind: 'excel', filePath: f.filePath, data: f.data };
        }
        if (opts.kind === 'image') {
          const f = await selectImageFile();
          if (!f) return null;
          return { kind: 'image', filePath: f.filePath };
        }
        if (opts.kind === 'template') {
          const f = await selectTemplateFile();
          if (!f) return null;
          return { kind: 'template', filePath: f.filePath, content: f.content };
        }
        const r = await ipc.selectDirectory();
        if (!r.success || !r.data) return null;
        return { kind: 'directory', filePath: r.data };
      },
    },
    ui: {
      openSettings(category?: string, tab?: string): void {
        // 对接 AppShell 已监听的 open-settings 事件（事件名只在 core/services/shell.ts 写一次）
        openSettingsEvent(category, tab);
      },
      notify(o: { kind: 'success' | 'error' | 'info'; text: string }): void {
        toast(o.text, o.kind);
      },
    },
    db: {
      async call<T>(domain: string, op: string, payload?: unknown): Promise<T> {
        const handler = DB_OPS[String(domain || '')]?.[String(op || '')];
        if (!handler) throw new Error(`db 操作未登记: ${String(domain)}.${String(op)}`);
        return (await handler(payload)) as T;
      },
    },
    secrets: {
      // 只暴露"宿主安全存储是否可用"；密文本体永不经过插件（读写经 db 的宿主业务操作完成）
      async status(): Promise<{ secureStorage: boolean }> {
        const r = await ipc.shopAccountSecurity();
        return { secureStorage: !!r.success && !!r.data?.secureStorage };
      },
    },
    mail: {
      async call<T>(op: string, payload?: unknown): Promise<T> {
        const handler = MAIL_OPS[String(op || '')];
        if (!handler) throw new Error(`mail 操作未登记: ${String(op)}`);
        return (await handler(payload)) as T;
      },
    },
    env,
  };

  return host;
}
