
# WPS 文档爬取工具使用说明(只是个临时脚本)

## 快速开始

### 1. 安装依赖
```bash
npm install
npm run install-browsers
```

### 2. 开始爬取
```bash
npm start
```

就这么简单！脚本会：
1. 🔍 自动访问起始页面，找到所有目标链接（约2200+个）
2. 📄 逐个下载页面内容
3. 🔄 转换为 Markdown 格式
4. 💾 按原始路径结构保存文件

## 输出结果

文档会保存在 `app-integration-dev/` 目录下，保持原有的路径结构。

例如：
- 原始链接：`/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/addin-overview.html`
- 保存位置：`app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/addin-overview.html.md`

## 进度监控

脚本运行时会显示：
```
[1/2242] 处理: /app-integration-dev/wps365/client/...
    保存到: app-integration-dev/wps365/client/...
[1/2242] ✅ 成功

[2/2242] 处理: /app-integration-dev/wps365/client/...
    保存到: app-integration-dev/wps365/client/...
[2/2242] ✅ 成功
```

## 停止爬取

按 `Ctrl+C` 可以随时优雅停止，会显示当前进度统计。

## 预计时间

- 2200+ 个文档
- 每个文档约 2-3 秒处理时间
- 总计约 1-2 小时

## 检查结果

```bash
# 查看已下载的文档数量
find app-integration-dev -name "*.md" | wc -l

# 查看目录结构
tree app-integration-dev
```

## 注意事项

- 🌐 需要网络连接
- 💾 需要约 1GB 磁盘空间
- ⏰ 脚本会自动延时，避免请求过快
- 🔄 如果中断可以重新运行，已存在的文件会被覆盖

祝使用愉快！ 🎉 

---

# 重试失败链接功能说明

## 🎯 功能概述

`retry-failed-links.js` 是专门用于重新处理失败链接的脚本。它会读取 `failed_links.json` 文件，并使用更宽松的策略重新尝试获取这些失败的文档。

## 🔧 主要改进

### 1. **降低内容长度阈值**
- **原始阈值**: 100 字符
- **重试阈值**: 50 字符
- **短内容处理**: 10-50 字符的内容会被保存但标记为可疑

### 2. **增强的等待策略**
- 增加超时时间到 20 秒
- 动态内容等待时间增加到 3 秒
- 更仔细的选择器等待 (8 秒超时)

### 3. **详细的调试信息**
- 显示原始失败原因
- 实时显示内容长度和预览
- 标记访问的具体 URL

### 4. **灵活的内容提取**
- 如果 Readability 失败，尝试手动提取
- 支持多种内容选择器
- 更宽松的内容判断标准

## 📋 使用方法

### 1. **基本使用**
```bash
npm run retry
```

### 2. **手动运行**
```bash
node retry-failed-links.js
```

## 📁 输入输出文件

### 输入文件
- `failed_links.json` - 主爬虫生成的失败链接列表

### 输出文件
- **成功重试的文档**: 保存为正常的 `.md` 文件
- **短内容文档**: 保存时会添加 ⚠️ 警告标记
- **仍然失败的链接**: 
  - `failed_links_retry_YYYY-MM-DD-HH-MM-SS.json` (JSON 格式)
  - `failed_links_retry_report_YYYY-MM-DD-HH-MM-SS.txt` (可读报告)

## 🏷️ 内容标记说明

### 正常重试成功
`	`
# XlDataLabelSeparator 枚举

> 原始链接: https://open.wps.cn/documents/dynamic.html?link=...
> 文档路径: /app-integration-dev/wps365/client/...
> 生成时间: 2024-01-20 15:30:45
> 处理状态: 重试成功

内容正文...
`	`

### 短内容警告标记
`	`
# XlDataLabelSeparator 枚举

> 原始链接: https://open.wps.cn/documents/dynamic.html?link=...
> 文档路径: /app-integration-dev/wps365/client/...
> 生成时间: 2024-01-20 15:30:45
> 处理状态: 重试成功
> ⚠️ **注意**: 此文档内容较短，可能需要人工确认内容完整性

内容正文...
`	`

## 📊 重试策略

| 内容长度 | 处理方式 | 标记 |
|----------|----------|------|
| ≥ 50 字符 | 正常保存 | 无标记 |
| 10-49 字符 | 保存并标记 | ⚠️ 短内容警告 |
| < 10 字符 | 视为失败 | 继续重试 |

## 🔄 重试逻辑

1. **读取失败链接**: 从 `failed_links.json` 加载
2. **优先使用原URL**: 使用失败时记录的实际URL
3. **多次重试**: 普通错误3次，超时错误6次
4. **渐进式等待**: 每次重试等待时间递增
5. **内容验证**: 多级内容长度检查
6. **结果保存**: 自动保存成功和失败结果

## 📈 预期效果

根据你提供的失败链接分析：

### 可能成功重试的情况
- **导航中断错误**: 通过更长等待时间解决
- **内容太少**: 通过降低阈值和更细致的提取解决
- **临时网络问题**: 通过多次重试解决

### 典型的短内容页面
- **枚举定义页面**: 如 `XlDataLabelSeparator` 只有简单的值说明
- **API 参数页面**: 只有几行参数说明
- **常量定义页面**: 只有常量值列表

这些页面虽然内容少，但都是有效的技术文档，应该被保留。

## 🎯 使用建议

1. **运行重试脚本**: 
   `	`
   npm run retry
   `	`

2. **检查重试结果**: 查看控制台输出的统计信息

3. **验证短内容**: 检查带 ⚠️ 标记的文档是否符合预期

4. **处理剩余失败**: 查看重试失败报告，考虑手动处理

5. **多次重试**: 如果网络问题导致失败，可以多次运行重试脚本

## ⚡ 性能特点

- **并发数**: 5 (比主爬虫更保守)
- **超时时间**: 20 秒 (比主爬虫更长)
- **重试间隔**: 1-3 秒 (更仔细的处理)
- **预期效率**: 可挽救 70-90% 的失败链接

## 🛠️ 故障排除

### 如果重试仍然失败
1. 检查网络连接
2. 查看具体错误信息
3. 手动访问问题URL验证
4. 考虑进一步降低 `minContentLength` 参数

### 如果内容质量有问题
1. 检查带 ⚠️ 标记的文档
2. 手动验证原网页内容
3. 调整内容提取逻辑（如果需要）

通过这个重试功能，应该可以显著提高文档采集的完整性！ 
