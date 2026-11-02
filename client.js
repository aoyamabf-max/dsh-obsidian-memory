/**
 * Client half of dsh-obsidian-memory.
 *
 * 在左侧栏插一个图标，点开后把记忆列表渲染到中间主面板。
 * 三种视图：列表（搜索 + 标签筛选）、阅读、编辑/新建。
 * 数据全部走 Host 侧的 /api/dsh-obsidian-memory/* 路由，浏览器端不直接碰磁盘。
 */
window.__ModuleLoader__.load({
  id: 'dsh-obsidian-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'obsidian-memory'
    const PANEL_ORDER = 30
    const STYLE_ID = 'dsh-obsidian-memory-style'
    const ROUTE_BASE = '/api/dsh-obsidian-memory'

    const CSS = `
.dom_root{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;gap:0;overflow:hidden}
.dom_head{display:flex;align-items:center;gap:8px;padding:14px 20px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l2);flex:0 0 auto}
.dom_head_title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dom_count{font-size:12px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}
.dom_spacer{flex:1 1 auto}
.dom_btn{background:transparent;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:3px 10px;border-radius:6px;cursor:pointer;flex:0 0 auto}
.dom_btn:hover{color:var(--dsw-alias-label-primary)}
.dom_btn_primary{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.dom_search{padding:10px 20px 0;flex:0 0 auto}
.dom_input{width:100%;box-sizing:border-box;background:transparent;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 10px;font-size:13px;color:var(--dsw-alias-label-primary);outline:none;font-family:inherit}
.dom_input:focus{border-color:var(--dsw-alias-label-secondary)}
.dom_tags{display:flex;flex-wrap:wrap;gap:6px;padding:10px 20px 0;flex:0 0 auto}
.dom_tag{background:transparent;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;padding:2px 8px;border-radius:10px;cursor:pointer;font-family:inherit}
.dom_tag:hover{color:var(--dsw-alias-label-primary)}
.dom_tag_on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.dom_list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 20px 24px}
.dom_item{display:flex;flex-direction:column;gap:2px;padding:10px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2);cursor:pointer}
.dom_item:hover .dom_item_title{color:var(--dsw-alias-label-primary)}
.dom_item_title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.dom_item_meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dom_snippet{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dom_badges{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.dom_badge{font-size:10px;line-height:14px;padding:1px 6px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dom_badge_l2{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.dom_badge_gone{text-decoration:line-through;opacity:.7}
.dom_bar{display:inline-block;width:44px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;vertical-align:middle;margin-right:5px}
.dom_bar_fill{display:block;height:100%;background:var(--dsw-alias-label-secondary);border-radius:2px}
.dom_sort{display:flex;align-items:center;gap:6px;padding:10px 20px 0;flex:0 0 auto}
.dom_sort_btn{background:transparent;border:0;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 0;cursor:pointer;font-family:inherit}
.dom_sort_btn:hover{color:var(--dsw-alias-label-primary)}
.dom_sort_on{color:var(--dsw-alias-label-primary);font-weight:600}
.dom_empty{padding:32px 20px;font-size:13px;color:var(--dsw-alias-label-secondary);text-align:center}
.dom_body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 24px 32px;white-space:pre-wrap;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);font-family:inherit}
.dom_form{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 20px 24px;display:flex;flex-direction:column;gap:10px}
.dom_label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dom_textarea{width:100%;box-sizing:border-box;background:transparent;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:8px 10px;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-primary);outline:none;resize:vertical;min-height:240px;font-family:inherit}
.dom_textarea:focus{border-color:var(--dsw-alias-label-secondary)}
.dom_err{font-size:12px;color:#e5534b;padding:0 20px 8px}
`

    function ensureStyle() {
      if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      ;(document.head ?? document.documentElement)?.appendChild?.(style)
    }

    async function getJson(path) {
      const response = await fetch(ROUTE_BASE + path, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    async function postJson(path, payload) {
      const response = await fetch(ROUTE_BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = { ok: false, error: `HTTP ${response.status}` }
      }
      return data ?? { ok: false, error: `HTTP ${response.status}` }
    }

    function IconMemory(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true },
        h('rect', { x: 4, y: 3, width: 16, height: 18, rx: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M8 9h8M8 13h8M8 17h5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    /** importance 画成一根小横条 + 百分比。缺失时按 0.5 处理（与 Host 侧默认值一致）。 */
    function badgeImportance(value, label) {
      const raw = typeof value === 'number' && Number.isFinite(value) ? value : 0.5
      const pct = Math.round(Math.max(0, Math.min(1, raw)) * 100)
      return h(
        'span',
        { className: 'dom_badge', title: label.replace('{pct}', String(pct)) },
        h('span', { className: 'dom_bar' }, h('span', { className: 'dom_bar_fill', style: { width: `${pct}%` } })),
        `${pct}%`,
      )
    }

    /**
     * level 1 = 巩固（一条具体记忆），2 = 洞察（归纳出来的结论）。
     * 只给 2 打标——1 是默认值，每行都标「L1」等于没标。
     */
    function badgeLevel(value, label) {
      const level = typeof value === 'number' && Number.isFinite(value) ? value : 1
      if (level < 2) return null
      return h('span', { className: 'dom_badge dom_badge_l2', title: label }, label)
    }

    function MemoryPanel(props) {
      ensureStyle()
      const t = (key, fallback) => {
        const bind = props?.t
        if (typeof bind !== 'function') return fallback
        try {
          const value = bind(key)
          return typeof value === 'string' && value !== '' ? value : fallback
        } catch {
          return fallback
        }
      }

      const [state, setState] = React.useState({ phase: 'loading', notes: [], vault: null, error: null })
      const [query, setQuery] = React.useState('')
      const [tagFilter, setTagFilter] = React.useState(null)
      const [open, setOpen] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [formError, setFormError] = React.useState(null)
      const [sortBy, setSortBy] = React.useState('mtime')

      const load = React.useCallback(() => {
        let cancelled = false
        setState((prev) => ({ ...prev, phase: prev.notes.length > 0 ? 'ready' : 'loading' }))
        getJson('/notes')
          .then((data) => {
            if (cancelled) return
            if (data?.ok === true) {
              setState({ phase: 'ready', notes: Array.isArray(data.notes) ? data.notes : [], vault: data.vault ?? null, error: null })
            } else {
              setState({ phase: 'error', notes: [], vault: null, error: data?.error ?? 'unknown' })
            }
          })
          .catch((err) => {
            if (cancelled) return
            setState({ phase: 'error', notes: [], vault: null, error: String(err?.message ?? err) })
          })
        return () => {
          cancelled = true
        }
      }, [])

      React.useEffect(() => load(), [load])

      const openNote = React.useCallback((file) => {
        setFormError(null)
        setDraft(null)
        setOpen({ phase: 'loading', file, meta: null, body: '' })
        getJson(`/note?file=${encodeURIComponent(file)}`)
          .then((data) => {
            if (data?.ok === true) setOpen({ phase: 'ready', file, meta: data.meta ?? {}, body: String(data.body ?? '') })
            else setOpen({ phase: 'error', file, meta: null, body: String(data?.error ?? t('panel.readFailed', 'Failed to read')) })
          })
          .catch((err) => setOpen({ phase: 'error', file, meta: null, body: String(err?.message ?? err) }))
      }, [])

      // 所有标签及其出现次数，按次数降序；用于筛选条。
      const allTags = React.useMemo(() => {
        const counter = new Map()
        for (const note of state.notes) {
          const tags = Array.isArray(note.tags) ? note.tags : []
          for (const tag of tags) {
            const key = String(tag)
            if (key === '') continue
            counter.set(key, (counter.get(key) ?? 0) + 1)
          }
        }
        return [...counter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      }, [state.notes])

      const needle = query.trim().toLowerCase()
      const visible = state.notes.filter((note) => {
        if (tagFilter !== null) {
          const tags = Array.isArray(note.tags) ? note.tags.map((x) => String(x)) : []
          if (!tags.includes(tagFilter)) return false
        }
        if (needle === '') return true
        const inTitle = String(note.title ?? '').toLowerCase().includes(needle)
        const inTags = Array.isArray(note.tags) && note.tags.some((tag) => String(tag).toLowerCase().includes(needle))
        const inSnippet = String(note.snippet ?? '').toLowerCase().includes(needle)
        return inTitle || inTags || inSnippet
      })

      // 排序：默认按修改时间（Host 侧已经排好），可切换成按 importance。
      // 按 importance 时用 level 做第二键——洞察比同分原始记录更值得看。
      const sorted = React.useMemo(() => {
        if (sortBy !== 'importance') return visible
        return [...visible].sort((a, b) => {
          const ai = typeof a.importance === 'number' ? a.importance : 0.5
          const bi = typeof b.importance === 'number' ? b.importance : 0.5
          if (Math.abs(ai - bi) > 0.001) return bi - ai
          const al = typeof a.level === 'number' ? a.level : 1
          const bl = typeof b.level === 'number' ? b.level : 1
          return bl - al
        })
      }, [visible, sortBy])

      // ── 新建 / 编辑 ──────────────────────────────────────────────────────
      const startCreate = () => {
        setFormError(null)
        setOpen(null)
        setDraft({ mode: 'create', file: null, title: '', tags: '', body: '' })
      }

      const startEdit = () => {
        if (open === null || open.phase !== 'ready') return
        const tags = Array.isArray(open.meta?.tags) ? open.meta.tags.join(', ') : ''
        setFormError(null)
        setDraft({ mode: 'edit', file: open.file, title: String(open.meta?.title ?? ''), tags, body: String(open.body ?? '') })
      }

      const saveDraft = async () => {
        if (draft === null || busy) return
        const bodyText = String(draft.body ?? '')
        if (bodyText.trim() === '') {
          setFormError(t('panel.bodyEmpty', 'Body must not be empty'))
          return
        }
        const tags = String(draft.tags ?? '')
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter((x) => x !== '')
        setBusy(true)
        setFormError(null)
        try {
          const result =
            draft.mode === 'create'
              ? await postJson('/save', { title: String(draft.title ?? '').trim(), body: bodyText, tags, source: 'panel' })
              : await postJson('/update', { file: draft.file, title: String(draft.title ?? '').trim(), body: bodyText, tags })
          if (result?.ok !== true) {
            setFormError(String(result?.error ?? t('panel.saveFailed', 'Failed to save')))
            return
          }
          setDraft(null)
          load()
          if (draft.mode === 'edit') openNote(draft.file)
        } catch (err) {
          setFormError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      // ── 视图：编辑 / 新建 ────────────────────────────────────────────────
      if (draft !== null) {
        const isCreate = draft.mode === 'create'
        return h(
          'div',
          { className: 'dom_root' },
          h(
            'div',
            { className: 'dom_head' },
            h('span', { className: 'dom_head_title' }, isCreate ? t('panel.createTitle', 'New memory') : t('panel.editTitle', 'Edit: {file}').replace('{file}', String(draft.file ?? ''))),
            h('span', { className: 'dom_spacer' }),
            h('button', { className: 'dom_btn', type: 'button', onClick: () => setDraft(null), disabled: busy }, t('panel.cancel', 'Cancel')),
            h('button', { className: 'dom_btn dom_btn_primary', type: 'button', onClick: saveDraft, disabled: busy }, busy ? t('panel.saving', 'Saving…') : t('panel.save', 'Save')),
          ),
          formError === null ? null : h('div', { className: 'dom_err' }, formError),
          h(
            'div',
            { className: 'dom_form' },
            h('span', { className: 'dom_label' }, t('panel.fieldTitle', 'Title')),
            h('input', {
              className: 'dom_input',
              type: 'text',
              placeholder: t('panel.fieldTitleHint', 'Keep it short — it becomes the filename'),
              value: draft.title,
              onChange: (event) => setDraft({ ...draft, title: event.target.value }),
            }),
            h('span', { className: 'dom_label' }, t('panel.fieldTags', 'Tags (comma separated)')),
            h('input', {
              className: 'dom_input',
              type: 'text',
              placeholder: t('panel.fieldTagsHint', 'e.g. plan, DSH'),
              value: draft.tags,
              onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
            }),
            h('span', { className: 'dom_label' }, t('panel.fieldBody', 'Body (Markdown)')),
            h('textarea', {
              className: 'dom_textarea',
              value: draft.body,
              onChange: (event) => setDraft({ ...draft, body: event.target.value }),
            }),
          ),
        )
      }

      // ── 视图：阅读 ──────────────────────────────────────────────────────
      if (open !== null) {
        const canEdit = open.phase === 'ready'
        return h(
          'div',
          { className: 'dom_root' },
          h(
            'div',
            { className: 'dom_head' },
            h('span', { className: 'dom_head_title' }, String(open.file ?? '')),
            h('span', { className: 'dom_spacer' }),
            canEdit ? h('button', { className: 'dom_btn dom_btn_primary', type: 'button', onClick: startEdit }, t('panel.edit', 'Edit')) : null,
            h('button', { className: 'dom_btn', type: 'button', onClick: () => setOpen(null) }, t('panel.back', '← Back')),
          ),
          h('div', { className: 'dom_body' }, open.phase === 'loading' ? t('panel.loading', 'Loading…') : open.body),
        )
      }

      // ── 视图：列表 ──────────────────────────────────────────────────────
      const head = h(
        'div',
        { className: 'dom_head' },
        h('span', { className: 'dom_head_title' }, t('panel.title', 'Memory')),
        h('span', { className: 'dom_count' }, t('panel.count', '{n} notes').replace('{n}', String(state.notes.length))),
        h('span', { className: 'dom_spacer' }),
        h('button', { className: 'dom_btn dom_btn_primary', type: 'button', onClick: startCreate }, '+ ' + t('panel.new', 'New')),
        h('button', { className: 'dom_btn', type: 'button', onClick: () => load() }, t('panel.refresh', 'Refresh')),
      )

      const tagBar =
        allTags.length === 0
          ? null
          : h(
              'div',
              { className: 'dom_tags' },
              tagFilter === null
                ? null
                : h('button', { className: 'dom_tag dom_tag_on', type: 'button', onClick: () => setTagFilter(null) }, t('panel.all', 'All')),
              allTags.slice(0, 24).map(([tag, count]) =>
                h(
                  'button',
                  {
                    className: tagFilter === tag ? 'dom_tag dom_tag_on' : 'dom_tag',
                    type: 'button',
                    key: tag,
                    onClick: () => setTagFilter(tagFilter === tag ? null : tag),
                  },
                  `${tag} ${count}`,
                ),
              ),
            )

      let content
      if (state.phase === 'loading') {
        content = h('div', { className: 'dom_empty' }, t('panel.loading', 'Loading…'))
      } else if (state.phase === 'error') {
        content = h('div', { className: 'dom_empty' }, `${t('panel.error', 'Failed to load')}：${String(state.error ?? '')}`)
      } else if (visible.length === 0) {
        content = h(
          'div',
          { className: 'dom_empty' },
          state.notes.length === 0
            ? t('panel.empty', 'No memory notes yet.')
            : needle === '' && tagFilter === null
              ? t('panel.empty', 'No memory notes yet.')
              : t('panel.noResult', 'No matching memories.'),
        )
      } else {
        content = h(
          'div',
          { className: 'dom_list' },
          sorted.map((note) =>
            h(
              'div',
              { className: 'dom_item', key: note.file, onClick: () => openNote(note.file), role: 'button', tabIndex: 0 },
              h(
                'div',
                { className: 'dom_badges' },
                h('span', { className: 'dom_item_title' }, String(note.title ?? note.file)),
                h('span', { className: 'dom_spacer' }),
                badgeImportance(note.importance, t('panel.importance', 'Importance {pct}%')),
                badgeLevel(note.level, t('panel.levelInsight', 'L2 insight')),
                note.supersededBy ? h('span', { className: 'dom_badge dom_badge_gone' }, t('panel.superseded', 'Superseded')) : null,
              ),
              h(
                'span',
                { className: 'dom_item_meta' },
                [note.createdAt, Array.isArray(note.tags) && note.tags.length > 0 ? note.tags.join(' · ') : ''].filter(Boolean).join('　'),
              ),
            ),
          ),
        )
      }

      const sortBar = h(
        'div',
        { className: 'dom_sort' },
        h('span', { className: 'dom_label' }, t('panel.sort', 'Sort')),
        h(
          'button',
          {
            className: sortBy === 'mtime' ? 'dom_sort_btn dom_sort_on' : 'dom_sort_btn',
            type: 'button',
            onClick: () => setSortBy('mtime'),
          },
          t('panel.sortMtime', 'Recently modified'),
        ),
        h('span', { className: 'dom_label' }, '·'),
        h(
          'button',
          {
            className: sortBy === 'importance' ? 'dom_sort_btn dom_sort_on' : 'dom_sort_btn',
            type: 'button',
            onClick: () => setSortBy('importance'),
          },
          t('panel.sortImportance', 'Importance'),
        ),
      )

      return h(
        'div',
        { className: 'dom_root' },
        head,
        h(
          'div',
          { className: 'dom_search' },
          h('input', {
            className: 'dom_input',
            type: 'search',
            placeholder: t('panel.search', 'Search memories…'),
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
        ),
        tagBar,
        sortBar,
        content,
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const disposers = []
        let mountedPanel = null
        let mountedRow = null
        let mainOk = false
        let rowOk = false

        const unmountPanel = () => {
          if (typeof mountedPanel === 'function') {
            try {
              mountedPanel()
            } catch {
              /* 卸载失败不影响后续 */
            }
          }
          mountedPanel = null
        }
        const unmountRow = () => {
          if (typeof mountedRow === 'function') {
            try {
              mountedRow()
            } catch {
              /* 同上 */
            }
          }
          mountedRow = null
        }

        const mountPanel = () => {
          if (!mainOk || mountedPanel !== null) return
          const result = ctx.slots.register(
            { name: 'main', key: PANEL_ID, inject: () => ({ t: ctx.locale?.bind ? ctx.locale.bind('dsh-obsidian-memory') : undefined }) },
            (ownerProps) => h(MemoryPanel, ownerProps),
          )
          mountedPanel = typeof result === 'function' ? result : null
        }

        const mountRow = () => {
          if (!rowOk || mountedRow !== null) return
          const result = ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => { try { const f = ctx.locale && ctx.locale.bind ? ctx.locale.bind('dsh-obsidian-memory') : null; const v = f ? f('panel.title') : null; return typeof v === 'string' && v !== '' ? v : 'Memory' } catch { return 'Memory' } } },
            (ownerProps) => h(IconMemory, ownerProps),
          )
          mountedRow = typeof result === 'function' ? result : null
        }

        // 先探测槽位是否存在，再挂载：宿主没有该槽位时不该抛错。
        ctx.slots.inject('main', () => {
          mainOk = true
          mountPanel()
          return () => {
            mainOk = false
            unmountPanel()
          }
        })
        ctx.slots.inject('sidebar.panellist', () => {
          rowOk = true
          mountRow()
          return () => {
            rowOk = false
            unmountRow()
          }
        })

        return () => {
          unmountRow()
          unmountPanel()
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* 忽略单个清理失败 */
            }
          }
        }
      },
    }
  },
})
