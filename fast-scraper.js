const { chromium } = require('playwright');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const { JSDOM } = require('jsdom');
const fs = require('fs-extra');
const path = require('path');

// 配置
const CONFIG = {
  startUrl: 'https://open.wps.cn/documents/app-integration-dev/wps365/server/api-description/flow.html',
  targetPrefix: '/app-integration-dev/wps365/client',
  dynamicBaseUrl: 'https://open.wps.cn/documents/dynamic.html?link=',
  baseUrl: 'https://open.wps.cn/documents', // 直接访问的基础URL
  delayBetweenRequests: 500, // 减少延时到0.5秒
  timeout: 15000, // 减少超时时间到15秒
  maxRetries: 2, // 普通错误最大重试次数
  timeoutMaxRetries: 6, // 超时错误最大重试次数
  concurrency: 20 
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
  timeoutRetries: 0,
  normalRetries: 0
};

// 失败链接记录
let failedLinks = [];

// 主函数
async function main() {
  console.log('🚀 开始 WPS 文档爬取 (改进版)...\n');
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] // 优化启动
  });
  
  try {
    stats.startTime = new Date();
    
    // 获取所有目标链接
    console.log('📋 正在提取链接...');
    const links = await getTargetLinks(browser);
    
    if (links.length === 0) {
      console.log('❌ 没有找到任何目标链接');
      return;
    }
    
    console.log(`✅ 找到 ${links.length} 个目标链接\n`);
    stats.total = links.length;
    
    // 使用生产者消费者模式处理链接
    console.log(`🔄 开始生产者消费者模式下载 (并发数: ${CONFIG.concurrency})...\n`);
    await processWithProducerConsumer(browser, links);
    
  } finally {
    await browser.close();
    
    // 保存失败链接到文件
    if (failedLinks.length > 0) {
      await saveFailedLinks();
    }
    
    printSummary();
  }
}

// 获取目标链接
async function getTargetLinks(browser) {
  const page = await browser.newPage();
  
  try {
    console.log(`访问起始页面: ${CONFIG.startUrl}`);
    
    await page.goto(CONFIG.startUrl, { 
      waitUntil: 'networkidle',
      timeout: CONFIG.timeout 
    });
    
    await page.waitForTimeout(2000);
    
    const links = await page.evaluate((targetPrefix) => {
      const anchors = document.querySelectorAll('a[href]');
      const targetLinks = [];
      
      for (const anchor of anchors) {
        let href = anchor.getAttribute('href');
        
        if (href && href.startsWith('/documents' + targetPrefix)) {
          href = href.replace('/documents', '');
        }
        
        if (href && href.startsWith(targetPrefix)) {
          targetLinks.push(href);
        }
      }
      
      return [...new Set(targetLinks)];
    }, CONFIG.targetPrefix);
    
    return links;
  } finally {
    await page.close();
  }
}

// 生产者消费者模式处理链接
async function processWithProducerConsumer(browser, links) {
  // 创建任务队列
  const taskQueue = [...links.map((link, index) => ({ link, index: index + 1 }))];
  let completedCount = 0;
  
  // 创建消费者（工作线程）
  const consumers = [];
  
  // 消费者函数
  const createConsumer = async (consumerId) => {
    const page = await browser.newPage();
    
    try {
      while (taskQueue.length > 0) {
        // 从队列中取出任务
        const task = taskQueue.shift();
        if (!task) break;
        
        const { link, index } = task;
        
        // 处理任务
        await processLink(page, link, index, consumerId);
        
        // 更新进度
        completedCount++;
        const progress = ((completedCount / stats.total) * 100).toFixed(1);
        console.log(`🔄 总进度: ${completedCount}/${stats.total} (${progress}%) - 消费者${consumerId}`);
        
        // 任务间短暂延时
        if (CONFIG.delayBetweenRequests > 0) {
          await new Promise(resolve => setTimeout(resolve, CONFIG.delayBetweenRequests));
        }
      }
    } finally {
      await page.close();
      console.log(`🏁 消费者${consumerId} 完成工作`);
    }
  };
  
  // 启动多个消费者
  console.log(`🚀 启动 ${CONFIG.concurrency} 个消费者...\n`);
  
  for (let i = 0; i < CONFIG.concurrency; i++) {
    consumers.push(createConsumer(i + 1));
  }
  
  // 等待所有消费者完成
  await Promise.all(consumers);
  
  console.log(`\n✅ 所有消费者完成工作！`);
}

