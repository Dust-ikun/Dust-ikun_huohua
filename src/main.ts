import 'dotenv/config'
import { chromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { type Browser, type Cookie, type Locator, type Page } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { DouyinCookie, SameSite } from './types/douyin-cookie'
import type { Yiyan } from './types/yiyan'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('zh-cn')

const DOUYIN_ACCOUNTS_KEY = 'DOUYIN_ACCOUNTS'
const DOUYIN_COOKIE_KEY = 'DOUYIN_COOKIE'
const DOUYIN_TARGET_NAMES_KEY = 'DOUYIN_TARGET_NAMES'
const YIYAN_INCLUDE_SOURCE_KEY = 'YIYAN_INCLUDE_SOURCE'
const SPARK_MESSAGE_TEMPLATE_KEY = 'SPARK_MESSAGE_TEMPLATE'
const FAILURE_SCREENSHOT_DIRECTORY = 'artifacts'

const CHAT_PAGE_READY_TIMEOUT = 30000
const CHAT_PAGE_IDLE_TIMEOUT = 10000
const SEARCH_RESULT_TIMEOUT = 5000
const SEARCH_RETRY_LIMIT = 3
const SEARCH_RETRY_INTERVAL = 2000
const SEARCH_INPUT_RESET_DELAY = 500

const MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
const MESSAGE_TEMPLATE_PLACEHOLDERS = [
  'account',
  'friend',
  'yiyan',
  'from',
  'date',
  'time',
  'weekday',
] as const

type MessageTemplatePlaceholder = (typeof MESSAGE_TEMPLATE_PLACEHOLDERS)[number]

interface DouyinAccount {
  name: string
  cookies: Cookie[]
  targetNames: string[]
  messageTemplate: string | undefined
}

/**
 * 启动本机 Chrome 浏览器并携带 Cookie 访问抖音聊天页。
 */
async function main(): Promise<void> {
  const browserPath = resolveBrowserPath()
  const headless = resolveHeadless()
  const autoClose = resolveAutoClose()
  const includeYiyanSource = resolveYiyanIncludeSource()
  const globalMessageTemplate = resolveSparkMessageTemplate()
  const accounts = resolveDouyinAccounts(globalMessageTemplate)
  const yiyans = await resolveYiyans()

  // 1. 注册 stealth 插件（在 launch 之前）
  chromium.use(StealthPlugin())

  const browser = await chromium.launch({
    headless,
    ...(browserPath ? { executablePath: browserPath } : {}),
    args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
    '--disable-web-security',
    '--disable-features=BlockInsecurePrivateNetworkRequests',
    '--disable-features=OutOfBlinkCors',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-accelerated-javascript-decoding',
    '--disable-gpu',
    '--disable-infobars',
    '--window-size=1920,1080',
    '--lang=zh-CN',
  ],
  })
  const failures: Error[] = []

  try {
    for (const account of accounts) {
      try {
        await runDouyinAccount(browser, account, yiyans, includeYiyanSource, autoClose)
      } catch (error) {
        const accountError = toError(error)
        failures.push(
          new Error(`[${account.name}] ${accountError.message}`, { cause: accountError }),
        )
        console.error(`账号执行失败：${account.name}`, accountError)
      }
    }

    if (!autoClose) {
      const readline = createInterface({
        input,
        output,
      })

      await readline.question('所有账号已执行完成，按回车键关闭浏览器...')
      readline.close()
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} 个抖音账号执行失败`)
    }
  } finally {
    // 无论任务是否失败，都关闭浏览器以释放 Playwright 持有的进程句柄。
    await browser.close()
  }
}

/**
 * 使用独立浏览器上下文执行一个抖音账号，避免不同账号的 Cookie 相互污染。
 *
 * @param browser Playwright 浏览器实例。
 * @param account 当前执行的抖音账号配置。
 * @param yiyans 可供消息模板使用的一言列表。
 * @param includeYiyanSource 默认消息是否包含一言出处。
 * @param autoClose 执行结束后是否自动关闭浏览器上下文。
 * @returns 账号执行完成后的 Promise。
 */
async function runDouyinAccount(
  browser: Browser,
  account: DouyinAccount,
  yiyans: Yiyan[],
  includeYiyanSource: boolean,
  autoClose: boolean,
): Promise<void> {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    permissions: ['geolocation'],
    geolocation: { longitude: 116.4, latitude: 39.9 },
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  })

  // 注入脚本，删除 webdriver 标记
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    // @ts-ignore
    window.chrome = { runtime: {} }
    // @ts-ignore
    const originalQuery = window.navigator.permissions.query
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ? Promise.resolve({ state: 'denied' } as PermissionStatus) : originalQuery(parameters)
    )
  })
  
  let page: Page | undefined

  try {
    console.log(`开始执行账号：${account.name}`)
    await context.addCookies(account.cookies)

    // 立即读取当前上下文中的所有 Cookie（仅限 douyin.com 域）
    const cookiesAfter = await context.cookies('https://www.douyin.com');
    console.log(`[${account.name}] 添加后总 Cookie 数: ${cookiesAfter.length}`);
    const hasSession = cookiesAfter.some(c => c.name === 'sessionid');
    console.log(`[${account.name}] 是否包含 sessionid: ${hasSession}`);
    if (hasSession) {
        const sessionVal = cookiesAfter.find(c => c.name === 'sessionid')?.value;
        console.log(`[${account.name}] sessionid 值: ${sessionVal}`);
    }
    
    page = await context.newPage()
    // 改用 'commit' 等待，避免资源加载慢导致超时
    await page.goto('https://www.douyin.com/chat', {
      waitUntil: 'commit',
      timeout: 60000,
    })
    
    // --- 处理可能出现的弹窗 ---
    try {
      const saveDialog = page.locator('text=是否保存登录信息').first()
      if (await saveDialog.isVisible({ timeout: 3000 })) {
        await page.locator('text=取消').first().click()
        console.log(`[${account.name}] 已关闭保存登录信息弹窗`)
        await saveDialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
      }
    } catch (e) {
      // 没有弹窗则忽略
    }
    
    // --- 检查是否真的登录成功（通过搜索框是否存在） ---
    const searchInput = page.locator('input.semi-input[placeholder="搜索"]').first()
    const searchVisible = await searchInput
      .waitFor({ state: 'visible', timeout: CHAT_PAGE_READY_TIMEOUT })
      .then(() => true)
      .catch(() => false)
    
    if (!searchVisible) {
      await captureFailureScreenshot(page, account.name)
      throw new Error('聊天页搜索框未出现，可能登录状态无效或页面结构变化')
    }
    
    await waitForChatListReady(page, account.name)

    // 记录未命中的会话，等其余好友都发完再统一报错
    const missingNames: string[] = []
    const needsYiyan =
      account.messageTemplate === undefined ||
      /\{\{\s*(yiyan|from)\s*\}\}/.test(account.messageTemplate)

    for (const targetName of account.targetNames) {
      console.log(`[${account.name}] 开始搜索会话：${targetName}`)

      const searchResult = await searchConversation(page, searchInput, account.name, targetName)

      if (!searchResult) {
        await captureFailureScreenshot(page, `${account.name}-${targetName}-search`)
        console.log(`[${account.name}] 找不到搜索结果，已跳过：${targetName}`)
        missingNames.push(targetName)
        continue
      }

      await searchResult.getByText(/^(发消息|发私信)$/).click({ timeout: 5000 })
      console.log(`[${account.name}] 已打开私信：${targetName}`)

      // ------ 改进后的发送消息逻辑 ------
    const editorInput = page
      .locator(
        '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]',
      )
      .first()
    await editorInput.waitFor({ state: 'visible', timeout: 10000 })
    
    // 1. 聚焦并清空
    await editorInput.focus()
    await page.waitForTimeout(200 + Math.random() * 300)
    await editorInput.evaluate((el: HTMLElement) => {
      el.innerText = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })
    
    // 2. 模拟真人输入
    const message = `hello`
    for (const char of message) {
      await page.keyboard.type(char, { delay: Math.random() * 80 + 20 });
    }
    await page.waitForTimeout(300 + Math.random() * 500)
    
    // 3. 获取发送前的最后一条消息
    const lastMsgBefore = await page
      .locator('.messageListItem, .chat-message-item, [class*="message"]')
      .last()
      .textContent()
      .catch(() => '');
    
    // 4. 发送（优先点击按钮）
    const sendButton = page
      .locator([
        '.send-btn',
        '.chatSendButton',
        '[aria-label="发送"]',
        '.message-send-btn',
        'button:has-text("发送")',
        '.send-button',
        '[data-testid="send-btn"]',
        '.im-send-btn',
      ].join(', '))
      .first()
    
    const sendBtnVisible = await sendButton.isVisible({ timeout: 3000 }).catch(() => false)
    if (sendBtnVisible) {
      await sendButton.click({ force: true })
      console.log(`[${account.name}] 点击发送按钮：${targetName}`)
    } else {
      // 触发完整键盘事件
      await page.evaluate(() => {
        const el = document.querySelector(
          '.messageEditorimChatEditorContainer [data-slate-editor="true"][contenteditable="true"]'
        ) as HTMLElement;
        if (el) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, bubbles: true, cancelable: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', which: 13, bubbles: true }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      console.log(`[${account.name}] 触发 Enter 键盘事件：${targetName}`);
    }
    
    await page.waitForTimeout(1000);
    console.log(`[${account.name}] 消息已发送（未验证）：${targetName}`);
    
    // 6. 随机延迟
    await randomDelay(2000, 5000);
    }
    if (missingNames.length > 0) {
      throw new Error(
        `以下会话未找到，火花可能已经中断：${missingNames.join('、')}。` +
          `好友改昵称是最常见的原因，建议在抖音中为好友设置备注名，` +
          `并把备注名填入账号的 targetNames，这样好友再改昵称也不会影响续火。`,
      )
    }

    console.log(`账号执行完成：${account.name}`)
  } catch (error) {
    // —— 截图容错 ——
    let captureTarget = page
    if (!captureTarget || captureTarget.isClosed()) {
      console.log(`[截图] 原页面已关闭，尝试创建新页面截图...`)
      try {
        if (context && !context.closed()) {
          captureTarget = await context.newPage()
          await captureTarget.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded' }).catch(() => {})
        } else {
          const newContext = await browser.newContext()
          captureTarget = await newContext.newPage()
          await captureTarget.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded' }).catch(() => {})
        }
        console.log(`[截图] 新页面创建完成`)
      } catch (e) {
        console.error(`[截图] 创建新页面失败:`, e)
      }
    }
    // 注意：这里传入 captureTarget 而不是 page
    await captureFailureScreenshot(captureTarget, account.name)
    throw error
  } finally {
    if (autoClose) {
      await context.close()
    }
  }
}
/**
 * 等待会话列表真正渲染出数据再开始搜索。
 *
 * 搜索框会先于会话列表渲染，若此时就输入关键词，抖音的搜索索引尚未就绪，
 * 结果面板会一直为空，导致好友被误判成「改名了」。
 *
 * @param page 当前账号的聊天页。
 * @param accountName 账号名称，仅用于日志。
 * @returns 等待结束后的 Promise，超时也不抛错，交给后续搜索重试兜底。
 */
async function waitForChatListReady(page: Page, accountName: string): Promise<void> {
  const conversationListReady = await page
    .locator('[class*="conversation"], [class*="Conversation"]')
    .first()
    .waitFor({ state: 'visible', timeout: CHAT_PAGE_READY_TIMEOUT })
    .then(() => true)
    .catch(() => false)

  if (!conversationListReady) {
    console.log(`[${accountName}] 会话列表未在预期时间内出现，将依赖搜索重试兜底`)
  }

  // 会话列表的头像与最近消息还会继续拉取，等网络安静下来搜索命中率更高。
  await page.waitForLoadState('networkidle', { timeout: CHAT_PAGE_IDLE_TIMEOUT }).catch(() => {})
}

/**
 * 带重试地搜索会话，避免把「数据还没加载好」误判成「好友改了昵称」。
 *
 * 每一轮都重新清空输入框并等待旧结果消失，防止上一个好友的残留结果被当成命中。
 *
 * @param page 当前账号的聊天页。
 * @param searchInput 聊天页左侧的搜索输入框。
 * @param accountName 账号名称，仅用于日志。
 * @param targetName 需要搜索的好友昵称或备注名。
 * @returns 命中的搜索结果项，全部重试都没命中时返回 undefined。
 */
async function searchConversation(
  page: Page,
  searchInput: Locator,
  accountName: string,
  targetName: string,
): Promise<Locator | undefined> {
  const searchResult = page
    .locator('.SearchPanelitembox')
    .filter({
      has: page.getByText(targetName, { exact: true }),
    })
    .first()

  for (let attempt = 1; attempt <= SEARCH_RETRY_LIMIT; attempt += 1) {
    await searchInput.fill('')
    // 等旧的结果面板收起，否则会读到上一个好友残留的列表项。
    await page
      .locator('.SearchPanelitembox')
      .first()
      .waitFor({ state: 'hidden', timeout: SEARCH_RESULT_TIMEOUT })
      .catch(() => {})
    await page.waitForTimeout(SEARCH_INPUT_RESET_DELAY)
    await searchInput.fill(targetName)

    const searchResultVisible = await searchResult
      .waitFor({ state: 'visible', timeout: SEARCH_RESULT_TIMEOUT })
      .then(() => true)
      .catch(() => false)

    if (searchResultVisible) {
      return searchResult
    }

    if (attempt < SEARCH_RETRY_LIMIT) {
      console.log(
        `[${accountName}] 第 ${attempt} 次搜索未命中，${SEARCH_RETRY_INTERVAL} 毫秒后重试：${targetName}`,
      )
      await page.waitForTimeout(SEARCH_RETRY_INTERVAL)
    }
  }

  return undefined
}

/**
 * 在页面仍可访问时保存失败现场，且不让截图错误覆盖原始任务异常。
 */
async function captureFailureScreenshot(
  page: Page | undefined,
  accountName: string,
): Promise<void> {
  console.log(`[截图] 账号: ${accountName}, page存在: ${!!page}, isClosed: ${page?.isClosed() ?? 'N/A'}`);

  if (!page || page.isClosed()) {
    console.log(`[截图] 跳过截图（原因：页面为空或已关闭）`);
    return;
  }

  try {
    await mkdir(FAILURE_SCREENSHOT_DIRECTORY, { recursive: true })
    const screenshotPath = `${FAILURE_SCREENSHOT_DIRECTORY}/failure-screenshot-${toSafeFileName(accountName)}.png`
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
    })
    console.log(`已保存失败截图：${screenshotPath}`)
  } catch (error) {
    console.error('保存失败截图失败:', error)
  }
}

function toSafeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').replace(/^-+|-+$/g, '') || 'account'
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * 解析 Playwright 可选的浏览器启动路径。
 */
function resolveBrowserPath(): string | undefined {
  const browserPathFromEnv = process.env.PLAYWRIGHT_BROWSER_PATH?.trim()

  if (browserPathFromEnv) {
    return browserPathFromEnv
  }

  return undefined
}

/**
 * 解析 Playwright 是否使用无头模式。
 */
function resolveHeadless(): boolean {
  const headless = process.env.PLAYWRIGHT_HEADLESS?.trim().toLowerCase()

  if (!headless) {
    return true
  }

  if (headless === 'true') {
    return true
  }

  if (headless === 'false') {
    return false
  }

  throw new Error('PLAYWRIGHT_HEADLESS 只能配置为 true 或 false')
}

/**
 * 解析脚本结束后是否自动关闭浏览器。
 */
function resolveAutoClose(): boolean {
  const autoClose = process.env.AUTO_CLOSE?.trim().toLowerCase()

  if (!autoClose) {
    return true
  }

  if (autoClose === 'true') {
    return true
  }

  if (autoClose === 'false') {
    return false
  }

  throw new Error('AUTO_CLOSE 只能配置为 true 或 false')
}

/**
 * 解析发送一言时是否携带出处。
 */
function resolveYiyanIncludeSource(): boolean {
  const includeSource = process.env[YIYAN_INCLUDE_SOURCE_KEY]?.trim().toLowerCase()

  if (!includeSource || includeSource === 'true') {
    return true
  }

  if (includeSource === 'false') {
    return false
  }

  throw new Error(`${YIYAN_INCLUDE_SOURCE_KEY} 只能配置为 true 或 false`)
}

/**
 * 解析自定义火花消息模板，未配置时返回 undefined 以沿用默认的一言格式。
 */
function resolveSparkMessageTemplate(): string | undefined {
  const template = process.env[SPARK_MESSAGE_TEMPLATE_KEY]?.trim()

  if (!template) {
    return undefined
  }

  return normalizeMessageTemplate(template, SPARK_MESSAGE_TEMPLATE_KEY)
}

/**
 * 校验并标准化消息模板。
 */
function normalizeMessageTemplate(template: string, sourceName: string): string {
  // 启动时就校验占位符，避免把写错的 {{xxx}} 原样发给好友。
  const unknownPlaceholders = [
    ...new Set(
      [...template.matchAll(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN)]
        .map((match) => match[1])
        .filter(
          (name) => !MESSAGE_TEMPLATE_PLACEHOLDERS.includes(name as MessageTemplatePlaceholder),
        ),
    ),
  ]

  if (unknownPlaceholders.length > 0) {
    throw new Error(
      `${sourceName} 中存在未识别的占位符：${unknownPlaceholders
        .map((name) => `{{${name}}}`)
        .join(
          '、',
        )}。支持的占位符：${MESSAGE_TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(' ')}`,
    )
  }

  // .env 中难以书写多行值，因此支持用字面 \n 表示换行。
  return template.replace(/\\n/g, '\n')
}

/**
 * 将消息模板渲染为实际发送的文本。
 */
function renderMessageTemplate(
  template: string,
  account: string,
  friend: string,
  yiyan: Yiyan | undefined,
): string {
  // 定时任务跑在 UTC 时区的 runner 上，日期占位符统一按上海时区计算。
  const now = dayjs().tz('Asia/Shanghai')
  const placeholderValues: Record<MessageTemplatePlaceholder, string> = {
    account,
    friend,
    yiyan: yiyan?.hitokoto ?? '',
    from: yiyan?.from ?? '',
    date: now.format('YYYY-MM-DD'),
    time: now.format('HH:mm'),
    weekday: now.format('dddd'),
  }

  return template.replace(MESSAGE_TEMPLATE_PLACEHOLDER_PATTERN, (_match, name: string) => {
    return placeholderValues[name as MessageTemplatePlaceholder] ?? ''
  })
}

/**
 * 解析多账号配置。未配置新变量时，回退到旧的单账号变量。
 */
function resolveDouyinAccounts(globalMessageTemplate: string | undefined): DouyinAccount[] {
  const accountsText = process.env[DOUYIN_ACCOUNTS_KEY]?.trim()

  if (!accountsText) {
    return [
      {
        name: '默认账号',
        cookies: resolveLegacyDouyinCookies(),
        targetNames: resolveLegacyDouyinTargetNames(),
        messageTemplate: globalMessageTemplate,
      },
    ]
  }

  const accountsValue = parseJson(accountsText, DOUYIN_ACCOUNTS_KEY)

  if (!Array.isArray(accountsValue) || accountsValue.length === 0) {
    throw new Error(`${DOUYIN_ACCOUNTS_KEY} 必须是非空账号数组 JSON`)
  }

  const accountNames = new Set<string>()

  return accountsValue.map((value, index) => {
    const sourceName = `${DOUYIN_ACCOUNTS_KEY}[${index}]`

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${sourceName} 必须是账号对象`)
    }

    const accountValue = value as Record<string, unknown>
    const name = resolveAccountName(accountValue.name, sourceName)

    if (accountNames.has(name)) {
      throw new Error(`${DOUYIN_ACCOUNTS_KEY} 中存在重复账号名称：${name}`)
    }
    accountNames.add(name)

    return {
      name,
      cookies: resolveCookieArray(accountValue.cookie, `${sourceName}.cookie`),
      targetNames: resolveTargetNameArray(accountValue.targetNames, `${sourceName}.targetNames`),
      messageTemplate: resolveAccountMessageTemplate(
        accountValue.messageTemplate,
        `${sourceName}.messageTemplate`,
        globalMessageTemplate,
      ),
    }
  })
}

