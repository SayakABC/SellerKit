// electron/podImageKey.ts
// **图键**的纯函数层（零依赖、零副作用：只做字符串解析，不碰网络/文件/SQLite）。
//
// 为什么单独成文件：这是「一链接多图同名色」（下称**色名塌陷**）时唯一能把两个 SKU 分开的
// 确定性证据。真库实测 7/71 链接出现塌陷（`Color` 全写 `Picture color`，每个图各不相同），
// 涉及 50 个槽位 —— 这 50 个槽位靠色名永远分不开，绑错就是**整批错印**。
//
// 键取 URL 里的**图 ID 段**（`/kf/S3f2a...jpg` 的 `S3f2a...`），不取整串 URL：
//   · 同一张图在 CDN 上有多种形态（签名查询串 `?x-oss-process=...`、缩略图后缀
//     `xxx.jpg_220x220.jpg`、http/https、不同域名片段）⇒ 比整串 URL 会"明明是同一张图却对不上"；
//   · 图 ID 是**平台侧稳定**的（重新上传才会变），且与尺寸/签名无关。
//
// ⚠️ **不动 hash 段**。有些图 URL 带 `#` 片段，剥掉 `#` 之后的内容属于"确定不属于图本身"，
// 但**不要试图把 hash 归一化成一个值** —— 我们不知道它是什么（可能是 CDN 的分片标识），
// 猜错就会把两张不同的图并成一个键。宁可两张图不同键（多一个待绑槽位），不可同键（错印）。
//
// 为什么不做小写折叠：AE 图床的文件名大小写敏感（与 `shopSku.normImageUrl` 同一条纪律）。
// `S3f2a` 与 `s3f2a` 在 CDN 上可能是两张图，折叠就是制造假命中。

/**
 * 图 URL → 图键。认不出返回 `''`（**不是**返回整串 URL —— 那会让"没认出来"和"认出来了"
 * 长得一样，塌陷链接的判别就会静默退化成"用整串 URL 当键"，签名一变键就变）。
 *
 * 认的形式（实测四种域名都出现过）：
 *   `https://ae01.alicdn.com/kf/S3f2a1b.jpg`
 *   `//ae01.alicdn.com/kf/S3f2a1b.jpg_220x220.jpg`
 *   `https://img.alicdn.com/kf/S3f2a1b.png?x-oss-process=image/resize,w_100`
 *   `https://ae01.alicdn.com/kf/S3f2a1b.webp#frag`
 * 只认 `/kf/<id>.<ext>`：`/kf/` 之外（如店铺 logo `/kf/` 以外的路径、买家秀图）一律不认。
 */
export function imageKeyOf(url: unknown): string {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return '';
  // 先剥查询串与 hash（`?`/`#` 及其后全部属于传输/展示参数，不属于图的身份）
  const cut = s.search(/[?#]/);
  const bare = cut >= 0 ? s.slice(0, cut) : s;
  // 定位 `/kf/`（图床的文件目录；`/kf/` 之外的路径不是商品图）
  const at = bare.indexOf('/kf/');
  if (at < 0) return '';
  const rest = bare.slice(at + 4);
  // 取**第一个点之前**的部分作图 ID —— 这样 `xxx.jpg_220x220.jpg`（CDN 尺寸后缀）也能取对：
  // id 永远在第一段扩展名之前，尺寸后缀是扩展名之后追加的。
  const dot = rest.indexOf('.');
  if (dot <= 0) return '';
  const id = rest.slice(0, dot);
  if (!/^[0-9A-Za-z_-]+$/.test(id)) return '';
  // 点后面必须是图片扩展名（允许再跟尺寸后缀 `_220x220.jpg` / `.jpg` 之类）。
  // 不是图片扩展名 ⇒ 这不是一张图（比如 `/kf/abc/readme`），返回空而不是猜一个键。
  if (!/^\.(?:jpe?g|png|webp|gif)(?:[._].*)?$/i.test(rest.slice(dot))) return '';
  return id;
}
