const { chromium } = require('playwright');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const { JSDOM } = require('jsdom');
const fs = require('fs-extra');
const path = require('path');

// 配置
const CONFIG = {
  dynamicBaseUrl: 'https://open.wps.cn/documents/dynamic.html?link=',
  baseUrl: 'https://open.wps.cn/documents',
  timeout: 20000, // 增加超时时间
  maxRetries: 3,
  timeoutMaxRetries: 6,
  minContentLength: 50, // 降低最小内容长度阈值（原来是100）
  concurrency: 5 // 降低并发数，更仔细处理
};

// 初始化 Markdown 转换器
const turndown = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced'
});

// 统计信息
let stats = {
  total: 0,
  success: 0,
  failed: 0,
  startTime: null,
  directSuccess: 0,
  dynamicSuccess: 0,
  retryAttempts: 0
};

// 新的失败链接
let newFailedLinks = [];

// 主函数
async function main() {
  console.log('🔄 开始重新处理失败的链接...\n');
  
  // 读取失败链接文件
  const failedData = await loadFailedLinks();
  if (!failedData || failedData.length === 0) {
    console.log('❌ 没有找到失败链接文件或文件为空');
    return;
  }
  
  console.log(`📋 找到 ${failedData.length} 个失败链接需要重新处理\n`);
  stats.total = failedData.length;
  stats.startTime = new Date();
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    await processFailedLinksWithProducerConsumer(browser, failedData);
  } finally {
    await browser.close();
    
    // 保存新的失败链接
    if (newFailedLinks.length > 0) {
      await saveNewFailedLinks();
    }
    
    printSummary();
  }
}

// 读取失败链接文件
async function loadFailedLinks() {
  try {
    const failedLinksFile = 'failed_links.json';
    
    if (!await fs.pathExists(failedLinksFile)) {
      console.log('❌ 找不到 failed_links.json 文件');
      return null;
    }
    
    const data = await fs.readJson(failedLinksFile);
    return data.failedLinks || [];
  } catch (error) {
    console.error('❌ 读取失败链接文件时出错:', error.message);
    return null;
  }
}

