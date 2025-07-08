# WPS 文档自动化爬取工具

这个项目使用 Playwright 自动化爬取 WPS 开放文档，并将其转换为 Markdown 格式保存。

## 功能特性

- 🤖 自动访问 WPS 文档起始页面
- 🔍 智能提取特定前缀的文档链接
- 📄 使用 Mozilla Readability 提取主要内容
- 📝 转换为 Markdown 格式
- 💾 按照 URL 路径结构保存文件
- 🛡️ 错误处理和重试机制

## 安装和使用

### 1. 安装依赖

```bash
npm install
```

### 2. 安装 Playwright 浏览器

```bash
npm run install-browsers
```

### 3. 开始爬取

```bash
npm start
# 或者
npm run scrape
# 或者直接运行
node simple-scraper.js
```

### 4. 查看进度

检查已生成的文件数量：

```bash
find app-integration-dev -name "*.md" | wc -l
```

## 工作原理

1. 🔍 **自动发现链接**: 访问起始页面，找到所有 WPS 客户端文档链接
2. 📄 **下载页面内容**: 逐个访问文档页面，获取完整内容  
3. 🔄 **智能内容提取**: 使用 Mozilla Readability 提取核心文档内容
4. 📝 **转换格式**: 将 HTML 转换为干净的 Markdown 格式
5. 💾 **保存文档**: 按原始路径结构保存，便于查阅

## 输出结构

文档会按照以下结构保存：

```
app-integration-dev/
└── wps365/
    └── client/
        ├── wpsoffice/
        │   └── wps-integration-mode/
        │       └── wps-addin-development/
        │           └── addin-overview.md
        └── ...
```

每个 Markdown 文件包含：
- 文档标题
- 原始链接信息
- 提取的主要内容

## 预计耗时

- 📊 **文档数量**: 约 2200+ 个文档
- ⏱️ **处理速度**: 每个文档 2-3 秒
- 🕐 **总耗时**: 约 1-2 小时
- 💾 **磁盘空间**: 需要约 1GB 空间

## 注意事项

- 爬取过程中会有延时以避免请求过快
- 遇到错误会继续处理下一个链接
- 支持 Ctrl+C 优雅退出，会显示当前进度
- 失败的链接会保存到 `failed-links.txt` 文件
- 会自动去重相同的链接
- 生成的文件按原始 URL 结构组织

## 依赖包

- `playwright`: 浏览器自动化
- `@mozilla/readability`: 内容提取
- `turndown`: HTML 转 Markdown
- `jsdom`: DOM 解析
- `fs-extra`: 文件系统操作

## 许可证

MIT 