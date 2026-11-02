/**
 * Host half of dsh-obsidian-memory.
 *
 * 记忆以 Markdown 笔记的形式存进一个 Obsidian vault：
 *   - 笔记正文就是普通 .md，Obsidian 能直接打开、双链、搜索；
 *   - 每条记忆带 YAML frontmatter（id / createdAt / tags / source），
 *     方便人读，也方便本插件按需过滤。
 *
 * 这里只做三件事：定位 vault、读写/检索笔记、把能力暴露成 AI 工具。
 * 界面在 client.js。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

import z from '@deepseek-ai/schemastery'

import {
  DEFAULT_DECAY_FACTOR,
  DEFAULT_PRUNE_THRESHOLD,
  planDecay,
  planPrune,
} from './forget.js'
import {
  buildIndex,
  countTokens,
  expandLinks,
  renderContext,
  searchIndex,
} from './rank.js'
import { runSync } from './sync.js'

export const name = 'dsh-obsidian-memory'

/** 硬依赖放在这里。'skills' 之类可选项不要并进来：硬依赖缺失会让整条 entry 变 INACTIVE。 */
export const inject = ['tools', 'webServer']

/**
 * Loader 配置 Schema —— 有它才会在 DSH 设置界面里出现这一项的配置表单。
 *
 * 必须用 `@deepseek-ai/schemastery`，不能用公开的 `schemastery` 包：只有 DSH 的构建
 * 会把 `meta.volatile` 字段包成 cosmokit 的 `Volatile` 引用，Loader 的 volatile-commit
 * 路径靠遍历这些引用落盘。用公开包构建出来的 schema 产出普通值，写偏好时
 * 「报告成功但值永远不变」。
 *
 * 本插件是本地目录链接安装，`@deepseek-ai/schemastery` 不在它的解析链上，所以
 * `node_modules/@deepseek-ai/{schemastery,cosmokit}` 与 `node_modules/@standard-schema/spec`
 * 是指向 profile 里同名包的软链（见目录内 `README-本地依赖.md`）。
 * 少了这条链 `import` 会 ERR_MODULE_NOT_FOUND，整个插件随之不激活。
 */
export const Config = z.object({
  vaultPath: z
    .string()
    .description('Absolute path to the Obsidian vault. Leave empty to discover it from Obsidian\'s own obsidian.json, preferring the vault that is currently open.')
    .default(''),
  folder: z.string().description('Subfolder for memory notes, relative to the vault root.').default('Memories'),
  maxNoteBytes: z
    .number()
    .description('Maximum body bytes per note; longer notes are truncated. Hard cap 262144 — raising it has no effect.')
    .default(262144),
  repo: z.string().description('GitHub repository to sync to, as owner/name. Leave empty to disable sync.').default(''),
  branch: z.string().description('Branch to push to.').default('main'),
  tokenFile: z
    .string()
    .description('File holding the GitHub token. Empty uses ~/.dsh/dsh-obsidian-memory/token.')
    .default(''),
  denyFile: z
    .string()
    .description('Secret blacklist file, one literal string per line (kept out of the source tree and out of git). Empty uses ~/.dsh/dsh-obsidian-memory/deny.txt.')
    .default(''),
  syncEnabled: z.boolean().description('Whether the sync timer runs.').default(true),
  syncMinutes: z.number().description('Minutes between sync checks (minimum 5).').default(30),
  forgettingEnabled: z
    .boolean()
    .description('Allow decay and archiving to write. Off by default: preview works either way, so look first, then turn it on.')
    .default(false),
  decayFactor: z.number().description('Multiplier applied per decay pass, between 0 and 1. Lower decays faster.').default(0.9),
  pruneThreshold: z.number().description('Notes with importance below this value become eligible for archiving.').default(0.15),
})

// 不声明 Config schema 的话，cordis.patch.yml 里的 config 依然会原样传进 apply(ctx, config)，
// 只是没有 Schema 校验、没有默认值填充、也没有设置界面。下面的 Config 把这三样补齐。

const DEFAULT_FOLDER = 'Memories'
/** 归档目录名。放 Memories 里面（前面带点上），Obsidian 默认不索引点开头目录。 */
const ARCHIVE_DIRNAME = '.archive'
const MAX_NOTE_BYTES = 262144
const MAX_LIST = 500
const DEFAULT_SYNC_MINUTES = 30
const MIN_SYNC_MINUTES = 5

// ── vault 定位 ─────────────────────────────────────────────────────────────

/** 从 Obsidian 自己的 obsidian.json 里找当前打开的 vault。 */
async function vaultFromObsidianJson() {
  const candidates = [
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'obsidian', 'obsidian.json'),
    join(homedir(), 'AppData', 'Roaming', 'obsidian', 'obsidian.json'),
    join(homedir(), '.config', 'obsidian', 'obsidian.json'),
    join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'))
      const vaults = raw && typeof raw.vaults === 'object' && raw.vaults !== null ? raw.vaults : {}
      const entries = Object.values(vaults).filter((v) => v && typeof v.path === 'string')
      if (entries.length === 0) continue
      // 优先取 open=true 的那一个；多个开着就取 ts 最新。
      const open = entries.filter((v) => v.open === true)
      const pool = open.length > 0 ? open : entries
      pool.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))
      return pool[0].path
    } catch {
      // 这个候选文件坏了就看下一个
    }
  }
  return null
}

async function resolveVault(config) {
  const configured = typeof config?.vaultPath === 'string' ? config.vaultPath.trim() : ''
  if (configured !== '') return { path: resolve(configured), source: 'config' }
  const detected = await vaultFromObsidianJson()
  if (detected !== null) return { path: resolve(detected), source: 'obsidian.json' }
  return { path: null, source: 'none' }
}

