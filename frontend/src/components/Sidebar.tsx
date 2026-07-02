type View = 'home' | 'cloud' | 'settings'

interface Props {
  active: View
  onSelect: (view: View) => void
}

export function Sidebar({ active, onSelect }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo">S</span>
        ShelfEdit
      </div>

      <button
        className={`nav-item ${active === 'home' ? 'active' : ''}`}
        onClick={() => onSelect('home')}
      >
        Home
      </button>
      <button
        className={`nav-item ${active === 'cloud' ? 'active' : ''}`}
        onClick={() => onSelect('cloud')}
      >
        Cloud Storage
        <span className="badge">soon</span>
      </button>
      <button
        className={`nav-item ${active === 'settings' ? 'active' : ''}`}
        onClick={() => onSelect('settings')}
      >
        Settings
      </button>

      <div className="sidebar-spacer" />

      <div className="account">
        <span className="avatar">?</span>
        <div>
          <div>Guest</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            Login later
          </div>
        </div>
      </div>
    </aside>
  )
}

export type { View }