// 处理单个链接（带重试机制）
async function processLink(page, linkPath, index, consumerId = 0) {
  const progress = `[${index}/${stats.total}][消费者${consumerId}]`;
  console.log(`${progress} 处理: ${linkPath}`);
  
  let lastError = null;
  let retryCount = 0;
  let maxRetries = CONFIG.maxRetries;
  let lastUsedUrl = '';
  
  while (retryCount <= maxRetries) {
    try {
      // 尝试方法1：直接访问
      let content = await downloadPageDirect(page, linkPath);
      lastUsedUrl = CONFIG.baseUrl + linkPath;
      
      if (content) {
        stats.directSuccess++;
      } else {
        // 方法2：通过动态页面访问
        lastUsedUrl = CONFIG.dynamicBaseUrl + encodeURIComponent(linkPath);
        content = await downloadPageDynamic(page, linkPath);
        if (content) {
          stats.dynamicSuccess++;
        }
      }
      
      if (content && content.content && content.content.trim().length > 100) {
        await saveAsMarkdown(linkPath, content);
        stats.success++;
        const retryInfo = retryCount > 0 ? ` (重试${retryCount}次后成功)` : '';
        console.log(`${progress} ✅ 成功 (${content.content.length} 字符)${retryInfo}`);
        return; // 成功，退出重试循环
      } else {
        throw new Error('内容太少或为空');
      }
      
    } catch (error) {
      lastError = error;
      
      // 判断是否为超时错误
      const isTimeoutError = error.message.includes('timeout') || 
                            error.message.includes('Timeout') ||
                            error.name === 'TimeoutError';
      
      if (isTimeoutError) {
        // 超时错误使用更高的重试次数
        maxRetries = CONFIG.timeoutMaxRetries;
        stats.timeoutRetries++;
        
        if (retryCount < maxRetries) {
          console.log(`${progress} ⏱️ 超时重试 ${retryCount + 1}/${maxRetries}: ${error.message}`);
          console.log(`${progress} 🔗 使用的URL: ${lastUsedUrl}`);
          retryCount++;
          // 超时重试前等待更长时间
          await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
          continue;
        }
      } else {
        // 普通错误
        stats.normalRetries++;
        
        if (retryCount < maxRetries) {
          console.log(`${progress} 🔄 普通重试 ${retryCount + 1}/${maxRetries}: ${error.message}`);
          console.log(`${progress} 🔗 使用的URL: ${lastUsedUrl}`);
          retryCount++;
          // 普通重试前短暂等待
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      }
      
      // 达到最大重试次数，记录失败
      break;
    }
  }
  
  // 所有重试都失败了
  stats.failed++;
  const errorType = lastError.message.includes('timeout') ? '超时' : '普通';
  console.log(`${progress} ❌ ${errorType}错误，重试${retryCount}次后仍失败: ${lastError.message}`);
  console.log(`${progress} 🔗 最后使用的URL: ${lastUsedUrl}`);
  
  // 记录失败的链接
  failedLinks.push({
    linkPath: linkPath,
    lastUsedUrl: lastUsedUrl,
    error: lastError.message,
    errorType: errorType,
    retryCount: retryCount,
    timestamp: new Date().toISOString()
  });
}

// 方法1：直接访问页面
async function downloadPageDirect(page, linkPath) {
  try {
    const directUrl = CONFIG.baseUrl + linkPath;
    
    await page.goto(directUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.timeout 
    });
    
    // 等待内容加载
    await page.waitForTimeout(1000);
    
    // 检查页面是否成功加载
    const title = await page.title();
    if (title.includes('404') || title.includes('Not Found')) {
      return null;
    }
    
    const html = await page.content();
    return extractContent(html, directUrl, linkPath);
    
  } catch (error) {
    // 直接访问失败，返回null让后续方法尝试
    return null;
  }
}

// 方法2：通过动态页面访问
async function downloadPageDynamic(page, linkPath) {
  try {
    const dynamicUrl = CONFIG.dynamicBaseUrl + encodeURIComponent(linkPath);
    
    await page.goto(dynamicUrl, { 
      waitUntil: 'domcontentloaded',
      timeout: CONFIG.timeout 
    });
    
    // 等待动态内容加载
    await page.waitForTimeout(2000);
    
    // 等待主要内容区域出现
    try {
      await page.waitForSelector('div[class*="content"], main, article, .markdown-body', { 
        timeout: 5000 
      });
    } catch (e) {
      // 如果找不到特定选择器，继续处理
    }
    
    const html = await page.content();
    return extractContent(html, dynamicUrl, linkPath);
    
  } catch (error) {
    throw error;
  }
}