// ── 笔记读写的公共小工具 ───────────────────────────────────────────────────

function sanitizeFolder(config) {
  const raw = typeof config?.folder === 'string' ? config.folder.trim() : ''
  return raw === '' ? DEFAULT_FOLDER : raw.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '')
}

/** 把任意标题变成安全的文件名：去掉路径分隔符与 Windows 非法字符。 */
function safeFileName(title, fallback) {
  const cleaned = String(title ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/g, '')
  return cleaned === '' ? fallback : cleaned
}

/** 只允许在 vault 内操作：解析后必须仍在 vault 目录下。 */
function insideVault(vaultRoot, target) {
  const rel = relative(vaultRoot, target)
  if (rel === '') return true
  return !rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel)
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function stampForId() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 解析 frontmatter 的极简实现：够本插件自己写出的格式用，不追求 YAML 全语法。 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m === null) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter((s) => s !== '')
    } else {
      value = value.replace(/^["']|["']$/g, '')
    }
    meta[key] = value
  }
  return { meta, body: text.slice(m[0].length) }
}

/**
 * 生成笔记文件内容。
 *
 * frontmatter 字段集参考 Memorose 的 MemoryUnit（crates/memorose-common/src/lib.rs:428），
 * 只留对我们有意义的那几个：
 *   importance  0.0-1.0，遗忘与排序用；缺省 0.5
 *   level       1 = 巩固（一条具体记忆），2 = 洞察（多条归纳出来的结论）
 *   accessCount 被检索命中的次数，用来判断「是不是死记忆」
 *   validTime   这条事实何时开始为真（与 createdAt 构成双时间轴）——
 *               比如「服务器 IP 是 X」这条记忆，写入时间和它成立的时间可能不是一回事
 *   supersededBy 被哪条记忆取代了（旧的不删，留着能追溯「为什么改了」）
 * 旧笔记没有这些字段也能读，缺省值在 parseDoc 里补。
 */
