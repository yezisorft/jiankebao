# 简课表 · Cloudflare Workers 使用人数统计部署说明

本目录包含用于「简课表查看」的纯匿名使用人数统计 Worker（不记录任何隐私或设备信息，仅维护一个 `total_users` 整数）。

## 快速部署步骤

1. 在 `worker/` 目录下登录 Cloudflare：
   ```bash
   npx wrangler login
   ```
2. 创建 KV 命名空间：
   ```bash
   npx wrangler kv namespace create STATS_KV
   ```
3. 将命令行输出的 `id` 填入 `worker/wrangler.jsonc` 中的 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。
4. 部署 Worker：
   ```bash
   npx wrangler deploy
   ```
5. 将部署成功后得到的域名（如 `https://jiankebao-stats.<你的子域>.workers.dev`）填入 `js/app.js` 顶部的 `STATS_API_BASE` 常量即可生效。