function resolveAccountName(value: unknown, sourceName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${sourceName}.name 必须是非空字符串`)
  }

  return value.trim()
}

function resolveAccountMessageTemplate(
  value: unknown,
  sourceName: string,
  globalMessageTemplate: string | undefined,
): string | undefined {
  if (value === undefined || value === null) {
    return globalMessageTemplate
  }

  if (typeof value !== 'string') {
    throw new Error(`${sourceName} 必须是字符串`)
  }

  const template = value.trim()
  return template ? normalizeMessageTemplate(template, sourceName) : globalMessageTemplate
}

/**
 * 解析旧版单账号 Cookie 配置。
 */
function resolveLegacyDouyinCookies(): Cookie[] {
  const douyinCookieText = process.env[DOUYIN_COOKIE_KEY]?.trim()

  if (!douyinCookieText) {
    throw new Error(
      `请设置 ${DOUYIN_ACCOUNTS_KEY}，或继续使用旧版 ${DOUYIN_COOKIE_KEY} 和 ${DOUYIN_TARGET_NAMES_KEY}`,
    )
  }

  return resolveCookieArray(parseJson(douyinCookieText, DOUYIN_COOKIE_KEY), DOUYIN_COOKIE_KEY)
}

/**
 * 解析旧版单账号会话名称配置。
 */
function resolveLegacyDouyinTargetNames(): string[] {
  const targetNamesText = process.env[DOUYIN_TARGET_NAMES_KEY]?.trim()

  if (!targetNamesText) {
    throw new Error(
      `请设置环境变量 ${DOUYIN_TARGET_NAMES_KEY}，或在 .env 中配置 ${DOUYIN_TARGET_NAMES_KEY}`,
    )
  }

  return resolveTargetNameArray(
    parseJson(targetNamesText, DOUYIN_TARGET_NAMES_KEY),
    DOUYIN_TARGET_NAMES_KEY,
  )
}

function resolveCookieArray(value: unknown, sourceName: string): Cookie[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${sourceName} 必须是非空 Cookie 数组`)
  }

  return (value as DouyinCookie[]).map(toPlaywrightCookie)
}

