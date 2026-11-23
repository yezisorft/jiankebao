# iPhone 主屏幕安装与免费 HTTPS 部署指南

「简课表查看」已完整适配 iPhone 主屏幕独立窗口（全出血不透明图标、底部安全区、离线原子缓存 `sw.js`、自动主题状态栏色）。只需将其托管到任意免费 **HTTPS** 静态空间，即可永久免费装在 iPhone 桌面上，断网秒开、永不过期。

---

## 第一步：1 分钟获取免费 HTTPS 网址（二选一）

### 方式 A：Cloudflare Pages 拖拽上传（最快，无需命令行）
1. 登录 https://dash.cloudflare.com/ → 左侧进入 **Workers & Pages** → 点击 **Create** → 切换到 **Pages** 标签页 → 选择 **Upload assets（直接上传）**。
2. 填一个项目名（例如 `jiankebiao`）。
3. 把本项目的 `dist/jiankebiao-pwa.zip`（或构建产物目录 `dist/site`）拖进上传框，点击 **Deploy site**。
4. 几秒后即可获得你的专属永久 HTTPS 网址，例如：`https://jiankebiao.pages.dev/`（Netlify Drop https://app.netlify.com/drop 也支持直接拖拽 `dist/site` 文件夹或该 zip 包）。

> 后续修改代码后，只需运行 `bash scripts/package-release.sh`，脚本会自动按所有发布资源的内容哈希更新 `sw.js` 缓存版本并生成新的 `dist/site` 与 `dist/jiankebiao-pwa.zip`；覆盖部署后，已有手机安装会自动收到「发现新版本，点击立即更新刷新」提示。

### 方式 B：GitHub Pages 自动部署（推荐长期维护）
仓库内已配好 `.github/workflows/deploy-pages.yml`：
1. 在 GitHub 新建一个仓库，将 `/Users/yezisorft/Documents/简课表查看` 推送到 `main` 分支：
   ```bash
   cd "/Users/yezisorft/Documents/简课表查看"
   git add .
   git commit -m "feat: initial JianKeBiao PWA"
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```
2. 打开该 GitHub 仓库的 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**。
3. 等待约 30 秒部署完成，访问 `https://<你的用户名>.github.io/<仓库名>/` 即可。

> **隐私提示（公开仓库 vs 发布 ZIP）**：`dist/jiankebiao-pwa.zip` 与 `dist/site/` 仅包含 100% 人工构造的公开演示课表，不含任何真实院校或教学班信息。若要推送到 **公开的** GitHub 仓库，建议先新建一条干净的孤立初始提交（`git checkout --orphan public-main`）再推送，避免将本地早期快照提交（`bd1a276`）中曾跟踪过的脱敏参考样本一并推到公开历史。

---

## 第二步：装到 iPhone 桌面并导入你的真实课表

> **重要顺序（因 iPhone Safari 与主屏幕 Web App 存储隔离）：先安装到主屏幕，再在主屏幕 App 内导入课表！**

1. **添加到主屏幕**：
   - 在 iPhone 上用 **Safari**（注意不是微信内置浏览器）打开你的 HTTPS 网址。
   - 点击底部正中的 **分享按钮（□↑）** → 向下滑动选择 **「添加到主屏幕」** → 点右上角 **「添加」**。
2. **完成首次离线缓存**：
   - 返回 iPhone 桌面，点击新建的 **「简课表」** 图标打开独立全屏窗口。
   - 保持联网 2~3 秒，确认左上角标题旁出现绿色徽章 **「已可离线使用」**。
3. **把电脑教务课表同步进 iPhone 主屏幕 App**：
   - 在电脑浏览器打开你的 HTTPS 网址 → 进入 **「导入与传输」** → 粘贴学校正方教务（`table#kbgrid_table_0`）已渲染的完整表格 HTML → 核对预览并保存（此时会完整保留每位老师的真实全名），并在 **「设置」** 中核对开学第一周周一与作息时间。
   - 电脑端点击 **「复制导入码」**（或 **「导出完整 JSON 备份」**），通过微信文件传输助手发给自己。
   - 回到 iPhone 桌面点开 **「简课表」主屏幕 App** → **「导入」** → 粘贴导入码（或选择 JSON 文件）→ 核对预览 → **确认导入并保存**。
4. **飞行模式终极验收**：
   - 上滑关闭「简课表」后台 → 打开 iPhone **飞行模式** → 重新点桌面图标冷启动，确认秒开且今日/周课表全部正常展示。
