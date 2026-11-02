/**
 * 记忆衰减与剪枝。
 *
 * 依据 Memorose 的 crates/memorose-core/src/engine/forgetting.rs：
 *   - decay 只改 importance，**不重建索引**（它那边是 LanceDB/Tantivy，我们这边是内存索引，天然没这问题）
 *   - prune 只删 importance 低于阈值的，且**先扫一遍收集被高层记忆引用的 id，跳过它们**（保留溯源）
 *   - 整个机制**默认关闭**，并且分成 preview / execute 两步
 *
 * 我们这边的额外约束（比它更保守）：
 *   1. 只处理 level 1（巩固层）。level ≥ 2 是人写的洞察，不该被自动剪掉。
 *   2. `supersededBy` 非空的旧记忆不删——它存在的意义就是被追溯。
 *   3. 剪枝只把它移进 `Memories/.archive/`，**永远不 unlink**。
 *      记忆是用户的东西，插件没有资格物理删除。
 */

/** 默认衰减因子：每跑一次 importance *= 0.9。 */
export const DEFAULT_DECAY_FACTOR = 0.9
/** 默认剪枝阈值：importance 低于这个值才算「可以归档」。 */
export const DEFAULT_PRUNE_THRESHOLD = 0.15

/**
 * 判断一条记忆能不能被归档。
 * 返回 null 表示可以，返回字符串表示保留原因（会原样报给用户，让人知道为什么没动它）。
 */
export function retentionReason(doc) {
  if (doc.level >= 2) return 'level>=2 (insight tier, written by hand)'
  if (typeof doc.supersededBy === 'string' && doc.supersededBy !== '') return 'superseded by a newer memory (kept for provenance)'
  const body = String(doc.body ?? '')
  // 有 wikilink 被别的笔记指着，说明它还在图谱里活着——但这个判断在 prune 里统一做，
  // 这里只挡「自己链接别人」的，避免把枢纽笔记删掉后一堆链接变空。
  if (/\[\[[^\]]+\]\]/.test(body) && body.length > 1200) return 'long note with wikilinks (looks like a hub)'
  return null
}

/** 规划一次衰减：算完新值先不写盘，交给调用方决定要不要落。 */
export function planDecay(docs, factor = DEFAULT_DECAY_FACTOR) {
  const f = Number.isFinite(factor) && factor > 0 && factor < 1 ? factor : DEFAULT_DECAY_FACTOR
  return docs.map((doc) => {
    const before = typeof doc.importance === 'number' ? doc.importance : 0.5
    const after = Math.round(before * f * 1000) / 1000
    return { file: doc.file, title: doc.title, before, after, changed: after !== before }
  })
}

/**
 * 规划一次剪枝。
 *
 * @param docs 全部文档
 * @param threshold importance 低于它才考虑归档
 * @returns {{ prune: Array, keep: Array }} prune 里每项带保留原因以外的字段
 */
export function planPrune(docs, threshold = DEFAULT_PRUNE_THRESHOLD) {
  const t = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_PRUNE_THRESHOLD

  // 第一遍：谁被 wikilink 指着。被指着的不能删——删了别人的链接就断了。
  const referenced = new Set()
  for (const doc of docs) {
    const text = `${doc.title ?? ''}\n${doc.body ?? ''}`
    for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
      referenced.add(m[1].trim().toLowerCase())
    }
  }

  const prune = []
  const keep = []
  for (const doc of docs) {
    const importance = typeof doc.importance === 'number' ? doc.importance : 0.5
    if (importance >= t) continue // 够重要，根本不进入候选

    const selfKeys = [
      String(doc.title ?? '').toLowerCase().trim(),
      String(doc.file ?? '').split('/').pop().replace(/\.md$/i, '').toLowerCase(),
    ].filter((k) => k !== '')
    if (selfKeys.some((k) => referenced.has(k))) {
      keep.push({ file: doc.file, title: doc.title, importance, reason: 'linked from another note via [[wikilink]]' })
      continue
    }

    const reason = retentionReason(doc)
    if (reason !== null) {
      keep.push({ file: doc.file, title: doc.title, importance, reason })
      continue
    }

    prune.push({ file: doc.file, title: doc.title, importance })
  }

  return { prune, keep }
}
