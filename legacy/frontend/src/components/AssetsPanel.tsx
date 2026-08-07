import { useMemo, useState } from 'react'
import { api, formatDuration, type MediaAsset } from '../api/client'

interface Props {
  assets: MediaAsset[]
  onPlace: (m: MediaAsset) => void
  onClose: () => void
  onRefresh: () => void
  hasSelectedTrack: boolean
}

// The asset library, as a real tool: search + category filter, and per-asset
// editable category + free-form tags. Categories are just strings the user
// (or, later, the AI) fills in — nothing is hard-coded.
export function AssetsPanel({ assets, onPlace, onClose, onRefresh, hasSelectedTrack }: Props) {
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const a of assets) if (a.category) set.add(a.category)
    return Array.from(set).sort()
  }, [assets])

  const q = query.trim().toLowerCase()
  const filtered = assets.filter((a) => {
    if (categoryFilter !== 'all' && (a.category ?? '') !== categoryFilter) return false
    if (!q) return true
    const hay = [a.original_filename, a.category ?? '', ...(a.tags ?? [])].join(' ').toLowerCase()
    return hay.includes(q)
  })

  return (
    <div className="assets-pop assets-tool">
      <div className="assets-head">
        <span>Assets</span>
        <input
          className="assets-search"
          placeholder="Search name, category, tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn tiny" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="assets-filter">
        <button
          className={`chip ${categoryFilter === 'all' ? 'active' : ''}`}
          onClick={() => setCategoryFilter('all')}
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c}
            className={`chip ${categoryFilter === c ? 'active' : ''}`}
            onClick={() => setCategoryFilter(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="assets-list">
        {filtered.length === 0 && <div className="assets-empty">No matching assets.</div>}
        {filtered.map((m) => (
          <AssetRow
            key={m.id}
            m={m}
            categories={categories}
            onPlace={() => onPlace(m)}
            onRefresh={onRefresh}
            hint={hasSelectedTrack}
          />
        ))}
      </div>
    </div>
  )
}

function AssetRow({
  m,
  categories,
  onPlace,
  onRefresh,
  hint,
}: {
  m: MediaAsset
  categories: string[]
  onPlace: () => void
  onRefresh: () => void
  hint: boolean
}) {
  const [category, setCategory] = useState(m.category ?? '')
  const [tags, setTags] = useState((m.tags ?? []).join(', '))
  const [saving, setSaving] = useState(false)

  const save = async (patch: { category?: string | null; tags?: string[] }) => {
    setSaving(true)
    try {
      await api.updateMedia(m.id, patch)
      onRefresh()
    } finally {
      setSaving(false)
    }
  }

  const commitCategory = () => {
    if ((category.trim() || null) !== (m.category ?? null)) save({ category: category.trim() || null })
  }
  const commitTags = () => {
    const next = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (next.join('|') !== (m.tags ?? []).join('|')) save({ tags: next })
  }

  // Stub "auto-classify": no AI yet — seed a sensible category from the media
  // type and a tag from the file extension. The user can override everything.
  const autoClassify = () => {
    const ext = m.original_filename.split('.').pop()?.toLowerCase()
    const cat = m.type === 'audio' ? 'Audio' : 'Video'
    setCategory(cat)
    const nextTags = Array.from(new Set([...(m.tags ?? []), ext].filter(Boolean))) as string[]
    setTags(nextTags.join(', '))
    save({ category: cat, tags: nextTags })
  }

  return (
    <div className="asset-row">
      <div className="asset-main">
        <span className="asset-kind">{m.type === 'audio' ? '🔊' : '🎞'}</span>
        <span className="asset-name" title={m.original_filename}>
          {m.original_filename}
        </span>
        <span className="asset-dur">{formatDuration(m.duration_seconds)}</span>
        <button className="btn tiny primary" onClick={onPlace} title="Add at playhead">
          + Add{hint ? ' →' : ''}
        </button>
      </div>
      <div className="asset-classify">
        <input
          className="asset-cat"
          list="asset-categories"
          placeholder="Category"
          value={category}
          disabled={saving}
          onChange={(e) => setCategory(e.target.value)}
          onBlur={commitCategory}
          onKeyDown={(e) => e.key === 'Enter' && commitCategory()}
        />
        <input
          className="asset-tags"
          placeholder="tags, comma separated"
          value={tags}
          disabled={saving}
          onChange={(e) => setTags(e.target.value)}
          onBlur={commitTags}
          onKeyDown={(e) => e.key === 'Enter' && commitTags()}
        />
        <button className="btn tiny" onClick={autoClassify} title="Auto-classify (stub — no AI yet)">
          ✨
        </button>
      </div>
      <datalist id="asset-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  )
}
