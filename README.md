# 小窝 · 情侣空间 💕

一个单文件的情侣小窝网页 + Cloudflare Worker 云同步 & MCP 服务（52 个工具，AI 可读可写）。

## 🚀 一键部署（推荐）

点下面的按钮，登录你的 Cloudflare 账号，一路确认即可 —— **Worker 和 KV 存储会自动创建并绑定**，不用手动建 KV、不用手动绑定：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YU-jun-11/xiaowo2)

> ⚠️ 部署完成后，把仓库里的 `小窝_情侣空间.html` 下载到手机/电脑，用浏览器打开就能用（下载入口：仓库文件列表 → 该文件 → 右上角 Download）。

## ✋ 手动部署（备用）

如果一键部署有问题，按 [部署教程](./小窝-mcp-公开版部署教程.md) 手动来，全程免费约 6 分钟：

1. Cloudflare 建 Worker（模板选第三个 Vite React Template）
2. 建 KV，绑定到 Worker，变量名必须是大写 **NEST**
3. 把 `worker.js` 内容粘进编辑器 → Deploy

## 📖 使用

- **怎么用**：看 [小窝在aru的使用教程.md](./小窝在aru的使用教程.md)
- **完整说明**：看 [部署说明 2.md](./部署说明%202.md)

部署完：打开网页 → 点右上角 ☁ → 填 Worker 地址 + 自己定的密钥（≥6 位）→ 保存并同步。

多对情侣可共用一个 Worker：每人用**自己的密钥**即可，数据按密钥指纹分区互不可见。

## 文件说明

| 文件 | 说明 |
|---|---|
| `小窝_情侣空间.html` | 网页本体（单文件，直接打开就能用） |
| `worker.js` | Cloudflare Worker 后端（数据同步 + 52 个 MCP 工具） |
| `wrangler.toml` | 一键部署配置（自动创建并绑定 KV） |

---

**作者**：世x珺 · 邮箱 junyu3808@gmail.com · GitHub [@YU-jun-11](https://github.com/YU-jun-11)

许可：**MIT**
