# shelfedit — Swift editor design system

The living reference for how the **native (Swift/AppKit) editor** looks. Every
value here is implemented in [`Sources/DesignSystem.swift`](Sources/DesignSystem.swift)
(`enum ShelfStyle` + the shared views), which is the **source of truth** — when
code and doc disagree, the code wins and this file should be corrected to match.

Lineage: this is the AppKit port of the **Adamancia** visual language originally
written for the (now `legacy/`) web editor. The conceptual rationale for the
palette lives in [`../docs/adamancia-style.md`](../docs/adamancia-style.md); that
doc is CSS for the retired web UI — use *this* file for anything you build in the
Swift app.

---

## 1. The model

**Dark shell, light elements that glow in their own color.**

- The **shell** — window background, big floating panels, toolbars, the timeline
  surface, inputs/dropdowns — stays **dark**.
- The **small** things you act on — **tool cards, buttons, timeline clips, and
  chips** — are **light, tinted** surfaces that sit *on top of* the dark shell.
  Light is for small elements only.
- **Large content areas stay dark.** A big light/white content box clashes with
  the shell and is **prohibited** — panels, section backgrounds, and lists take a
  dark `panel` fill (`GlassPanelView`), never a light one. Put the color in the
  small elements *inside* the dark panel, not in the panel itself.
- Each light element casts a **colored neon glow** (a shadow tinted in its own
  family color) so it reads as emitting light. Dark shell pieces instead use a
  plain near-black structural shadow for depth. Never mix the two (§6).

---

## 2. Palette

Five families — **red, gold, pink, cyan, blue** — each with `light` / `mid` /
`dark` tiers, plus a vivid **glow** accent used only to tint shadows. From
`ShelfStyle.palette(_:_:)` and the `*Glow` tokens.

| Family | light (fill / ink) | mid (fill / ink) | dark (fill / ink) | glow |
|--------|--------------------|------------------|-------------------|------|
| red    | `#fee2e2` / `#991b1b` | `#fecaca` / `#991b1b` | `#b91c1c` / white | `#ef4444` |
| gold   | `#fef3c7` / `#a16207` | `#fde68a` / `#a16207` | `#ca8a04` / white | `#f0b429` |
| pink   | `#fce7f3` / `#9d174d` | `#fbcfe8` / `#9d174d` | `#be185d` / white | `#ec4899` |
| cyan   | `#cffafe` / `#155e75` | `#a5f3fc` / `#155e75` | `#0e7490` / white | `#06b6d4` |
| blue   | `#e9eefc` / `#1e3a8a` | `#c7d2fe` / `#1e3a8a` | `#1e3a8a` / white | `#2563eb` |

**Ink rule:** `light` and `mid` are pale → **dark ink** (shared per family);
`dark` fill → **white** ink. The lightest fill in the system is a family's
`light` tier — never pure white.

### Semantic roles

The app never picks a raw color — it picks a **role**, and the role maps to a
family. This mapping is the app-specific layer on top of the palette; keep new
UI consistent with it.

| Role | Family | `ShelfStyle` tokens | Used for |
|------|--------|---------------------|----------|
| video   | blue  | `videoLight` / `videoHeavy`     | video clips, Home, primary |
| audio   | cyan  | `audioLight` / `audioHeavy`     | audio clips |
| text    | pink  | `textLight` / `textHeavy`       | text/caption clips |
| export  | gold  | `exportLight` / `exportHeavy`   | Exports, render actions |
| asset   | blue  | `assetLight` / `assetHeavy`     | Projects, media/asset panels |
| danger  | red   | `dangerLight` / `dangerHeavy`   | Danger Zone, invalid clips |
| generic | slate | `genericLight` / `genericHeavy` | Settings, neutral inputs/chips |

`*Light` is the tinted fill; `*Heavy` is the strong tone for text/icons/stripes
on that light fill. Timeline clips fill with the `*Light` tier of their type
([`TimelineView.fillColor(forType:)`](Sources/TimelineView.swift)); an invalid
clip falls back to `dangerLight`.

---

## 3. Dark-shell tokens

Structural surfaces, dark. From the top of `ShelfStyle`.

| Token | Hex | Surface |
|-------|-----|---------|
| `canvas`          | `#15171b` | window background (top of gradient) |
| `secondaryCanvas` | `#1c2027` | window background (bottom of gradient) |
| `panel` / `panelStrong` | `#20232a` | big floating panels |
| `panel2`          | `#252932` | input fields, dropdowns |
| `toolbar`         | `#1c1f26` | tool strips, ruler |
| `timelineSurface` | `#16181d` | timeline track area |
| `childPanel`      | `#f6f8fe` | neutral **light** card base |

The window background also carries a faint white **dot grid** (5% white, 22 pt
spacing) over the gradient — see `AppBackgroundView`.

---

## 4. Text / ink

| Token | Hex | On |
|-------|-----|-----|
| `onDark`      | `#eceff5` | dark panels — primary |
| `onDarkMuted` | `#9299aa` | dark panels — secondary |
| `heading` / `text` / `buttonText` | `#1f2937` | light cards — primary |
| `body`  | `#475569` | light cards — secondary |
| `muted` | `#94a3b8` | light cards — tertiary |

