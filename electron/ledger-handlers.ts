// electron/ledger-handlers.ts
// 「记账」域 IPC（P0 数据层；界面在 P1/P2 接入）。
//
//   ledger-db-ensure        幂等建表 / 迁移（视图首次激活时调用）
//   ledger-eligible-shops   期间内可参与分摊的店铺 + 被排除的及原因
//   ledger-category-list    科目列表（收/支各一套）
//   ledger-category-upsert  新建 / 改名 / 停用科目（builtin 不可删）
//   ledger-rule-list        分摊方案列表（房租 / 工资这类每月照抄）
//   ledger-rule-upsert      新建 / 更新分摊方案
//   ledger-entry-list       明细列表（期间 / 店铺 / 相关人 / 科目 / 结算状态筛选）
//   ledger-entry-get        单条详情（含分摊明细）
//   ledger-entry-upsert     新建 / 更新条目（公共条目必须带分摊，守恒断言在数据层）
//   ledger-entry-void       作废条目（不删行；已结算条目须先撤销结算）
//   ledger-entry-restore    恢复作废条目（void → active；被结算单占用则拒）
//   ledger-entries-void     批量作废（导入撤销；整批一个事务，逐条仍按「已结算不可作废」判）
//   ledger-name-resolve     文件里的相关人/科目/店铺名 → 库里 id（四态；归一与同名判定只在主进程）
//   ledger-entry-batch-create  Excel 批量导入：整批一个事务、只新增、逐行错误带「第 N 行：」
//   ledger-import-template  把渲染层生成的三张模板表画成 xlsx 存盘（取消 → `__canceled__`）
//   ledger-summary          汇总（店铺轴 / 科目轴 / 三项体检）
//   ledger-party-list       相关人列表
//   ledger-party-upsert     新建 / 改相关人
//   ledger-party-merge      合并相关人（未结算改挂 + 已结算留原处 + 残额兜底结转）
//   ledger-party-ledger     往来台账（应收/应付/净往来/已结算/未结清）
//   ledger-settle-create    创建结算单（金额由服务端按勾选条目求和，幂等由唯一索引兜底）
//   ledger-settle-list      结算单列表
//   ledger-settle-void      撤销结算（作废 + 结算行失活，条目恢复可结）
//   ledger-entry-repatch-preview  批量变更相关人的预演（选中条目的结算状态 / 涉及结算单 / 原人余额影响）
//   ledger-entry-repatch    批量变更相关人（三路：改挂 / 只改挂未结算 / 撤销结算后改挂）
//   ledger-shop-breakdown   单店取数（科目分布含公摊 + 该店承担的公摊条目）
//   ledger-export-excel     明细导出 xlsx（主进程画表存盘，业务口径全由渲染层算好传入）
//
// 入参在 preload 层已做形状消毒，本层再做业务口径校验（双防线，见 AGENTS.md §2.3）。

export {};

import { BrowserWindow, app, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  ensureLedgerSchema,
  eligibleShops,
  listCategories,
  upsertCategory,
  listAllocRules,
  upsertAllocRule,
  listEntries,
  getEntry,
  upsertEntry,
  voidEntry,
  voidEntries,
  restoreEntry,
  ledgerSummary,
  listParties,
  upsertParty,
  mergeParty,
  partyLedger,
  createSettlement,
  listSettlements,
  voidSettlement,
  repatchPreview,
  repatchEntries,
  shopBreakdown,
  resolveImportNames,
  batchCreateEntries,
  ALLOC_BASES,
  PARTY_KINDS,
} from './ledger-db';
import { buildLedgerWorkbook, buildLedgerTemplateWorkbook } from './ledger-xlsx';
import { normalizeIdList as idList } from './ledger-ids';
import { handle } from './ipc-util';

/** 正整数（0 / 负数 / 非数字 → 0，由数据层决定 0 是否合法） */
function int(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : 0;
}

/** 截断字符串（非字符串 → 空串） */
function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 仅在值合法时透传枚举，其余交给数据层按缺省处理 */
function pickEnum(v: unknown, allowed: readonly string[]): string | undefined {
  return typeof v === 'string' && allowed.includes(v) ? v : undefined;
}

