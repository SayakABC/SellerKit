// extensions/shop-accounts/src/index.ts
// 「店铺账号管家」模块定义：以「店铺套（邮箱为主标识）」为单位维护店群账号
//（邮箱 + 店铺密码 / 邮箱密码 / 关联手机号 / 关联企业 / 关联支付宝 + 支付密码 / 紫鸟账号 + 密码 / ERP账号 + 密码 / 关联平台）。
// 注：账号数据落主进程 SQLite，敏感字段经 safeStorage 加密，均为宿主能力，故本包必须随宿主分发。

import type { ModuleDefinition } from '@/core/types';
import { meta } from './meta';
import ShopAccountsView from './ShopAccountsView.vue';
import { disposeMailInbox, ensureMailInbox } from './mailStore';

const definition: ModuleDefinition = {
  meta,
  view: ShopAccountsView,
  // 进入模块即初始化邮件库并启动自动轮询（未读徽标依赖统计）
  activate() {
    void ensureMailInbox();
  },
  // 停用模块时释放轮询定时器与同步事件订阅，避免后台空转
  deactivate() {
    disposeMailInbox();
  },
};

export default definition;
