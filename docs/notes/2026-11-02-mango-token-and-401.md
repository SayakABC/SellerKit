# 芒果推送 401：默认 Token 的两处契约（2026-11-02）

## 结论

1. **扩展的默认 Token 必须逐字等于宿主的默认 Token**（`sk-ae-dev-token`，见 `electron/ae-receiver.ts` 的
   `TOKEN`）。扩展侧 `DEFAULTS.token` / popup 的 `DEFAULT_TOKEN` 两处都写了这条注释 —— 对不上就是
   **装好即 401**，而两边都不会报"配置不同步"，只会表现为"推送失败"。
2. **`chrome.storage` 里的空 Token 一律回落默认值**。这个字段里的 `''` 从来不是"我要清空"，是"没填过"
   （旧版默认值就是空串，点过一次「保存」就把它落了盘）。`{...DEFAULTS, ...stored}` 会被这条空串覆盖，
   所以**光改默认值修不好已经存过配置的机器**。
3. **错误提示不许指向宿主里并不存在的页面**。401 原提示写「去 SellerKit『采集端』页复制 Token」，
   而宿主渲染层**没有这个页面**（`grep -rn "采集端" src/` 只命中注释）—— 用户照做无处可复制，
   401 就成了一条无法自救的错误（`AGENTS.md` 的"提示不是入口"正是拦这个）。
4. **诊断手法**：往 `/mango/ingest` 发一个 **schema 故意错**的帧。
   token 对 ⇒ 400（`不支持的 schema`）；token 错 ⇒ 401。**400 与 401 一起把"宿主拒了默认值"和
   "扩展发的不是默认值"分开了**，不用去翻任一方的配置。

## 取证

```bash
# ① 宿主这侧：默认 Token 是有效的（400 = 已过 Token 关，只是 schema 不认识）
curl -s -o /tmp/x -w '%{http_code}\n' -X POST http://127.0.0.1:46211/mango/ingest \
  -H 'Content-Type: application/json' -H 'X-Ae-Token: sk-ae-dev-token' -d '{"schema":"bogus"}'
# 400 / {"ok":false,"error":"不支持的 schema：bogus（支持 mango-order/v1）"}

# ② 扩展这侧：默认值为空的证据（修复前）
git -C ~/work/work/ai/SellerKitExtensions show HEAD:extensions/mango-order/src/background.js | grep -n "token:"
# 21:  token: '',
```

- 修复：`SellerKitExtensions` 的 `SellerKitExtensions/extensions/mango-order/src/background.js`
  （`DEFAULTS.token` + `normalizeCfg` + 401 hint）、`SellerKitExtensions/extensions/mango-order/src/popup.js`
  （`DEFAULT_TOKEN` + `loadCfg` 回落 + 保存回落）、`SellerKitExtensions/extensions/mango-order/src/popup.html`（字段文案）、
  `SellerKitExtensions/extensions/mango-order/README.md`（安装第 4 步）、
  `SellerKitExtensions/extensions/mango-order/manifest.json`（1.1.0 → **1.1.1**）。
- 判据：`npm run test:mango` 里的新文件 `SellerKitExtensions/tests/mango-push-token.test.mjs`（5 组）——
  默认值真的出现在 `X-Ae-Token` / storage 空串回落 / 自定义值原样（只去首尾空白）/ 401 hint 含默认值与
  `AE_RECEIVER_TOKEN` 且**不含**「采集端页」/ 两处常量逐字一致。
- 变异：把 `DEFAULTS.token` 改回 `''` ⇒ 测试当场红
  （`默认 Token 必须等于宿主默认值 sk-ae-dev-token，实际 ""`），改回后 5 组全绿。
- 用户侧生效方式：`chrome://extensions` 里对本扩展点**重新加载**（版本号变成 1.1.1 即确认）。

## 遗留

- 宿主界面**不显示** Token：`getAeReceiverStatus()` 没有该字段，`PoolPane` 的「复制接入信息」curl 里
  还硬编码了默认值。默认值已让"装上即能用"成立；只有用 `AE_RECEIVER_TOKEN` 改过环境变量的人需要
  自己知道那个值。将来若要在宿主里显示/复制，数据源就是在 `getAeReceiverStatus()` 加 `token`。
- 同一类契约还有一处：宿主 `PoolPane.copyItemsInfo` 里的 curl 样例 Token 是写死的 —— 改环境变量后
  那段样例会失真（同属"两处常量必须一致"家族，未修，见上一条）。

相关：[芒果采集与 POD 图案域结论](2026-11-01-mango-collect-and-pod-conclusions.md) ·
`docs/plans/MANGO_INGEST_AND_POD_PLAN.md` 的「M1 补记（2026-11-02）」。
