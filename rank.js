/**
 * 检索与上下文装配层。
 *
 * 设计依据：Memorose（ai-akashic/Memorose，Apache-2.0）的
 *   crates/memorose-common/src/tokenizer.rs        —— count_tokens 确定性估算
 *   crates/memorose-server/src/main.rs:1276/1236   —— 三档自适应压缩 + 按 level 优先级
 *   crates/memorose-core/src/engine/search.rs      —— 混合检索思路（此处只做 BM25 + 链接扩展）
 *
 * 只借鉴思想，不照搬代码：它是 Rust 多 crate 服务，我们是单文件 Node 插件。
 * 刻意没抄的：向量检索（需要 embedding 服务，本机离线）、Louvain 社区检测、
 * 多模态、任务树 —— 那些成本远大于收益。
 */

/** 三档预算阈值，抄自 Memorose 的 context_compression_tier()。 */
export const TIER_TINY = 160
export const TIER_COMPACT = 480

// ── token 估算 ──────────────────────────────────────────────────────────────

function isCjk(code) {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af)
  )
}

/**
 * 确定性 token 估算，不联网、不加载分词器。
 *
 * 规则沿用 Memorose 的判据（它那边有单测钉死：count_tokens("Rust")===1、
 * count_tokens("Memorose runtime")===4、count_tokens("北京")===2）：
 *   CJK 每字算 1；ASCII 连续段约 4 字符/token；其他字母连续段约 2 字符/token；
 *   标点各算 1；空白切断连续段。
 * 它刻意偏保守（宁可高估），这样预算裁剪不会把内容撑爆。
 */
export function countTokens(text) {
  const s = String(text ?? '')
  let total = 0
  let asciiRun = 0
  let unicodeRun = 0
  const flushAscii = () => {
    if (asciiRun > 0) {
      total += Math.ceil(asciiRun / 4)
      asciiRun = 0
    }
  }
  const flushUnicode = () => {
    if (unicodeRun > 0) {
      total += Math.ceil(unicodeRun / 2)
      unicodeRun = 0
    }
  }
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (/\s/.test(ch)) {
      flushAscii()
      flushUnicode()
    } else if (isCjk(code)) {
      flushAscii()
      flushUnicode()
      total += 1
    } else if (/[A-Za-z0-9]/.test(ch)) {
      flushUnicode()
      asciiRun += 1
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      flushAscii()
      unicodeRun += 1
    } else {
      flushAscii()
      flushUnicode()
      total += 1
    }
  }
  flushAscii()
  flushUnicode()
  return total
}

/** 按 token 预算截断，尽量断在词边界。等价于 Memorose 的 truncate_to_token_budget()。 */
export function truncateToTokens(text, budget) {
  const s = String(text ?? '').trim()
  if (s === '') return ''
  if (budget <= 0) return ''
  if (countTokens(s) <= budget) return s
  // 二分找最长可容纳前缀，再回退到最近的空白/标点
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (countTokens(s.slice(0, mid)) <= budget) lo = mid
    else hi = mid - 1
  }
  let cut = lo
  const window = s.slice(Math.max(0, cut - 12), cut)
  const lastBreak = Math.max(
    window.lastIndexOf(' '),
    window.lastIndexOf('\n'),
    window.lastIndexOf('。'),
    window.lastIndexOf('，'),
  )
  if (lastBreak > 0) cut = Math.max(0, cut - 12) + lastBreak
  const head = s.slice(0, cut).trimEnd()
  return head === '' ? '' : `${head}…`
}

// ── 分词 ────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'it', 'on', 'for', 'with', 'as', 'at',
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '把', '被', '对',
])

/**
 * 中英混合分词。
 *
 * 没有分词器，中文用**二元组**（"部署服务" → 部署/署服/服务）——
 * 这是无词典检索的常规做法，召回够用且不需要维护词典。
 * 整段 2-4 字的也保留一份，避免二元组切碎专有名词。
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const out = []
  const push = (t) => {
    if (t === '' || STOPWORDS.has(t)) return
    // 中文虚词二元组（「的了」「和与」）整体也是停用词，没有任何检索价值
    if (t.length > 1 && [...t].every((ch) => STOPWORDS.has(ch))) return
    out.push(t)
  }

  // 拉丁词
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_+#.-]*/g)) {
    const w = m[0].replace(/[._-]+$/, '')
    if (w.length >= 2) push(w)
  }

  // 连续 CJK 段
  for (const m of s.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g)) {
    const run = m[0]
    if (run.length === 1) {
      push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i += 1) push(run.slice(i, i + 2))
    if (run.length >= 2 && run.length <= 4) push(run)
  }

  return out
}