// 生产者消费者模式处理失败链接
async function processFailedLinksWithProducerConsumer(browser, failedLinks) {
  const taskQueue = [...failedLinks.map((item, index) => ({ 
    ...item, 
    retryIndex: index + 1 
  }))];
  let completedCount = 0;
  
  const consumers = [];
  
  const createConsumer = async (consumerId) => {
    const page = await browser.newPage();
    
    try {
      while (taskQueue.length > 0) {
        const task = taskQueue.shift();
        if (!task) break;
        
        await processFailedLink(page, task, consumerId);
        
        completedCount++;
        const progress = ((completedCount / stats.total) * 100).toFixed(1);
        console.log(`🔄 重试进度: ${completedCount}/${stats.total} (${progress}%) - 消费者${consumerId}`);
        
        // 重试间隔更长
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally {
      await page.close();
      console.log(`🏁 消费者${consumerId} 完成重试工作`);
    }
  };
  
  console.log(`🚀 启动 ${CONFIG.concurrency} 个消费者进行重试...\n`);
  
  for (let i = 0; i < CONFIG.concurrency; i++) {
    consumers.push(createConsumer(i + 1));
  }
  
  await Promise.all(consumers);
  console.log(`\n✅ 所有消费者完成重试工作！`);
}

// 处理单个失败链接
async function processFailedLink(page, failedItem, consumerId) {
  const { linkPath, retryIndex } = failedItem;
  const progress = `[${retryIndex}/${stats.total}][重试消费者${consumerId}]`;
  
  console.log(`${progress} 重新处理: ${linkPath}`);
  console.log(`${progress} 📝 原失败原因: ${failedItem.error}`);
  
  let lastError = null;
  let retryCount = 0;
  let maxRetries = CONFIG.maxRetries;
  let lastUsedUrl = '';
  
  while (retryCount <= maxRetries) {
    try {
      stats.retryAttempts++;
      
      // 优先尝试动态页面访问（因为失败链接中大多数都是用的动态URL）
      lastUsedUrl = failedItem.lastUsedUrl || 
                   (CONFIG.dynamicBaseUrl + encodeURIComponent(linkPath));
      
      console.log(`${progress} 🌐 尝试访问: ${lastUsedUrl}`);
      
      let content;
      if (lastUsedUrl.includes('dynamic.html')) {
        content = await downloadPageDynamic(page, linkPath, progress);
      } else {
        content = await downloadPageDirect(page, linkPath, progress);
      }
      
      if (content && content.content) {
        const contentLength = content.content.trim().length;
        console.log(`${progress} 📄 获取到内容长度: ${contentLength} 字符`);
        console.log(`${progress} 📄 内容预览: ${content.content.substring(0, 100)}...`);
        
        if (contentLength >= CONFIG.minContentLength) {
          await saveAsMarkdown(linkPath, content);
          stats.success++;
          stats.dynamicSuccess++;
          const retryInfo = retryCount > 0 ? ` (重试${retryCount}次后成功)` : '';
          console.log(`${progress} ✅ 重试成功 (${contentLength} 字符)${retryInfo}`);
          return;
        } else {
          console.log(`${progress} ⚠️ 内容长度不足 (${contentLength} < ${CONFIG.minContentLength})`);
          // 如果内容很短但不为空，也保存下来，但标记为可疑
          if (contentLength > 10) {
            await saveAsMarkdown(linkPath, content, true); // 标记为可疑内容
            stats.success++;
            console.log(`${progress} ⚠️ 保存短内容 (${contentLength} 字符，已标记)`);
            return;
          }
          throw new Error(`内容太短: ${contentLength} 字符`);
        }
      } else {
        throw new Error('无法提取内容');
      }
      
    } catch (error) {
      lastError = error;
      console.log(`${progress} ❌ 尝试 ${retryCount + 1} 失败: ${error.message}`);
      
      const isTimeoutError = error.message.includes('timeout') || 
                            error.message.includes('Timeout') ||
                            error.name === 'TimeoutError';
      
      if (isTimeoutError && maxRetries < CONFIG.timeoutMaxRetries) {
        maxRetries = CONFIG.timeoutMaxRetries;
      }
      
      if (retryCount < maxRetries) {
        retryCount++;
        const waitTime = isTimeoutError ? (3000 * retryCount) : 2000;
        console.log(`${progress} ⏳ 等待 ${waitTime}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }
      
      break;
    }
  }
  
  // 重试失败
  stats.failed++;
  console.log(`${progress} ❌ 重试失败，尝试了 ${retryCount + 1} 次: ${lastError.message}`);
  
  newFailedLinks.push({
    ...failedItem,
    retryError: lastError.message,
    retryAttempts: retryCount + 1,
    retryTimestamp: new Date().toISOString()
  });
}

// 下载页面（直接访问）
async function downloadPageDirect(page, linkPath, progress) {
  const directUrl = CONFIG.baseUrl + linkPath;
  console.log(`${progress} 🔗 直接访问: ${directUrl}`);
  
  await page.goto(directUrl, { 
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.timeout 
  });
  
  await page.waitForTimeout(2000);
  
  const title = await page.title();
  if (title.includes('404') || title.includes('Not Found')) {
    throw new Error('页面不存在 (404)');
  }
  
  const html = await page.content();
  return extractContent(html, directUrl, linkPath);
}

// 下载页面（动态访问）
async function downloadPageDynamic(page, linkPath, progress) {
  const dynamicUrl = CONFIG.dynamicBaseUrl + encodeURIComponent(linkPath);
  console.log(`${progress} 🔗 动态访问: ${dynamicUrl}`);
  
  await page.goto(dynamicUrl, { 
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.timeout 
  });
  
  // 等待动态内容加载
  await page.waitForTimeout(3000);
  
  // 等待主要内容区域出现
  try {
    await page.waitForSelector('div[class*="content"], main, article, .markdown-body, .dynamic-markdown-component', { 
      timeout: 8000 
    });
  } catch (e) {
    console.log(`${progress} ⚠️ 未找到预期的内容选择器，继续处理...`);
  }
  
  const html = await page.content();
  return extractContent(html, dynamicUrl, linkPath);
}

// 提取内容（增强版，更宽松的内容判断）
function extractContent(html, url, linkPath) {
  try {
    const dom = new JSDOM(html);
    const document = dom.window.document;
    
    // 移除不需要的元素
    const elementsToRemove = document.querySelectorAll(
      'nav, .nav, .navigation, .sidebar, .header, .footer, ' +
      '.menu, .breadcrumb, .pagination, script, style, ' +
      '.advertisement, .ad, .social-share'
    );
    
    elementsToRemove.forEach(el => el.remove());
    
    // 使用 Readability 提取主要内容
    const reader = new Readability(document);
    const article = reader.parse();
    
    if (!article || !article.content) {
      // 如果 Readability 失败，尝试手动提取
      const mainContent = document.querySelector('.dynamic-markdown-component, main, article, .content, .markdown-body');
      if (mainContent) {
        const markdown = turndown.turndown(mainContent.innerHTML);
        return {
          title: extractTitleFromPath(linkPath),
          content: markdown,
          originalUrl: url,
          path: linkPath
        };
      }
      return null;
    }
    
    // 转换为 Markdown
    const markdown = turndown.turndown(article.content);
    
    return {
      title: article.title || extractTitleFromPath(linkPath),
      content: markdown,
      originalUrl: url,
      path: linkPath
    };
    
  } catch (error) {
    console.log(`    内容提取失败: ${error.message}`);
    return null;
  }
}

// 从路径提取标题
function extractTitleFromPath(linkPath) {
  const segments = linkPath.split('/');
  const lastSegment = segments[segments.length - 1];
  return lastSegment.replace('.html', '').replace(/-/g, ' ');
}

// 保存为 Markdown 文件
async function saveAsMarkdown(linkPath, contentData, isSuspicious = false) {
  const filePath = generateFilePath(linkPath);
  
  await fs.ensureDir(path.dirname(filePath));
  
  const suspiciousNote = isSuspicious ? '\n> ⚠️ **注意**: 此文档内容较短，可能需要人工确认内容完整性\n' : '';
  
  const markdownContent = `# ${contentData.title}

> 原始链接: ${contentData.originalUrl}
> 文档路径: ${linkPath}
> 生成时间: ${new Date().toLocaleString()}
> 处理状态: 重试成功${suspiciousNote}

${contentData.content}
`;
  
  await fs.writeFile(filePath, markdownContent, 'utf8');
  console.log(`    保存到: ${filePath}`);
}

// 生成文件路径
function generateFilePath(linkPath) {
  let cleanPath = linkPath.replace(/^\//, '');
  const segments = cleanPath.split('/');
  const fileName = segments[segments.length - 1] || 'index';
  const dirSegments = segments.slice(0, -1);
  const fullPath = [...dirSegments, `${fileName}.md`].join('/');
  return fullPath;
}

// 保存新的失败链接
async function saveNewFailedLinks() {
  const timestamp = new Date().toISOString();
  const newFailedFile = `failed_links_retry_${timestamp.slice(0, 19).replace(/:/g, '-')}.json`;
  const newFailedReport = `failed_links_retry_report_${timestamp.slice(0, 19).replace(/:/g, '-')}.txt`;
  
  try {
    await fs.writeJson(newFailedFile, {
      timestamp: timestamp,
      originalFailureCount: stats.total,
      newFailureCount: newFailedLinks.length,
      newFailedLinks: newFailedLinks
    }, { spaces: 2 });
    
    const reportLines = [
      '重试后仍失败的链接报告',
      '='.repeat(60),
      `生成时间: ${new Date().toLocaleString()}`,
      `原始失败总数: ${stats.total}`,
      `重试后仍失败: ${newFailedLinks.length}`,
      `重试成功数: ${stats.success}`,
      '',
      '仍然失败的链接详情:',
      '-'.repeat(40)
    ];
    
    newFailedLinks.forEach((failed, index) => {
      reportLines.push(`${index + 1}. ${failed.linkPath}`);
      reportLines.push(`   原始错误: ${failed.error}`);
      reportLines.push(`   重试错误: ${failed.retryError}`);
      reportLines.push(`   重试次数: ${failed.retryAttempts}`);
      reportLines.push(`   重试时间: ${new Date(failed.retryTimestamp).toLocaleString()}`);
      reportLines.push('');
    });
    
    await fs.writeFile(newFailedReport, reportLines.join('\n'), 'utf8');
    
    console.log(`\n📝 重试失败链接已保存到:`);
    console.log(`   - ${newFailedFile} (JSON格式)`);
    console.log(`   - ${newFailedReport} (可读报告)`);
    
  } catch (error) {
    console.error('保存重试失败链接时出错:', error.message);
  }
}

// 打印总结
function printSummary() {
  const endTime = new Date();
  const duration = Math.round((endTime - stats.startTime) / 1000);
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;
  
  console.log('\n' + '='.repeat(70));
  console.log('📊 失败链接重试完成统计');
  console.log('='.repeat(70));
  console.log(`⏱️  总耗时: ${minutes}分${seconds}秒`);
  console.log(`📄 原始失败链接数: ${stats.total}`);
  console.log(`✅ 重试成功: ${stats.success} (${(stats.success/stats.total*100).toFixed(1)}%)`);
  console.log(`❌ 仍然失败: ${stats.failed} (${(stats.failed/stats.total*100).toFixed(1)}%)`);
  console.log(`🔄 总重试尝试次数: ${stats.retryAttempts}`);
  console.log(`⚡ 平均速度: ${(stats.total/duration).toFixed(2)} 链接/秒`);
  
  if (stats.success > 0) {
    console.log(`\n✨ 重试挽救了 ${stats.success} 个链接！`);
  }
  
  if (newFailedLinks.length > 0) {
    console.log(`\n💡 建议: 检查重试失败报告，可能需要手动处理剩余 ${newFailedLinks.length} 个链接`);
  } else {
    console.log(`\n🎉 所有失败链接都已成功重试！`);
  }
  
  console.log('='.repeat(70));
}

// 处理退出信号
process.on('SIGINT', () => {
  console.log('\n\n🛑 收到退出信号...');
  printSummary();
  process.exit(0);
});

// 运行重试脚本
if (require.main === module) {
  main().catch(error => {
    console.error('💥 重试运行错误:', error);
    process.exit(1);
  });
} 