// 提取内容
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
      return null;
    }
    
    // 检查内容质量
    const textContent = article.textContent || '';
    if (textContent.trim().length < 100) {
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
async function saveAsMarkdown(linkPath, contentData) {
  const filePath = generateFilePath(linkPath);
  
  await fs.ensureDir(path.dirname(filePath));
  
  const markdownContent = `# ${contentData.title}

> 原始链接: ${contentData.originalUrl}
> 文档路径: ${linkPath}
> 生成时间: ${new Date().toLocaleString()}

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

// 保存失败链接到文件
async function saveFailedLinks() {
  const failedFile = 'failed_links.json';
  const failedReport = 'failed_links_report.txt';
  
  try {
    // 保存详细的 JSON 数据
    await fs.writeJson(failedFile, {
      timestamp: new Date().toISOString(),
      totalFailed: failedLinks.length,
      failedLinks: failedLinks
    }, { spaces: 2 });
    
    // 创建人类可读的报告
    const reportLines = [
      '失败链接报告',
      '='.repeat(50),
      `生成时间: ${new Date().toLocaleString()}`,
      `失败总数: ${failedLinks.length}`,
      '',
      '失败详情:',
      '-'.repeat(30)
    ];
    
    failedLinks.forEach((failed, index) => {
      reportLines.push(`${index + 1}. ${failed.linkPath}`);
      reportLines.push(`   实际URL: ${failed.lastUsedUrl}`);
      reportLines.push(`   错误类型: ${failed.errorType}`);
      reportLines.push(`   重试次数: ${failed.retryCount}`);
      reportLines.push(`   错误信息: ${failed.error}`);
      reportLines.push(`   时间: ${new Date(failed.timestamp).toLocaleString()}`);
      reportLines.push('');
    });
    
    await fs.writeFile(failedReport, reportLines.join('\n'), 'utf8');
    
    console.log(`\n📝 失败链接已保存到:`);
    console.log(`   - ${failedFile} (JSON格式)`);
    console.log(`   - ${failedReport} (可读报告)`);
    
  } catch (error) {
    console.error('保存失败链接时出错:', error.message);
  }
}

// 打印总结
function printSummary() {
  const endTime = new Date();
  const duration = Math.round((endTime - stats.startTime) / 1000);
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 爬取完成统计 (生产者消费者模式 - 增强重试)');
  console.log('='.repeat(60));
  console.log(`⏱️  总耗时: ${minutes}分${seconds}秒`);
  console.log(`📄 总链接数: ${stats.total}`);
  console.log(`✅ 成功: ${stats.success} (${(stats.success/stats.total*100).toFixed(1)}%)`);
  console.log(`❌ 失败: ${stats.failed} (${(stats.failed/stats.total*100).toFixed(1)}%)`);
  console.log(`🎯 直接访问成功: ${stats.directSuccess}`);
  console.log(`🔄 动态访问成功: ${stats.dynamicSuccess}`);
  console.log(`⏱️  超时重试次数: ${stats.timeoutRetries}`);
  console.log(`🔁 普通重试次数: ${stats.normalRetries}`);
  console.log(`⚡ 平均速度: ${(stats.total/duration).toFixed(2)} 链接/秒`);
  
  if (failedLinks.length > 0) {
    console.log(`\n❌ 失败链接详情:`);
    const timeoutFailed = failedLinks.filter(f => f.errorType === '超时').length;
    const normalFailed = failedLinks.filter(f => f.errorType === '普通').length;
    console.log(`   - 超时失败: ${timeoutFailed}`);
    console.log(`   - 普通失败: ${normalFailed}`);
    console.log(`   - 详细报告已保存到 failed_links_report.txt`);
  }
  
  console.log('='.repeat(60));
}

// 处理退出信号
process.on('SIGINT', () => {
  console.log('\n\n🛑 收到退出信号...');
  printSummary();
  process.exit(0);
});

// 运行爬虫
if (require.main === module) {
  main().catch(error => {
    console.error('💥 运行错误:', error);
    process.exit(1);
  });
} 