// ── 索引与打分（BM25）──────────────────────────────────────────────────────

const K1 = 1.2
const B = 0.75

/**
 * 建倒排索引。
 * docs: [{ file, title, tags: string[], body, importance?, createdAt? }]
 */
export function buildIndex(docs) {
  const N = docs.length
  const postings = new Map() // term -> Map(docIdx -> tf)
  const lengths = new Array(N).fill(0)

  docs.forEach((doc, i) => {
    // 标题与标签权重更高：把它们的词各多塞一遍（等价于字段加权，但实现更简单）
    const weighted = [
      ...tokenize(doc.title ?? ''),
      ...tokenize(doc.title ?? ''),
      ...tokenize((doc.tags ?? []).join(' ')),
      ...tokenize((doc.tags ?? []).join(' ')),
      ...tokenize(doc.body ?? ''),
    ]
    lengths[i] = weighted.length
    for (const term of weighted) {
      let bucket = postings.get(term)
      if (bucket === undefined) {
        bucket = new Map()
        postings.set(term, bucket)
      }
      bucket.set(i, (bucket.get(i) ?? 0) + 1)
    }
  })

  const avgdl = N === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / N
  const idfCache = new Map()
  const idf = (term) => {
    const cached = idfCache.get(term)
    if (cached !== undefined) return cached
    const df = postings.get(term)?.size ?? 0
    const value = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    idfCache.set(term, value)
    return value
  }

  return { docs, postings, lengths, avgdl, N, idf }
}

/**
 * BM25 检索 + 少量确定性加成。
 *
 * 加成项都不是拍脑袋：标题命中说明「这条就是讲这个的」；标签命中说明属于同一主题；
 * importance/新鲜度来自 Memorose 的 MemoryUnit 字段，用来在分数接近时决定谁排前面。
 */
export function searchIndex(index, query, { limit = 20, now = Date.now() } = {}) {
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0) {
    return index.docs
      .map((doc, i) => ({ index: i, score: 1 }))
      .slice(0, Math.min(limit, 50))
  }

  const scores = new Map()
  for (const term of terms) {
    const bucket = index.postings.get(term)
    if (bucket === undefined) continue
    const termIdf = index.idf(term)
    for (const [i, tf] of bucket) {
      const dl = index.lengths[i]
      const norm = K1 * (1 - B + (B * dl) / (index.avgdl || 1))
      const gain = (termIdf * (tf * (K1 + 1))) / (tf + norm)
      scores.set(i, (scores.get(i) ?? 0) + gain)
    }
  }

  const lowerQuery = String(query ?? '').toLowerCase().trim()
  const hits = []
  for (const [i, base] of scores) {
    const doc = index.docs[i]
    let score = base
    const titleLower = String(doc.title ?? '').toLowerCase()
    if (lowerQuery !== '' && titleLower.includes(lowerQuery)) score += 2.0
    if (lowerQuery !== '' && String(doc.body ?? '').toLowerCase().includes(lowerQuery)) score += 0.3

    // importance 来自 frontmatter，缺省 0.5；只做温和加权，不该盖过相关性
    const importance = typeof doc.importance === 'number' ? doc.importance : 0.5
    score *= 0.85 + 0.3 * Math.max(0, Math.min(1, importance))

    // 半衰期 180 天的新鲜度加成，最多 +15%
    const created = Date.parse(String(doc.createdAt ?? ''))
    if (Number.isFinite(created)) {
      const ageDays = Math.max(0, (now - created) / 86400000)
      score *= 0.85 + 0.15 * Math.pow(0.5, ageDays / 180)
    }

    hits.push({ index: i, score })
  }

  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, Math.min(limit, 50))
}

/**
 * 沿 [[wikilink]] 扩展——直接沿用了 Memorose「图谱扩展」的思路，
 * 但用的是 Obsidian 自带的链接语法，不需要建图数据库。
 */
