# 简课表查看（JianKeBiao PWA）

一个**纯静态、零依赖、免登录、离线优先**的个人课表 PWA 工具，支持电脑浏览器和 **iPhone / Android 添加到主屏幕**独立全屏运行（断网秒开）。

- **在线地址（GitHub Pages）**：https://yezisorft.github.io/jiankebao/
- **当前版本**：`v1.0.5-73ad0cd2`（17 项核心资源原子离线缓存）
- **仓库分支说明**：
  - `main` 分支：线上静态发布站点（直接托管 GitHub Pages）
  - `source` 分支：完整源码、36 项自动化测试、构建脚本与文档（[查看源码分支](https://github.com/yezisorft/jiankebao/tree/source)）
- **详细使用报告与每步 AI 提示词**：[docs/项目总结与使用报告.md](https://github.com/yezisorft/jiankebao/blob/source/docs/%E9%A1%B9%E7%9B%AE%E6%80%BB%E7%BB%93%E4%B8%8E%E4%BD%BF%E7%94%A8%E6%8A%A5%E5%91%8A.md)

---

## 核心功能

- **今日视图 & 周课表视图**：共用同一套实际课次引擎，自动计算当前周次、上课中/下节倒计时，支持单双周、非连续周、周末列切换与快捷键/手势翻周，完整保留全部教师真实姓名。
- **内置真实作息模板**：含 **早自习（08:00–08:15，不占正课编号）** 与 **13 节作息（08:15–20:40，每节 40 分钟）**，支持自由增减节次与防删课缩短保护。
- **灵活编辑（仅此一次 / 整组课程）**：支持单次停课、临时改教室/时间、跨天调课（支持成对一键撤回）、单次补课及整组周期规则编辑。
- **统一安全导入管线**（`解析 → 校验 → 纯文本预览 → 自动保留覆盖前快照 → 确认保存`）：
  - 正方新版教务 `jwglxt V-9.0` 已渲染表格解析 + 通用表格兜底（纯文本隔离解析，不执行脚本、不加载外部资源）
  - 完整紧凑 JSON 备份与恢复（支持 4 MB UTF-8 预算，保留全部独立规则与调停课例外）
  - 跨设备同步：**导入码（`JKB1:` 压缩）** 与 `#schedule=...` 快捷链接
- **`.ics` 系统日历导出**：与今日/周课表共用同一课次引擎，按整学期展开为稳定 UID 独立事件，支持可选课前提醒与非上海 IANA 时区 RFC 5545 UTC 转换。
- **数据安全与离线体验**：Web Locks 跨标签页防覆盖、硬配额校验、损坏存储原文导出保护、内容哈希 Service Worker 离线更新提示与全出血 iOS 主屏幕图标。

---

## 快速上手（iPhone 主屏幕安装）

1. **电脑端导入**：打开 https://yezisorft.github.io/jiankebao/ → 进入 **「导入」** 粘贴教务表格 HTML（或点「载入演示样例」）→ 核对预览并保存 → 在 **「设置」** 核对开学第 1 周周一日期与作息 → 点 **「复制导入码」** 发到微信。
2. **装到 iPhone 桌面**：用 iPhone **Safari** 打开 https://yezisorft.github.io/jiankebao/ → 点底部 **分享（□↑）→ 添加到主屏幕 → 添加**。
3. **离线缓存并导入**：从桌面打开 **「简课表」** 图标，联网等 2~3 秒看到顶部绿色 **「已可离线使用」** → 点底部 **「导入」** 粘贴导入码保存 → 开飞行模式验证断网秒开。

更多部署细节、逐条复现步骤与 AI 辅助提示词请见：
- [项目总结与使用报告（含每步 AI 提示词）](https://github.com/yezisorft/jiankebao/blob/source/docs/%E9%A1%B9%E7%9B%AE%E6%80%BB%E7%BB%93%E4%B8%8E%E4%BD%BF%E7%94%A8%E6%8A%A5%E5%91%8A.md)
- [iPhone 安装与部署指南](https://github.com/yezisorft/jiankebao/blob/source/docs/iphone-deploy-guide.md)
- [上线验收清单](https://github.com/yezisorft/jiankebao/blob/source/docs/acceptance-checklist.md)

---

## 本地开发与验证（`source` 分支）

```bash
# 运行全部 36 项自动化单元与回归测试
node --test tests/*.test.mjs

# 按内容哈希重新构建 dist/site 与 dist/jiankebiao-pwa.zip
bash scripts/package-release.sh

# 本地静态预览（支持 Service Worker）
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist/site
```