function buildNote({ id, title, createdAt, tags, source, body, importance, level, accessCount, validTime, supersededBy }) {
  const tagLine = Array.isArray(tags) && tags.length > 0 ? `[${tags.join(', ')}]` : '[]'
  const lines = [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `createdAt: ${createdAt}`,
    `tags: ${tagLine}`,
    `source: ${source}`,
    `importance: ${typeof importance === 'number' ? importance : 0.5}`,
    `level: ${typeof level === 'number' ? level : 1}`,
    `accessCount: ${typeof accessCount === 'number' ? accessCount : 0}`,
  ]
  if (typeof validTime === 'string' && validTime !== '') lines.push(`validTime: ${validTime}`)
  if (typeof supersededBy === 'string' && supersededBy !== '') lines.push(`supersededBy: ${supersededBy}`)
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

/** 把 frontmatter 里的值安全转成数字，转不动就用 fallback。 */
function toNumber(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** frontmatter 的 importance / level / accessCount 是笔记的元信息，列表与详情都要用。 */
function noteMetaNumbers(meta) {
  return {
    importance: Math.max(0, Math.min(1, toNumber(meta.importance, 0.5))),
    level: toNumber(meta.level, 1),
    accessCount: toNumber(meta.accessCount, 0),
  }
}

/**
 * 把一个 .md 文件解析成检索用的文档对象。
 *
 * 与 listNotes 的区别：这个要 body 全文（检索与上下文装配需要正文），
 * listNotes 只取前 4 KB 做列表展示，避免列一百条笔记就吃掉几十 MB。
 */
async function parseDoc(vaultRoot, full) {
  let text
  try {
    text = await readFile(full, 'utf8')
  } catch {
    return null
  }
  const { meta, body } = parseFrontmatter(text)
  const fileName = full.split(/[\\/]/).pop()
  return {
    file: relative(vaultRoot, full).split(sep).join('/'),
    title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : fileName.replace(/\.md$/i, ''),
    id: typeof meta.id === 'string' ? meta.id : '',
    createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    source: typeof meta.source === 'string' ? meta.source : '',
    body,
    ...noteMetaNumbers(meta),
    validTime: typeof meta.validTime === 'string' ? meta.validTime : '',
    supersededBy: typeof meta.supersededBy === 'string' ? meta.supersededBy : '',
  }
}

/** 读出整个 folder 的文档并建索引。每次检索重建——记忆条数是几百量级，没必要做缓存失效。 */
async function loadIndex(vaultRoot, folder) {
  const dir = join(vaultRoot, folder)
  if (!existsSync(dir)) return null
  const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.md'))
  const docs = []
  for (const fileName of names) {
    const doc = await parseDoc(vaultRoot, join(dir, fileName))
    if (doc !== null) docs.push(doc)
  }
  return { docs, index: buildIndex(docs) }
}

async function listNotes(vaultRoot, folder) {
  const dir = join(vaultRoot, folder)
  if (!existsSync(dir)) return []
  const names = await readdir(dir)
  const notes = []
  for (const fileName of names) {
    if (!fileName.toLowerCase().endsWith('.md')) continue
    const full = join(dir, fileName)
    let info
    try {
      info = await stat(full)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    let head = ''
    try {
      const raw = await readFile(full, 'utf8')
      head = raw.slice(0, 4000)
    } catch {
      continue
    }
    const { meta } = parseFrontmatter(head)
    notes.push({
      file: relative(vaultRoot, full).split(sep).join('/'),
      title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : fileName.replace(/\.md$/i, ''),
      id: typeof meta.id === 'string' ? meta.id : '',
      createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      bytes: info.size,
      mtime: info.mtimeMs,
      // 面板要显示「这条有多重要、是原始记录还是归纳」，所以列表也得带上这三个字段。
      ...noteMetaNumbers(meta),
      supersededBy: typeof meta.supersededBy === 'string' ? meta.supersededBy : '',
    })
    if (notes.length >= MAX_LIST) break
  }
  notes.sort((a, b) => b.mtime - a.mtime)
  return notes
}

// ── 路由与工具 ─────────────────────────────────────────────────────────────

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function readJsonBody(request, limit = 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        rejectPromise(new Error('请求体过大（request body too large）'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolvePromise({})
      try {
        resolvePromise(JSON.parse(text))
      } catch {
        rejectPromise(new Error('请求体不是合法 JSON（request body is not valid JSON）'))
      }
    })
    request.on('error', rejectPromise)
  })
}

/** 只接受本机同源请求，避免别的网页借浏览器写入记忆。 */
function isTrustedRequest(request) {
  const host = String(request.headers?.host ?? '')
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true // 同源 GET 常无 Origin
  try {
    const u = new URL(origin)
    return u.host === host
  } catch {
    return false
  }
}

export function apply(ctx, config = {}) {
  const folder = sanitizeFolder(config)
  const maxNoteBytes =
    typeof config?.maxNoteBytes === 'number' && config.maxNoteBytes > 0
      ? Math.min(config.maxNoteBytes, MAX_NOTE_BYTES)
      : MAX_NOTE_BYTES

  /** 每次调用都重新解析：用户可能中途换了 vault。 */
  async function vault() {
    const resolved = await resolveVault(config)
    if (resolved.path === null) return null
    if (!existsSync(resolved.path)) return null
    return resolved
  }

  async function ensureFolder(vaultRoot) {
    const dir = join(vaultRoot, folder)
    if (!insideVault(vaultRoot, dir)) throw new Error('设置里的 folder 越出了 vault 目录（the configured folder escapes the vault）')
    if (!existsSync(dir)) await mkdir(dir, { recursive: true })
    return dir
  }

  async function saveNote(input) {
    const resolved = await vault()
    if (resolved === null) {
      return { ok: false, error: '找不到 Obsidian vault（Obsidian vault not found）。请先在 Obsidian 里打开一个 vault，或在插件设置里填 vaultPath（open a vault in Obsidian first, or set vaultPath in the plugin settings）。' }
    }
    const title = String(input?.title ?? '').trim()
    const bodyRaw = String(input?.body ?? '')
    if (bodyRaw.trim() === '') return { ok: false, error: 'body 不能为空（body must not be empty）' }
    const clipped = bodyRaw.length > maxNoteBytes ? bodyRaw.slice(0, maxNoteBytes) + '\n\n… (truncated)' : bodyRaw
    const dir = await ensureFolder(resolved.path)
    const id = `mem-${stampForId()}`
    const fileName = `${id} ${safeFileName(title, 'Untitled')}.md`
    const full = join(dir, fileName)
    if (!insideVault(resolved.path, full)) return { ok: false, error: '目标路径越出了 vault 目录（the target path escapes the vault）' }
    const tags = Array.isArray(input?.tags) ? input.tags.map((t) => String(t).trim()).filter((t) => t !== '') : []
    const content = buildNote({
      id,
      title: title === '' ? 'Untitled' : title,
      createdAt: timestamp(),
      tags,
      source: typeof input?.source === 'string' && input.source !== '' ? input.source : 'dsh',
      body: clipped,
    })
    await writeFile(full, content, 'utf8')
    return {
      ok: true,
      id,
      file: relative(resolved.path, full).split(sep).join('/'),
      vault: resolved.path,
      vaultSource: resolved.source,
      bytes: Buffer.byteLength(content),
    }
  }

  /** 先写临时文件再 rename：避免写到一半留下半截笔记。 */
  async function writeAtomic(full, content) {
    const tmp = `${full}.tmp-${Date.now()}`
    await writeFile(tmp, content, 'utf8')
    try {
      await rename(tmp, full)
    } catch (err) {
      try {
        await unlink(tmp)
      } catch {
        // 临时文件清不掉也不该盖住真正的错误
      }
      throw err
    }
  }

  /** 覆盖已有笔记：保留 id / createdAt / source，只改标题、正文、标签。 */
  async function updateNote(input) {
    const resolved = await vault()
    if (resolved === null) return { ok: false, error: '找不到 Obsidian vault（Obsidian vault not found）。' }
    const file = String(input?.file ?? '').trim()
    if (file === '') return { ok: false, error: '缺少 file（missing "file"）' }
    const full = resolve(resolved.path, file)
    if (!insideVault(resolved.path, full)) return { ok: false, error: 'file 越出了 vault 目录（the path escapes the vault）' }
    if (!existsSync(full)) return { ok: false, error: '笔记不存在（note not found）' }
    const text = await readFile(full, 'utf8')
    const { meta, body } = parseFrontmatter(text)
    const wantedTitle = typeof input?.title === 'string' ? input.title.trim() : ''
    const fallbackTitle = String(meta.title ?? '').trim()
    const title = wantedTitle !== '' ? wantedTitle : fallbackTitle !== '' ? fallbackTitle : 'Untitled'
    const bodyRaw = typeof input?.body === 'string' ? input.body : body
    if (bodyRaw.trim() === '') return { ok: false, error: 'body 不能为空（body must not be empty）' }
    const clipped =
      bodyRaw.length > maxNoteBytes ? bodyRaw.slice(0, maxNoteBytes) + ' <!-- truncated -->' : bodyRaw
    const tags = Array.isArray(input?.tags)
      ? input.tags.map((tag) => String(tag).trim()).filter((tag) => tag !== '')
      : Array.isArray(meta.tags)
        ? meta.tags
        : []
    // 这几个字段允许显式改，否则原样带过来。
    // 不能漏：buildNote 会整段重写 frontmatter，漏一个字段就等于把它重置成默认值
    // （比如 importance 被悄悄打回 0.5，衰减了几轮的记录就白做了）。
    const numOr = (v, fallback) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    const pick = (inputVal, metaVal) => {
      if (typeof inputVal === 'string') return inputVal.trim()
      if (typeof metaVal === 'string') return metaVal
      return ''
    }
    const content = buildNote({
      id: typeof meta.id === 'string' && meta.id !== '' ? meta.id : `mem-${stampForId()}`,
      title,
      createdAt: typeof meta.createdAt === 'string' && meta.createdAt !== '' ? meta.createdAt : timestamp(),
      tags,
      source: typeof meta.source === 'string' && meta.source !== '' ? meta.source : 'dsh',
      body: clipped,
      importance: numOr(input?.importance, numOr(meta.importance, 0.5)),
      level: numOr(input?.level, numOr(meta.level, 1)),
      accessCount: numOr(input?.accessCount, numOr(meta.accessCount, 0)),
      validTime: pick(input?.validTime, meta.validTime),
      supersededBy: pick(input?.supersededBy, meta.supersededBy),
    })
    await writeAtomic(full, content)
    return {
      ok: true,
      file: relative(resolved.path, full).split(sep).join('/'),
      vault: resolved.path,
      bytes: Buffer.byteLength(content),
    }
  }

  /**
   * 检索记忆。
   *
   * 换掉了原来的子串匹配 —— 那种写法搜「部署」搜不到「上线」，
   * 长笔记因为只按「命中/未命中」计分，短笔记反而天然占便宜。
   * 现在是 BM25 + wikilink 扩展，判据见 rank.js。
   */
  async function searchNotes(query, limit, options = {}) {
    const resolved = await vault()
    if (resolved === null) return { ok: false, error: '找不到 Obsidian vault（Obsidian vault not found）。' }
    const loaded = await loadIndex(resolved.path, folder)
    if (loaded === null) return { ok: true, vault: resolved.path, total: 0, tokens: 0, hits: [] }

    const q = String(query ?? '').trim()
    const cap = typeof limit === 'number' && limit > 0 ? Math.min(limit, 50) : 20
    let ranked = searchIndex(loaded.index, q, { limit: cap })
    if (options.expandLinks !== false) {
      ranked = expandLinks(loaded.index, ranked, { extra: Math.min(6, cap) })
    }

    const hits = ranked.map((hit) => {
      const doc = loaded.index.docs[hit.index]
      // 片段仍按命中的词定位，让调用方看到「为什么这条被选中」
      const needle = q.toLowerCase()
      let snippet = doc.body.replace(/\s+/g, ' ').trim().slice(0, 180)
      if (needle !== '') {
        const at = doc.body.toLowerCase().indexOf(needle)
        if (at !== -1) {
          snippet = doc.body.slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, ' ').trim()
        }
      }
      return {
        file: doc.file,
        title: doc.title,
        createdAt: doc.createdAt,
        tags: doc.tags,
        importance: doc.importance,
        level: doc.level,
        score: Math.round(hit.score * 1000) / 1000,
        via: hit.via ?? 'match',
        snippet,
      }
    })

    return {
      ok: true,
      vault: resolved.path,
      total: hits.length,
      tokens: hits.reduce((sum, h) => sum + countTokens(h.snippet), 0),
      hits,
    }
  }

  /**
   * 按 token 预算装配上下文。
   *
   * 学的是 Memorose 的 /v1/memory/context：调用方说「我只有 N 个 token」，
   * 由检索层负责裁剪，而不是把原始片段一股脑丢给模型自己掂量。
   */
  async function buildContext(query, tokenBudget, limit) {
    const resolved = await vault()
    const budget = Math.max(1, Math.round(Number(tokenBudget) || 800))
    if (resolved === null) return { ok: false, error: '找不到 Obsidian vault（Obsidian vault not found）。' }
    const loaded = await loadIndex(resolved.path, folder)
    if (loaded === null) {
      return {
        ok: true, vault: resolved.path, context: '', tier: 'detailed', tokenBudget: budget,
        usedTokenEstimate: 0, matchedCount: 0, includedCount: 0, truncated: false, hits: [],
      }
    }
    const cap = typeof limit === 'number' && limit > 0 ? Math.min(limit, 50) : 20
    let ranked = searchIndex(loaded.index, String(query ?? ''), { limit: Math.max(cap, 24) })
    ranked = expandLinks(loaded.index, ranked, { extra: 6 })
    const rendered = renderContext(loaded.index, ranked, { tokenBudget: budget, format: 'text' })
    return {
      ok: true,
      vault: resolved.path,
      context: rendered.context,
      tier: rendered.tier,
      tokenBudget: rendered.tokenBudget,
      usedTokenEstimate: rendered.usedTokenEstimate,
      matchedCount: rendered.matchedCount,
      includedCount: rendered.includedCount,
      truncated: rendered.truncated,
      hits: rendered.hits,
    }
  }

  /**
   * 记忆衰减 / 归档。
   *
   * 分 preview 与 execute 两步：preview 只算不写，让人先看清要动哪些。
   * **默认关闭**（config.forgettingEnabled 必须是 true 才肯落盘）。
   * execute 也只做两件事：改 importance、把够格的笔记挪进 .archive/。
   * 不 unlink —— 记忆是用户的东西，插件没有资格物理删除。
   */
  async function runForgetting(action, options = {}) {
    const resolved = await vault()
    if (resolved === null) return { ok: false, error: '找不到 Obsidian vault（Obsidian vault not found）。' }
    const loaded = await loadIndex(resolved.path, folder)
    if (loaded === null) return { ok: true, vault: resolved.path, action, candidates: [], keep: [], applied: 0 }

    const docs = loaded.docs
    // 取值优先级：本次调用的参数 > 插件配置 > 内置默认。
    // 配置项漏读的话，cordis.patch.yml 里写的值就是不生效的死配置。
    const pickNumber = (...candidates) => {
      for (const c of candidates) {
        const n = Number(c)
        if (Number.isFinite(n) && n > 0) return n
      }
      return undefined
    }
    const factor =
      pickNumber(options.factor, config?.decayFactor) ?? DEFAULT_DECAY_FACTOR
    const threshold =
      pickNumber(options.threshold, config?.pruneThreshold) ?? DEFAULT_PRUNE_THRESHOLD

    const decayPlan = planDecay(docs, factor)
    const { prune, keep } = planPrune(docs, threshold)

    if (action !== 'execute') {
      return {
        ok: true,
        vault: resolved.path,
        action: 'preview',
        enabled: config?.forgettingEnabled === true,
        factor,
        threshold,
        decay: decayPlan.filter((d) => d.changed),
        prune,
        keep,
        dryRun: true,
      }
    }

    if (config?.forgettingEnabled !== true) {
      return {
        ok: false,
        error: '遗忘机制默认关闭（forgetting is off by default）。确认要动记忆就先把 forgettingEnabled 设为 true 再调 execute（set forgettingEnabled to true before calling execute）。',
        action: 'execute',
        enabled: false,
        wouldDecay: decayPlan.filter((d) => d.changed).length,
        wouldPrune: prune.length,
      }
    }

    const changes = []
    const archiveDir = join(resolved.path, folder, ARCHIVE_DIRNAME)

    for (const item of decayPlan) {
      if (!item.changed) continue
      const full = resolve(resolved.path, item.file)
      if (!insideVault(resolved.path, full) || !existsSync(full)) continue
      const text = await readFile(full, 'utf8')
      const { meta, body } = parseFrontmatter(text)
      const rebuilt = buildNote({
        id: typeof meta.id === 'string' && meta.id !== '' ? meta.id : `mem-${stampForId()}`,
        title: typeof meta.title === 'string' && meta.title !== '' ? meta.title : 'Untitled',
        createdAt: typeof meta.createdAt === 'string' && meta.createdAt !== '' ? meta.createdAt : timestamp(),
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        source: typeof meta.source === 'string' && meta.source !== '' ? meta.source : 'dsh',
        body,
        importance: item.after,
        level: Number(meta.level) || 1,
        accessCount: Number(meta.accessCount) || 0,
        validTime: typeof meta.validTime === 'string' ? meta.validTime : '',
        supersededBy: typeof meta.supersededBy === 'string' ? meta.supersededBy : '',
      })
      await writeAtomic(full, rebuilt)
      changes.push({ file: item.file, action: 'decay', before: item.before, after: item.after })
    }

    for (const item of prune) {
      const full = resolve(resolved.path, item.file)
      if (!insideVault(resolved.path, full) || !existsSync(full)) continue
      await mkdir(archiveDir, { recursive: true })
      const target = join(archiveDir, full.split(/[\\/]/).pop())
      // 同名就加时间戳后缀，绝不覆盖已归档的内容
      let finalTarget = target
      if (existsSync(finalTarget)) {
        finalTarget = target.replace(/\.md$/i, `-${stampForId()}.md`)
      }
      await rename(full, finalTarget)
      changes.push({
        file: item.file,
        action: 'archive',
        to: relative(resolved.path, finalTarget).split(sep).join('/'),
      })
    }

    return {
      ok: true,
      vault: resolved.path,
      action: 'execute',
      enabled: true,
      factor,
      threshold,
      applied: changes.length,
      changes,
      keep,
    }
  }

  // ── HTTP 路由 ────────────────────────────────────────────────────────────

  const routeBase = '/api/dsh-obsidian-memory'

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: `${routeBase}/notes`,
      handler: async (request, response) => {
        try {
          const resolved = await vault()
          if (resolved === null) {
            sendJson(response, 200, { ok: false, error: 'vault-missing', vault: null, notes: [] })
            return
          }
          const notes = await listNotes(resolved.path, folder)
          sendJson(response, 200, { ok: true, vault: resolved.path, vaultSource: resolved.source, folder, notes })
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${routeBase}/note`,
      handler: async (request, response) => {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const file = String(url.searchParams.get('file') ?? '').trim()
          const resolved = await vault()
          if (resolved === null) {
            sendJson(response, 200, { ok: false, error: 'vault-missing' })
            return
          }
          if (file === '') {
            sendJson(response, 400, { ok: false, error: '缺少 file 参数（missing "file" parameter）' })
            return
          }
          const full = resolve(resolved.path, file)
          if (!insideVault(resolved.path, full)) {
            sendJson(response, 400, { ok: false, error: 'file 越出了 vault 目录（the path escapes the vault）' })
            return
          }
          if (!existsSync(full)) {
            sendJson(response, 404, { ok: false, error: '笔记不存在（note not found）' })
            return
          }
          const text = await readFile(full, 'utf8')
          const { meta, body } = parseFrontmatter(text)
          sendJson(response, 200, { ok: true, file, meta, body })
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${routeBase}/search`,
      handler: async (request, response) => {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const q = String(url.searchParams.get('q') ?? '')
          const limitRaw = Number(url.searchParams.get('limit') ?? '20')
          const expandRaw = url.searchParams.get('expand')
          const result = await searchNotes(q, Number.isFinite(limitRaw) ? limitRaw : 20, {
            expandLinks: expandRaw !== '0',
          })
          sendJson(response, result.ok === true ? 200 : 200, result)
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${routeBase}/context`,
      handler: async (request, response) => {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const q = String(url.searchParams.get('q') ?? '')
          const budgetRaw = Number(url.searchParams.get('budget') ?? '800')
          const limitRaw = Number(url.searchParams.get('limit') ?? '20')
          const result = await buildContext(
            q,
            Number.isFinite(budgetRaw) ? budgetRaw : 800,
            Number.isFinite(limitRaw) ? limitRaw : 20,
          )
          sendJson(response, result.ok === true ? 200 : 400, result)
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${routeBase}/save`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: '只接受 POST（POST only）' })
          return
        }
        if (!isTrustedRequest(request)) {
          sendJson(response, 403, { ok: false, error: '已拒绝非本机同源请求（rejected: not a loopback same-origin request）' })
          return
        }
        try {
          const body = await readJsonBody(request)
          const result = await saveNote(body)
          sendJson(response, result.ok === true ? 200 : 400, result)
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${routeBase}/update`,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { ok: false, error: '只接受 POST（POST only）' })
          return
        }
        if (!isTrustedRequest(request)) {
          sendJson(response, 403, { ok: false, error: '已拒绝非本机同源请求（rejected: not a loopback same-origin request）' })
          return
        }
        try {
          const body = await readJsonBody(request)
          const result = await updateNote(body)
          sendJson(response, result.ok === true ? 200 : 400, result)
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${routeBase}/forget`,
      handler: async (request, response) => {
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const action = String(url.searchParams.get('action') ?? 'preview')
          const factorRaw = Number(url.searchParams.get('factor') ?? '')
          const thresholdRaw = Number(url.searchParams.get('threshold') ?? '')
          const result = await runForgetting(action, {
            factor: Number.isFinite(factorRaw) ? factorRaw : undefined,
            threshold: Number.isFinite(thresholdRaw) ? thresholdRaw : undefined,
          })
          sendJson(response, result.ok === true ? 200 : 400, result)
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: `${routeBase}/sync`,
      handler: async (request, response) => {
        if (!isTrustedRequest(request)) {
          sendJson(response, 403, { ok: false, error: '已拒绝非本机同源请求（rejected: not a loopback same-origin request）' })
          return
        }
        try {
          if (request.method === 'GET') {
            const resolved = await vault()
            sendJson(response, 200, {
              ok: true,
              enabled: config?.syncEnabled !== false,
              repo: typeof config?.repo === 'string' ? config.repo : '',
              branch: typeof config?.branch === 'string' ? config.branch : 'main',
              intervalMinutes: syncMinutes(),
              hasToken: (await resolveToken()) !== '',
              vault: resolved === null ? null : resolved.path,
              last: lastSync,
            })
            return
          }
          if (request.method === 'POST') {
            let body = {}
            try {
              body = await readJsonBody(request)
            } catch {
              body = {}
            }
            const result = await doSync(typeof body?.reason === 'string' ? body.reason : 'manual')
            sendJson(response, result.ok === true ? 200 : 400, result)
            return
          }
          sendJson(response, 405, { ok: false, error: '只接受 GET 或 POST（GET or POST only）' })
        } catch (err) {
          sendJson(response, 500, { ok: false, error: String(err?.message ?? err) })
        }
      },
    }),
  ]

  const stateDir = join(homedir(), '.dsh', 'dsh-obsidian-memory')
  const syncStateFile = join(stateDir, 'sync-state.json')

  /**
   * token 优先取 config.token，其次取单独的 token 文件（不必写进 cordis.patch.yml）。
   * 注意 tokenFile 的 schema 默认值是空串，空串必须回落到默认路径 —— 不能当成「没配」。
   */
  async function resolveToken() {
    const fromConfig = typeof config?.token === 'string' ? config.token.trim() : ''
    if (fromConfig !== '') return fromConfig
    const tokenFile = resolveStateFile(config?.tokenFile, 'token')
    if (tokenFile === null || !existsSync(tokenFile)) return ''
    try {
      return (await readFile(tokenFile, 'utf8')).trim()
    } catch {
      return ''
    }
  }

  /**
   * 把「可配置的状态文件路径」解析成绝对路径：空串/未定义一律回落到 stateDir 下的默认名。
   * 这是本插件里所有 stateDir 文件的统一入口，避免每个调用点各写一遍空串判断。
   */
  function resolveStateFile(configured, defaultName) {
    const raw = typeof configured === 'string' ? configured.trim() : ''
    return raw === '' ? join(stateDir, defaultName) : raw
  }

  function syncMinutes() {
    const raw = Number(config?.syncMinutes)
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SYNC_MINUTES
    return Math.max(MIN_SYNC_MINUTES, Math.round(raw))
  }

  let lastSync = null
  let syncing = false

  async function doSync(reason) {
    if (config?.syncEnabled === false) return { ok: false, error: '同步已在设置里关闭（sync is disabled in settings）' }
    if (syncing) return { ok: false, error: '上一次同步还没结束（the previous sync is still running）' }
    syncing = true
    try {
      const resolved = await vault()
      const token = await resolveToken()
      const result = await runSync({
        vaultRoot: resolved === null ? null : resolved.path,
        folder,
        config: {
          repo: config?.repo,
          branch: config?.branch,
          token,
          denyFile: resolveStateFile(config?.denyFile, 'deny.txt'),
        },
        stateFile: syncStateFile,
        logger: null,
      })
      lastSync = { at: new Date().toISOString(), reason, ...result }
      return lastSync
    } finally {
      syncing = false
    }
  }

  const startSync = () => {
    const minutes = syncMinutes()
    const timer = setInterval(() => {
      void doSync('timer')
    }, minutes * 60 * 1000)
    // 定时器不该拖住进程退出
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }

  // ── AI 工具 ──────────────────────────────────────────────────────────────

  const tools = [
    {
      name: 'obsidian_remember',
      description:
        'Write one memory into the Obsidian vault as a Markdown note with YAML frontmatter. Use it when the user asks to remember something, or for conclusions, decisions and preferences worth keeping long term. The note is a permanent file: keep the title short and searchable.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Memory title; becomes part of the filename. Keep it short and searchable.' },
          body: { type: 'string', description: 'Memory body, in Markdown.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
          source: { type: 'string', description: 'Optional source marker, such as a session id or repository name.' },
        },
        required: ['title', 'body'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            file: { type: 'string' },
            vault: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) =>
          value?.ok === true
            ? [{ type: 'text', text: `Wrote ${value.file} (vault: ${value.vault})` }]
            : [{ type: 'text', text: `Write failed: ${value?.error ?? 'unknown reason'}` }],
      },
      async execute(args) {
        return saveNote(args)
      },
    },
    {
      name: 'obsidian_search',
      description: 'Search memory notes in the Obsidian vault by keyword; returns title, time, tags and matching excerpts.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Search keywords; leave empty to list the most recent notes.' },
          limit: { type: 'integer', description: 'Maximum results, default 20.' },
          expandLinks: {
            type: 'boolean',
            description: 'Also return neighbours reached through [[wikilinks]]; default true. Pass false for exact matches only.',
          },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            total: { type: 'integer' },
            hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) => {
          if (value?.ok !== true) return [{ type: 'text', text: `Search failed: ${value?.error ?? 'unknown reason'}` }]
          const hits = Array.isArray(value.hits) ? value.hits : []
          if (hits.length === 0) return [{ type: 'text', text: 'No matching memories.' }]
          const lines = hits.slice(0, 10).map((h) => `- ${h.title}${h.createdAt ? `（${h.createdAt}）` : ''} — ${h.file}`)
          return [{ type: 'text', text: `${value.total} hit(s):\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        return searchNotes(args?.query, args?.limit, { expandLinks: args?.expandLinks !== false })
      },
    },
    {
      name: 'obsidian_context',
      description:
        'Assemble memory context under a token budget. Use it when you want relevant memories placed into context rather than a list of search hits: give a tokenBudget and the plugin trims to fit exactly, keeping the most important entries first.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'What to look for.' },
          tokenBudget: {
            type: 'integer',
            description: 'Token budget for the assembled context, default 800. Up to 160 gives a minimal summary, up to 480 gives medium detail, above that gives the full summary.',
          },
          limit: { type: 'integer', description: 'Maximum candidates to consider, default 20.' },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            context: { type: 'string' },
            tier: { type: 'string' },
            tokenBudget: { type: 'integer' },
            usedTokenEstimate: { type: 'integer' },
            matchedCount: { type: 'integer' },
            includedCount: { type: 'integer' },
            truncated: { type: 'boolean' },
            hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) => {
          if (value?.ok !== true) return [{ type: 'text', text: `Context assembly failed: ${value?.error ?? 'unknown reason'}` }]
          if (!value.context) return [{ type: 'text', text: 'No matching memories.' }]
          const tail = value.truncated ? ' (trimmed to fit the budget)' : ''
          const head = `Memory context ${value.usedTokenEstimate}/${value.tokenBudget} tokens, ${value.tier} tier, ${value.includedCount}/${value.matchedCount} note(s) included${tail}:`
          return [{ type: 'text', text: `${head}\n${value.context}` }]
        },
      },
      async execute(args) {
        return buildContext(args?.query, args?.tokenBudget, args?.limit)
      },
    },
    {
      name: 'obsidian_forget',
      description:
        'Memory decay and archiving. By default this only previews (computes, writes nothing) so you can see what would move first. Writing requires forgettingEnabled=true in the plugin config. Archiving only moves notes into Memories/.archive/; no file is deleted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['preview', 'execute'],
            description: 'preview only computes and writes nothing; execute actually writes, and requires forgettingEnabled=true.',
          },
          factor: { type: 'number', description: `Decay factor, default ${DEFAULT_DECAY_FACTOR}; importance is multiplied by it.` },
          threshold: {
            type: 'number',
            description: `Archive threshold, default ${DEFAULT_PRUNE_THRESHOLD}; notes below it become candidates for archiving.`,
          },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            decay: { type: 'array', items: { type: 'object', additionalProperties: true } },
            prune: { type: 'array', items: { type: 'object', additionalProperties: true } },
            keep: { type: 'array', items: { type: 'object', additionalProperties: true } },
            applied: { type: 'integer' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) => {
          if (value?.ok !== true) return [{ type: 'text', text: `Failed: ${value?.error ?? 'unknown reason'}` }]
          if (value.action === 'execute') {
            return [{ type: 'text', text: `Applied to ${value.applied} note(s): ${JSON.stringify(value.changes ?? [])}` }]
          }
          const decay = Array.isArray(value.decay) ? value.decay : []
          const prune = Array.isArray(value.prune) ? value.prune : []
          const keep = Array.isArray(value.keep) ? value.keep : []
          const lines = [`Preview (nothing written yet): ${decay.length} would decay, ${prune.length} could be archived, ${keep.length} kept for a reason.`]
          for (const d of decay.slice(0, 8)) lines.push(`  decay ${d.title}: ${d.before} → ${d.after}`)
          for (const p of prune.slice(0, 8)) lines.push(`  archive ${p.title} (importance ${p.importance})`)
          for (const k of keep.slice(0, 5)) lines.push(`  keep ${k.title}: ${k.reason}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        return runForgetting(
          String(args?.action ?? 'preview'),
          { factor: args?.factor, threshold: args?.threshold },
        )
      },
    },
    {
      name: 'obsidian_read',
      description: 'Read one memory note by its vault-relative path.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', description: 'Vault-relative path, such as Memories/mem-20261102-090000 Title.md' },
        },
        required: ['file'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            body: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) => [
          { type: 'text', text: value?.ok === true ? String(value.body ?? '').slice(0, 8000) : `Read failed: ${value?.error ?? 'unknown reason'}` },
        ],
      },
      async execute(args) {
        const resolved = await vault()
        if (resolved === null) return { ok: false, error: '找不到 Obsidian vault（Obsidian vault not found）。' }
        const file = String(args?.file ?? '').trim()
        if (file === '') return { ok: false, error: '缺少 file（missing "file"）' }
        const full = resolve(resolved.path, file)
        if (!insideVault(resolved.path, full)) return { ok: false, error: 'file 越出了 vault 目录（the path escapes the vault）' }
        if (!existsSync(full)) return { ok: false, error: '笔记不存在（note not found）' }
        const text = await readFile(full, 'utf8')
        const { meta, body } = parseFrontmatter(text)
        return { ok: true, meta, body }
      },
    },
    {
      name: 'obsidian_update',
      description:
        'Overwrite an existing memory note. Only title, body and tags change; id, createdAt and source keep their original values and the filename stays the same. Read the note with obsidian_read first so you do not overwrite content you have not seen.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', description: 'Vault-relative path, as returned by obsidian_search.' },
          title: { type: 'string', description: 'New title; omit to keep the current one.' },
          body: { type: 'string', description: 'New body in Markdown; omit to keep the current one.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'New tags; omit to keep the current ones.' },
        },
        required: ['file'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            file: { type: 'string' },
            bytes: { type: 'integer' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) =>
          value?.ok === true
            ? [{ type: 'text', text: `Updated ${value.file} (${value.bytes} bytes)` }]
            : [{ type: 'text', text: `Update failed: ${value?.error ?? 'unknown reason'}` }],
      },
      async execute(args) {
        return updateNote(args)
      },
    },
    {
      name: 'obsidian_sync',
      description:
        'Push memory notes from the Obsidian vault to the configured private GitHub repository. The timer already runs every syncMinutes; use this tool to push now, for example right after writing something important. Only changed files are pushed, and it errors out when no repository or token is configured.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reason: { type: 'string', description: 'Optional reason for this manual sync; it is recorded in the log.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            pushed: { type: 'integer' },
            unchanged: { type: 'integer' },
            failed: { type: 'integer' },
            repo: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (args, value) => {
          if (value?.ok !== true) {
            const pushed = Number(value?.pushed) || 0
            const failed = Number(value?.failed) || 0
            return [
              {
                type: 'text',
                text: `Sync incomplete: ${value?.error ?? 'unknown reason'} (pushed ${pushed}, failed ${failed} this run)`,
              },
            ]
          }
          return [
            {
              type: 'text',
              text: `Sync complete → ${value.repo}: pushed ${value.pushed}, unchanged ${value.unchanged}.`,
            },
          ]
        },
      },
      async execute(args) {
        const result = await doSync(typeof args?.reason === 'string' ? args.reason : 'manual')
        return result
      },
    },
  ]

  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool))
  }

  // ── 定时推送 ─────────────────────────────────────────────────────────────
  // 放最后启动：路由和工具都注册完了，第一次定时到点才不会撞上没准备好的状态。
  if (config?.syncEnabled !== false) {
    disposers.push(startSync())
  }

  // ── 让 AI 自己判断该记什么 ───────────────────────────────────────────────
  // 'systemPrompt' 用独立 inject：它缺失时最坏只是这段提示词不生效，
  // 不该连带把 tools/webServer 一起置为 INACTIVE。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'tool:obsidian_memory',
      order: 113,
      text: [
        'Memory tools backed by an Obsidian vault: obsidian_remember / obsidian_search / obsidian_context / obsidian_read / obsidian_update / obsidian_forget / obsidian_sync.',
        '',
        'Do not wait for the user to say "remember this". Write a memory on your own when any of these happens:',
        '- A long-term preference, form of address or habit the user states explicitly (how they want you to talk, what not to do).',
        '- A decision that has been made, together with its reasoning — especially "why A and not B". The reason outlives the conclusion, so keep it.',
        '- A problem you hit and how it was solved (the exact error text, the root cause, the fix), so the next occurrence is a lookup rather than a rediscovery.',
        '- Facts that exist only on this machine: paths, ports, service names, how things are deployed, and where credentials live (**where they live, never the secret itself**).',
        '',
        'Do not record: one-off intermediate steps, anything you can read straight from the code or docs, passing remarks, discussions that reached no conclusion,',
        'or any password, token or private key in plain text.',
        '',
        'Before writing, run obsidian_search to see whether a note on the same subject already exists: extend it with obsidian_update if so, create one with obsidian_remember if not.',
        'That keeps one topic from turning into five near-duplicate notes. Keep titles short and searchable; make the body answer what it is, why it matters, and how to use it.',
      ].join('\n'),
    })
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载阶段单个资源失败不应阻断其余清理
      }
    }
  }
}