On palette fills, prefer the family **ink** from §2 over these generics.

---

## 5. Geometry

| Token | Value | |
|-------|-------|---|
| `radiusControl` | 10 | buttons, inputs, dropdowns |
| `radiusCard`    | 14 | cards / clips |
| `radiusPanel`   | 16 | big floating panels |
| `radiusPill`    | 999 | chips / pills |
| `space2` / `space3` / `space4` | 8 / 12 / 16 | spacing scale |
| `controlHeight` | 32 | standard controls |
| `mainControlHeight` | 36 | primary controls |
| `chipHeight` | 24 | chips |

---

## 6. Shadows — two systems, never mixed

**Colored neon glow** — for *light* elements floating on the dark shell.
`applyNeonGlow(to:color:opacity:radius:)` — tinted shadow, **zero offset**, so
the element appears to emit its family color. Default `opacity 0.5`, `radius 14`.

**Structural black** — for *dark* shell pieces, giving depth without color:

| Function | Opacity | Radius | Offset | For |
|----------|---------|--------|--------|-----|
| `applyFloatingShadow` | 0.45 | 20 | (0, −8) | big dark panels |
| `applyCardShadow`     | 0.32 | 12 | (0, −5) | medium surfaces |
| `applyTinyShadow`     | 0.30 |  7 | (0, −2) | small surfaces |

Rule of thumb: **light thing → colored glow; dark thing → black structural
shadow.** A near-black shadow on a colored card, or a colored glow on a dark
panel, is off-language.

---

## 7. Typography

Platform **system font** (San Francisco on macOS) via `ShelfStyle.font(size:weight:)`
and `ShelfStyle.bold(size:)` — never Arial or a bundled face. Text runs **bold**:
buttons and titles at `700`/`.bold`; dropdowns at `.semibold`; meta at `.semibold`.

---

## 8. Components

All in [`Sources/DesignSystem.swift`](Sources/DesignSystem.swift).

| View | What it is |
|------|-----------|
| `AppBackgroundView`   | Window background: vertical `canvas → secondaryCanvas` gradient + faint dot grid. |
| `GlassPanelView`      | Dark floating panel — `panel` fill, `radiusPanel`, `applyFloatingShadow`. Set `fillColor` for a tinted panel. |
| `AccentPanelView`     | **Small light card** — `childPanel` fill, `radiusCard`, a 4 pt colored **left stripe**, neon glow in `accentColor`. For small cards only (e.g. tool cards); **never** a large content-panel background. |
| `AdamanciaButton`     | Light palette button (`color` + `tier`). Neon glow; hover lifts + brightens, press settles, disabled dims to 0.5 with no glow. |
| `AdamanciaPopupButton`| **Dark** dropdown — `panel2` fill, `radiusControl`, 1 pt white-8% hairline border. Inputs stay dark so cards/buttons remain the glowing elements. |
| `ResizerView`         | 8 pt draggable seam between panels — a hairline (white-12%) that turns `blueGlow` and glows while hovered or dragged. |

---

## 9. Interaction / motion

Matches the web spec's `120ms ease` feel. Cards and buttons **lift**
(`translateY(-1px)` equivalent) and their glow **intensifies** on hover; buttons
**settle** on press. In `AdamanciaButton`:

- **rest** → glow `opacity 0.55`, `radius 10`
- **hover** → fill brightened ~6%, glow `0.7` / `14`
- **press** → glow `0.55` / `8`
- **disabled** → alpha `0.5`, glow off

Transition specific properties (transform, shadow, background, brightness) —
never "all".

---

## 10. Extending the system

- **New role** → add a `<role>Light` / `<role>Heavy` pair to `ShelfStyle`, map it
  to one of the five families, and add a row to the §2 role table. Don't
  introduce a sixth hue outside red/gold/pink/cyan/blue.
- **New colored control** → build on `AdamanciaButton` / `AccentPanelView` and
  pass a family + tier; don't hand-roll fills or shadows.
- **New dark surface** → `GlassPanelView` (or a `panel`/`panel2` fill) + a
  structural black shadow from §6 — not a glow.

---

## 11. Do / Don't

**Do**
- Keep shell, panels, toolbars, and inputs **dark**; let **small** cards,
  buttons, and clips be the **light, glowing** elements.
- Pick a **role**, not a raw hex; glow in the family color.
- Light/mid fill → dark ink; dark fill → white ink.
- Use the system font, bold weights.

**Don't**
- Don't build a **large light/white content box** — big surfaces are dark
  (`GlassPanelView` / `panel` fills); light is only for small cards, buttons,
  clips, and chips.
- Don't use pure white / ultra-light fills — the lightest is a family's `light`.
- Don't put a near-black shadow on a colored element, or a colored glow on a dark
  panel.
- Don't invent a new hue or a `mid`-tier card (cards are `light`/`dark`; the
  full three tiers exist for buttons).
- Don't add native `outline` focus rings — use the hairline/glow patterns.