export function expandLinks(index, hits, { extra = 6 } = {}) {
  if (hits.length === 0 || extra <= 0) return hits

  const byTitle = new Map()
  const byBase = new Map()
  index.docs.forEach((doc, i) => {
    const title = String(doc.title ?? '').toLowerCase().trim()
    if (title !== '') byTitle.set(title, i)
    const base = String(doc.file ?? '').split('/').pop().replace(/\.md$/i, '').toLowerCase()
    if (base !== '') byBase.set(base, i)
  })

  const seen = new Set(hits.map((h) => h.index))
  const added = []
  // 分数最高那条通常最能代表主题，从它出发找邻居
  const seedScore = hits[0].score
  for (const hit of hits) {
    if (added.length >= extra) break
    const body = String(index.docs[hit.index].body ?? '')
    for (const m of body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      if (added.length >= extra) break
      const target = m[1].trim().toLowerCase()
      const targetIndex = byTitle.get(target) ?? byBase.get(target)
      if (targetIndex === undefined || seen.has(targetIndex)) continue
      seen.add(targetIndex)
      added.push({ index: targetIndex, score: seedScore * 0.45, via: 'link' })
    }
  }
  return [...hits, ...added]
}

// ── 上下文装配 ──────────────────────────────────────────────────────────────

function tierOf(budget) {
  if (budget <= TIER_TINY) return 'tiny'
  if (budget <= TIER_COMPACT) return 'compact'
  return 'detailed'
}

const TIER_PARAMS = {
  tiny: { previewChars: 88, keywordLimit: 0, showTags: false },
  compact: { previewChars: 160, keywordLimit: 3, showTags: true },
  detailed: { previewChars: 320, keywordLimit: 6, showTags: true },
}

function preview(text, chars) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= chars) return flat
  return `${flat.slice(0, chars)}…`
}

function importanceOf(doc) {
  const v = typeof doc.importance === 'number' ? doc.importance : 0.5
  return Math.max(0, Math.min(1, v))
}

/**
 * 把检索结果装配成「刚好装进 token 预算」的上下文块。
 *
 * 这是从 Memorose 的 /v1/memory/context 学来的最值钱的点：
 * 调用方给预算，由检索层负责裁剪，而不是把一堆原始片段丢给模型自己掂量。
 * 排序第一键是 importance（远高于第二键），所以预算不够时先保重要的，
 * 而不是先保「刚好相关」的。
 */
export function renderContext(index, hits, { tokenBudget = 800, format = 'text' } = {}) {
  const budget = Math.max(1, Math.round(Number(tokenBudget) || 800))
  const tier = tierOf(budget)
  const params = TIER_PARAMS[tier]

  const ordered = [...hits].sort((a, b) => {
    const ia = importanceOf(index.docs[a.index])
    const ib = importanceOf(index.docs[b.index])
    if (Math.abs(ia - ib) > 0.15) return ib - ia
    return b.score - a.score
  })

  const blocks = []
  const used = []
  let truncated = false

  for (const hit of ordered) {
    const doc = index.docs[hit.index]
    const lines = [`- ${preview(doc.title, 60)} (${doc.file}; score ${hit.score.toFixed(2)})`]
    if (params.showTags && Array.isArray(doc.tags) && doc.tags.length > 0) {
      lines.push(`  Tags: ${doc.tags.slice(0, params.keywordLimit).join(', ')}`)
    }
    const bodyPreview = preview(doc.body, params.previewChars)
    if (bodyPreview !== '') lines.push(`  ${bodyPreview}`)
    const block = lines.join('\n')

    const candidate = blocks.length === 0 ? block : `${blocks.join('\n')}\n${block}`
    if (countTokens(candidate) <= budget) {
      blocks.push(block)
      used.push({ file: doc.file, title: doc.title, score: hit.score, via: hit.via ?? 'match' })
      continue
    }

    // 装不下整块，就尝试截断这最后一块塞进去（预算大于一行才值得）
    const remaining = budget - countTokens(blocks.join('\n'))
    if (remaining > 20) {
      const trimmed = truncateToTokens(block, remaining - 2)
      if (trimmed !== '') {
        blocks.push(trimmed)
        used.push({ file: doc.file, title: doc.title, score: hit.score, via: hit.via ?? 'match' })
      }
    }
    truncated = true
    break
  }

  const context = blocks.join('\n')
  return {
    context,
    format,
    tier,
    tokenBudget: budget,
    usedTokenEstimate: countTokens(context),
    matchedCount: hits.length,
    includedCount: used.length,
    truncated,
    hits: used,
  }
}
