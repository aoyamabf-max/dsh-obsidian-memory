/**
 * GitHub 同步层：把 Obsidian vault 里的记忆笔记推到远端仓库。
 *
 * 为什么不用 git 命令：
 *   - 本机 git 拉私有仓库要交互式凭据（/dev/tty 不可用时直接卡死），
 *     无论 GIT_ASKPASS 还是 credential.helper 都得额外铺一套管道；
 *   - token 一旦拼进 remote URL 就写进 .git/config，撤不干净。
 * 改用 GitHub Contents API：只要 fetch、token 只在内存里、每次请求都能拿到
 * 服务器端的 sha，冲突能当场发现而不是等 push 被拒。
 *
 * 状态文件记录「上次推送时每个文件的 sha256」，据此只推变更过的文件；
 * 首次同步会全量推一遍。删除暂不处理 —— 本地删掉一条记忆不等于想从云端抹掉，
 * 那该是显式操作，不该被一个定时任务顺手做掉。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

const API_ROOT = 'https://api.github.com'
const MAX_PUSH_PER_RUN = 40
const REQUEST_TIMEOUT_MS = 30000

/**
 * 敏感串黑名单：命中的文件**不推**，只记一条失败原因。
 *
 * 为什么是「拒绝推送」而不是「自动打码后推送」：
 * 打码会让我以为记忆完整，实际关键信息已经没了；而且打码规则一旦漏看，
 * 密码就永久留在 git 历史里 —— 删不掉。宁可让这条记忆留在本地，等人工确认。
 *
 * 为什么不用「本机专属口令字面量」：
 * 把真实口令写进这个文件等于把密码抄进源码，换台机器还得跟着改，
 * 而且源码本身会被读到。改为读外置黑名单文件（每行一个普通字符串），
 * 找不到就只用下面这组通用规则。
 */
const SECRET_PATTERNS = [
  { name: 'GitHub token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'GitHub classic token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // 形如 `密码是 xxx` / `password: xxx` / `PASS='xxx'` 的赋值
  { name: 'password assignment', re: /(?:password|passwd|pwd|密码)\s*[:=＝是]\s*['"]?[^\s'"`，。；]{6,}/i },
]

/** 读取外置黑名单（每行一个要拦的字面串，忽略空行与 # 注释）。 */
function loadDenyList(file) {
  if (typeof file !== 'string' || file === '' || !existsSync(file)) return []
  try {
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
  } catch {
    return []
  }
}

function findSecret(text, denyList) {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name
  }
  for (const needle of denyList) {
    if (text.includes(needle)) return 'local blacklist'
  }
  return null
}

function encodePath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/')
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 把 vault 内的绝对路径变成仓库里的相对路径（统一用 /）。 */
function repoPath(vaultRoot, full) {
  return relative(vaultRoot, full).split(sep).join('/')
}

async function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonFile(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2), 'utf8')
}

/**
 * 一次同步的完整流程。调用方负责给已解析的 vault 根目录与配置。
 * 返回值永远是可读的对象，不抛 —— 定时任务里抛异常没人接。
 */
export async function runSync({ vaultRoot, folder, config, stateFile, logger }) {
  const repo = String(config?.repo ?? '').trim()
  const branch = String(config?.branch ?? 'main').trim() || 'main'
  const token = String(config?.token ?? '').trim()
  const denyList = loadDenyList(config?.denyFile)
  const log = typeof logger === 'function' ? logger : () => {}

  if (repo === '') return { ok: false, error: '未配置 GitHub 仓库（no GitHub repo configured）' }
  if (token === '') return { ok: false, error: '未配置 GitHub token（no GitHub token configured）' }
  if (vaultRoot === null) return { ok: false, error: '找不到 vault（vault not found）' }

  const dir = join(vaultRoot, folder)
  if (!existsSync(dir)) return { ok: true, pushed: 0, unchanged: 0, message: '记忆目录为空（memory folder is empty）' }

  const names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.md'))
  const state = await readJsonFile(stateFile, { pushed: {} })
  const pushed = state && typeof state.pushed === 'object' ? state.pushed : {}

  const results = []
  let unchanged = 0
  let attempted = 0

  for (const name of names) {
    if (attempted >= MAX_PUSH_PER_RUN) break
    const full = join(dir, name)
    let text
    try {
      text = await readFile(full, 'utf8')
    } catch {
      continue
    }
    const digest = sha256(text)
    const path = repoPath(vaultRoot, full)
    if (pushed[path] === digest) {
      unchanged += 1
      continue
    }

    attempted += 1

    // 推之前先扫敏感串。命中就整条不推 —— 见 SECRET_PATTERNS 的注释。
    const secret = findSecret(text, denyList)
    if (secret !== null) {
      results.push({ path, status: 'blocked', error: `含敏感串（contains a secret: ${secret}），已跳过（skipped）` })
      log(`blocked ${path} (${secret})`)
      continue
    }

    try {
      // 先问服务器：这个路径上有没有已存在的文件？有就带上它的 sha 覆盖。
      let existingSha = null
      const head = await fetch(`${API_ROOT}/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'dsh-obsidian-memory',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (head.status === 200) {
        const info = await head.json().catch(() => null)
        existingSha = info && typeof info.sha === 'string' ? info.sha : null
      } else if (head.status === 401) {
        return { ok: false, error: 'GitHub token 无效或已过期（GitHub token invalid or expired: 401）' }
      } else if (head.status === 404) {
        // 仓库或分支不存在，也可能是文件不存在 —— 下面 PUT 会给出准确错误。
        existingSha = null
      }

      const body = {
        message: `memory: ${name}`,
        content: Buffer.from(text, 'utf8').toString('base64'),
        branch,
      }
      if (existingSha !== null) body.sha = existingSha

      const put = await fetch(`${API_ROOT}/repos/${repo}/contents/${encodePath(path)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'dsh-obsidian-memory',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      if (put.status === 200 || put.status === 201) {
        pushed[path] = digest
        results.push({ path, status: 'pushed' })
        log(`pushed ${path}`)
      } else {
        const detail = await put.text().catch(() => '')
        let reason = `HTTP ${put.status}`
        try {
          const parsed = JSON.parse(detail)
          if (parsed && typeof parsed.message === 'string') reason = `${reason}: ${parsed.message}`
        } catch {
          if (detail !== '') reason = `${reason}: ${detail.slice(0, 200)}`
        }
        results.push({ path, status: 'failed', error: reason })
        // token 或权限问题后面每条都会失败，没必要继续烧请求。
        if (put.status === 401 || put.status === 403) {
          return { ok: false, error: reason, results }
        }
      }
    } catch (err) {
      results.push({ path, status: 'failed', error: String(err?.message ?? err) })
    }
  }

  await writeJsonFile(stateFile, { pushed, syncedAt: new Date().toISOString() })

  const failed = results.filter((r) => r.status === 'failed')
  const blocked = results.filter((r) => r.status === 'blocked')
  const pushedCount = results.length - failed.length - blocked.length
  const out = {
    ok: failed.length === 0,
    repo,
    branch,
    pushed: pushedCount,
    unchanged,
    failed: failed.length,
    blocked: blocked.length,
    results,
  }

  // 只在真有错误时挂 error 键。写成 `error: undefined` 会让宿主把整个返回值判成
  // 「非无损 JSON」（带显式 undefined 属性的对象过不了快照），于是同步明明成功了，
  // 工具却报 invalid output。
  if (failed.length > 0) out.error = `${failed.length} file(s) failed to push`
  else if (blocked.length > 0) out.error = `${blocked.length} file(s) blocked for containing a secret`

  return out
}