function resolveTargetNameArray(value: unknown, sourceName: string): string[] {
  const targetNames = value as unknown[]

  if (
    !Array.isArray(targetNames) ||
    targetNames.length === 0 ||
    targetNames.some((targetName) => typeof targetName !== 'string' || !targetName.trim())
  ) {
    throw new Error(`${sourceName} 必须是非空字符串数组`)
  }

  return targetNames.map((targetName) => (targetName as string).trim())
}

function parseJson(value: string, sourceName: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (error) {
    throw new Error(`${sourceName} 不是有效的 JSON`, { cause: error })
  }
}

/**
 * 解析一言数据列表。
 */
async function resolveYiyans(): Promise<Yiyan[]> {
  const yiyanText = await readFile('assets/yiyan.json', 'utf8')
  const yiyans = JSON.parse(yiyanText) as Yiyan[]

  if (!Array.isArray(yiyans) || yiyans.length === 0) {
    throw new Error('assets/yiyan.json 必须是非空数组')
  }

  return yiyans
}

/**
 * 从一言数据中随机挑选一条。
 */
function pickRandomYiyan(yiyans: Yiyan[]): Yiyan {
  return yiyans[Math.floor(Math.random() * yiyans.length)]
}

/**
 * 将抖音 Cookie 数据转换为 Playwright Cookie 数据。
 */
function toPlaywrightCookie(cookie: DouyinCookie): Cookie {
  const playwrightCookie: Cookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session ? -1 : (cookie.expirationDate ?? -1),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: toPlaywrightSameSite(cookie.sameSite),
  }

  return playwrightCookie
}

/**
 * 将抖音 Cookie 的 SameSite 值转换为 Playwright Cookie 值。
 */
function toPlaywrightSameSite(sameSite: SameSite | null): Cookie['sameSite'] {
  if (sameSite === 'no_restriction') {
    return 'None'
  }

  return 'Lax'
}

main().catch((error: unknown) => {
  console.error('启动 Chrome 访问抖音聊天页失败:', error)
  process.exitCode = 1
})

function randomDelay(min: number = 1500, max: number = 4500): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}