export function registerLedgerHandlers(): void {
  handle('ledger-db-ensure', () => {
    ensureLedgerSchema();
    return { ok: true };
  });

  handle('ledger-eligible-shops', (payload: any) => eligibleShops(text(payload?.period, 7)));

  // ---- 科目 ----
  handle('ledger-category-list', (payload: any) => {
    const kind = pickEnum(payload?.kind, ['income', 'expense']) as 'income' | 'expense' | undefined;
    return listCategories(kind, payload?.includeArchived === true);
  });

  handle('ledger-category-upsert', (payload: any) =>
    upsertCategory({
      id: int(payload?.id),
      kind: text(payload?.kind, 20),
      name: text(payload?.name, 100),
      sort: payload?.sort === undefined ? undefined : int(payload.sort),
      archived: typeof payload?.archived === 'boolean' ? payload.archived : undefined,
    }),
  );

  // ---- 分摊方案 ----
  handle('ledger-rule-list', () => listAllocRules());

  handle('ledger-rule-upsert', (payload: any) =>
    upsertAllocRule({
      id: int(payload?.id),
      name: text(payload?.name, 100),
      basis: pickEnum(payload?.basis, ALLOC_BASES),
      shopIds: idList(payload?.shopIds),
      ratios: Array.isArray(payload?.ratios)
        ? payload.ratios.slice(0, 200).map((x: unknown) => int(x))
        : [],
      note: text(payload?.note, 2000),
    }),
  );

  // ---- 条目 ----
  handle('ledger-entry-list', (payload: any) =>
    listEntries({
      period: payload?.period ? text(payload.period, 7) : undefined,
      from: payload?.from ? text(payload.from, 10) : undefined,
      to: payload?.to ? text(payload.to, 10) : undefined,
      kind: pickEnum(payload?.kind, ['income', 'expense']),
      scope: pickEnum(payload?.scope, ['shop', 'shared']),
      shopId: int(payload?.shopId),
      partyId: int(payload?.partyId),
      categoryId: int(payload?.categoryId),
      settleStatus: pickEnum(payload?.settleStatus, ['all', 'settled', 'unsettled']),
      includeVoid: payload?.includeVoid === true,
      keyword: text(payload?.keyword, 100),
      limit: payload?.limit === undefined ? undefined : int(payload.limit),
      offset: payload?.offset === undefined ? undefined : int(payload.offset),
      includeAllocations: payload?.includeAllocations === true,
    }),
  );

  handle('ledger-entry-get', (payload: any) => getEntry(int(payload?.id)));

  handle('ledger-entry-upsert', (payload: any) => {
    const allocations = Array.isArray(payload?.allocations)
      ? payload.allocations.slice(0, 200).map((a: any) => ({
          shopId: int(a?.shopId),
          amountCents: int(a?.amountCents),
          ratioBp: int(a?.ratioBp),
        }))
      : undefined;
    return upsertEntry({
      id: int(payload?.id),
      bizDate: text(payload?.bizDate, 10),
      kind: pickEnum(payload?.kind, ['income', 'expense']),
      scope: pickEnum(payload?.scope, ['shop', 'shared']),
      shopId: int(payload?.shopId),
      partyId: int(payload?.partyId),
      categoryId: int(payload?.categoryId),
      // 金额为 0 时**不要**透传（数据层会把它当"非法金额"）；
      // 更新场景下 `undefined` 的语义是"保持原值"，传 0 会变成"改成 0 元"的误解。
      amountCents: int(payload?.amountCents) > 0 ? int(payload.amountCents) : undefined,
      basis: pickEnum(payload?.basis, ALLOC_BASES),
      ruleId: int(payload?.ruleId),
      method: text(payload?.method, 40),
      note: text(payload?.note, 2000),
      allocations,
    });
  });

  handle('ledger-entry-void', (payload: any) => voidEntry(int(payload?.id), text(payload?.reason, 200)));

  handle('ledger-entry-restore', (payload: any) => restoreEntry(int(payload?.id)));

  // 批量作废 = 「撤销本次导入」的唯一实现（界面没有第二个入口，规则只在 voidEntries 里一份）
  handle('ledger-entries-void', (payload: any) =>
    voidEntries(idList(payload?.ids), text(payload?.reason, 200)),
  );

  // ---- Excel 批量导入 ----
  // 名字 → 身份只在主进程判（`toNameKey` 与 `sk_shops`/`bk_*` 都在这侧），渲染层只消费四态。
  handle('ledger-name-resolve', (payload: any) =>
    resolveImportNames({
      party: Array.isArray(payload?.party) ? payload.party : [],
      category: Array.isArray(payload?.category) ? payload.category : [],
      shop: Array.isArray(payload?.shop) ? payload.shop : [],
    }),
  );

  // 整批一个事务、只新增：任何一行不合格全批回滚（半批落库=用户不知道哪些进了）
  handle('ledger-entry-batch-create', (payload: any) => {
    const list = Array.isArray(payload?.entries) ? payload.entries.slice(0, 2000) : [];
    if (!list.length) throw new Error('ledger-entry-batch-create: payload.entries 必须是非空数组');
    const entries = list.map((e: any) => {
      const allocations = Array.isArray(e?.allocations)
        ? e.allocations.slice(0, 200).map((a: any) => ({
            shopId: int(a?.shopId),
            amountCents: int(a?.amountCents),
            ratioBp: int(a?.ratioBp),
          }))
        : undefined;
      return {
        id: 0, // 导入永不更新已有条目：这条通道只新增
        // 用户 Excel 表里的行号：错误文案「第 N 行」必须指向他表里那一行（不是这批的第几条）
        rowNo: int(e?.rowNo),
        bizDate: text(e?.bizDate, 10),
        kind: pickEnum(e?.kind, ['income', 'expense']),
        scope: pickEnum(e?.scope, ['shop', 'shared']),
        shopId: int(e?.shopId),
        partyId: int(e?.partyId),
        categoryId: int(e?.categoryId),
        // 名字只在 id 为 0 时被主进程用到（找不到就建）；带 id 的行名字只是留痕
        partyName: text(e?.partyName, 100),
        categoryName: text(e?.categoryName, 100),
        amountCents: int(e?.amountCents),
        basis: pickEnum(e?.basis, ALLOC_BASES),
        ruleId: int(e?.ruleId),
        method: text(e?.method, 40),
        note: text(e?.note, 2000),
        allocations,
      };
    });
    return batchCreateEntries(entries);
  });

  // ---- 汇总 ----
  handle('ledger-summary', (payload: any) =>
    ledgerSummary({
      period: payload?.period ? text(payload.period, 7) : undefined,
      from: payload?.from ? text(payload.from, 10) : undefined,
      to: payload?.to ? text(payload.to, 10) : undefined,
    }),
  );

  // ---- 相关人 ----
  handle('ledger-party-list', (payload: any) =>
    listParties({
      includeArchived: payload?.includeArchived === true,
      keyword: text(payload?.keyword, 100),
    }),
  );

  handle('ledger-party-upsert', (payload: any) =>
    upsertParty({
      id: int(payload?.id),
      name: text(payload?.name, 100),
      kind: pickEnum(payload?.kind, PARTY_KINDS),
      phone: text(payload?.phone, 40),
      note: text(payload?.note, 2000),
      archived: typeof payload?.archived === 'boolean' ? payload.archived : undefined,
    }),
  );

  handle('ledger-party-merge', (payload: any) =>
    mergeParty({
      fromId: int(payload?.fromId),
      toId: int(payload?.toId),
      note: text(payload?.note, 2000),
    }),
  );

  handle('ledger-party-ledger', (payload: any) =>
    partyLedger({
      includeArchived: payload?.includeArchived === true,
      partyId: int(payload?.partyId),
    }),
  );

  // ---- 结算 ----
  handle('ledger-settle-create', (payload: any) =>
    createSettlement({
      partyId: int(payload?.partyId),
      settleDate: text(payload?.settleDate, 10),
      direction: pickEnum(payload?.direction, ['pay', 'receive', 'offset']),
      entryIds: idList(payload?.entryIds),
      method: text(payload?.method, 40),
      note: text(payload?.note, 2000),
    }),
  );

  handle('ledger-settle-list', (payload: any) => listSettlements(int(payload?.partyId)));

  handle('ledger-settle-void', (payload: any) =>
    voidSettlement(int(payload?.id), text(payload?.reason, 200)),
  );

  // ---- 批量变更相关人（三路） ----
  handle('ledger-entry-repatch-preview', (payload: any) =>
    repatchPreview({ entryIds: idList(payload?.entryIds) }),
  );

  handle('ledger-entry-repatch', (payload: any) =>
    repatchEntries({
      entryIds: idList(payload?.entryIds),
      toPartyId: int(payload?.toPartyId),
      mode: pickEnum(payload?.mode, ['move-all', 'move-unsettled', 'void-then-move']),
      reason: text(payload?.reason, 200),
    }),
  );

  // ---- 单店 ----
  handle('ledger-shop-breakdown', (payload: any) =>
    shopBreakdown({
      shopId: int(payload?.shopId),
      period: payload?.period ? text(payload.period, 7) : undefined,
      from: payload?.from ? text(payload.from, 10) : undefined,
      to: payload?.to ? text(payload.to, 10) : undefined,
    }),
  );

  // ---- 导出 ----
  handle('ledger-export-excel', async (payload: any) => {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows)) {
      throw new Error('ledger-export-excel: payload.rows 必须是数组');
    }
    const rows = payload.rows.slice(0, 5000).map((it: any) => ({
      bizDate: text(it?.bizDate, 10),
      kindLabel: text(it?.kindLabel, 10),
      scopeLabel: text(it?.scopeLabel, 40),
      shopLabel: text(it?.shopLabel, 60),
      partyName: text(it?.partyName, 100),
      categoryName: text(it?.categoryName, 100),
      amountCents: int(it?.amountCents),
      settleLabel: text(it?.settleLabel, 40),
      note: text(it?.note, 2000),
    }));
    if (!rows.length) throw new Error('没有可导出的行');

    const buffer = await buildLedgerWorkbook({
      title: text(payload?.title, 60) || '记账明细',
      periodLabel: text(payload?.periodLabel, 40),
      filterLabel: text(payload?.filterLabel, 200),
      rows,
      totalIncomeCents: int(payload?.totalIncomeCents),
      totalExpenseCents: int(payload?.totalExpenseCents),
      balanceCents: int(payload?.balanceCents),
    });

    const safe = (text(payload?.defaultName, 120) || '记账明细').replace(/[\\/:*?"<>|]/g, '_');
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const dialogOpts = {
      title: '导出记账明细',
      defaultPath: path.join(app.getPath('documents'), `${safe}.xlsx`),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, dialogOpts)
      : await dialog.showSaveDialog(dialogOpts);
    if (result.canceled || !result.filePath) throw new Error('__canceled__');
    fs.writeFileSync(result.filePath, buffer);
    return { filePath: result.filePath, rows: rows.length };
  });

  // ---- 导入模板下载 ----
  // 表的**内容**由渲染层生成（列定义与解析器同一份），本通道只画表 + 存盘 + 处理"取消不算失败"。
  handle('ledger-import-template', async (payload: any) => {
    const list = Array.isArray(payload?.sheets) ? payload.sheets.slice(0, 8) : [];
    if (!list.length) throw new Error('ledger-import-template: payload.sheets 必须是非空数组');
    const sheets = list.map((s: any) => ({
      name: text(s?.name, 31),
      rows: (Array.isArray(s?.rows) ? s.rows.slice(0, 2000) : []).map((r: any) =>
        (Array.isArray(r) ? r.slice(0, 40) : []).map((c: any) => String(c ?? '')).slice(0, 40),
      ),
      widths: (Array.isArray(s?.widths) ? s.widths.slice(0, 40) : []).map((w: any) => int(w)),
    }));

    const buffer = await buildLedgerTemplateWorkbook(sheets);
    const safe = (text(payload?.defaultName, 120) || '记账导入模板').replace(/[\\/:*?"<>|]/g, '_');
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const dialogOpts = {
      title: '下载记账导入模板',
      defaultPath: path.join(app.getPath('documents'), `${safe}.xlsx`),
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    };
    const result = win
      ? await dialog.showSaveDialog(win, dialogOpts)
      : await dialog.showSaveDialog(dialogOpts);
    if (result.canceled || !result.filePath) throw new Error('__canceled__');
    fs.writeFileSync(result.filePath, buffer);
    return { filePath: result.filePath, sheets: sheets.length };
  });
}

// 模块加载即注册（与其它 `*-handlers.ts` 的惯例一致：main.ts 只需 require 本文件）。
registerLedgerHandlers();
