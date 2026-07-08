# Adamancia design language → shelfedit

Port of the **AdamanciaVault** visual language
(`blockerGroup/macosBlocker/Sources/MacBlockerWebUI/WebAssets/popup.css`) onto
shelfedit.

**Model: dark shell, colored cards & buttons with neon glow.**
Shell and panels stay **dark** (shelfedit surfaces). Cards and buttons draw from
one shared **5-color × 3-variant** palette (cards use only the `light`/`dark`
tiers; buttons use all three), and each element's shadow is a **colored glow in
its own family color** — like neon light on the dark UI.

Reference implementation: [`adamancia-style-example.html`](./adamancia-style-example.html).
When in doubt, match that file.

---

## 1. The palette

Five colors — **red, gold, pink, cyan, blue** — each in three variants:
**light, mid, dark**. All three are **real AdamanciaVault tokens**, not
invented — `light` = the family's `-100` tint, `mid` = its `-200` step (`-300`
for navy), `dark` = its `-700`/strong tone, all straight from `popup.css`.

`mid` is a **pale pastel one step past light** — not a saturated/vivid color.
Blue's mid (`#c7d2fe`) is AdamanciaVault's `navy-300`, confirmed against a
swatch pulled directly from the real app's Schedule card.

| Color | light | mid | dark |
|-------|-------|-----|------|
| red   | `#fee2e2` | `#fecaca` | `#b91c1c` |
| gold  | `#fef3c7` | `#fde68a` | `#ca8a04` |
| pink  | `#fce7f3` | `#fbcfe8` | `#be185d` |
| cyan  | `#cffafe` | `#a5f3fc` | `#0e7490` |
| blue  | `#e9eefc` *(app)* | `#c7d2fe` *(app, navy-300)* | `#1e3a8a` |

**Text rule of thumb: light and mid are both pale surfaces → dark text (the
family's `-text` token, shared by both tiers). Only dark → white text.** No
pure-white (`#ffffff`) or ultra-light (`-50`) fill — the lightest surface is a
color's `light` variant.

### Rim: the card's left stripe

Every card already carries a colored left stripe (the "rim" — `inset 4px 0 0
…`). Its color depends on tier: **light** tier's stripe is the family's **mid**
tone (not dark — this is the fix), **mid** tier keeps the dark stripe, and
**dark** tier flips the stripe to the family's light tone for contrast against
the saturated fill.

### Neon shadows

Each family also has a separate **glow tone** — a vivid, saturated accent (not
part of the light/mid/dark fill scale) used only to color the shadow, so an
element appears to emit its color. Blue's glow (`#2563eb`) is the vivid
checkbox blue from the app screenshot — that's an *accent*, distinct from the
pale `navy-300` mid *fill*. The shadow is built inline from `--glow` (see
§3/§4), never a fixed near-black token.

### Tokens (add to `app/web/style.css` `:root`)

Keep shelfedit's dark tokens (`--bg`, `--panel`, `--panel-2`, `--line`,
`--text`, `--muted`, `--accent`). Add:

```css
:root {
  /* ---- Radius ---- */
  --r-md: 10px;  --r-lg: 12px;  --r-xl: 16px;

  --ring-hairline: inset 0 0 0 1px rgba(255, 255, 255, 0.08);

  --focus-ring: inset 0 0 0 1px var(--accent), 0 0 0 3px rgba(76, 141, 255, 0.30);

  /* ---- Palette: fill + ink. All three tiers are real AdamanciaVault tokens
     (light=-100, mid=-200/-300, dark=-700). mid/light share one ink. ---- */
  --red-light:#fee2e2;  --red-mid:#fecaca;  --red-dark:#b91c1c;
  --red-light-ink:#991b1b; --red-mid-ink:#991b1b; --red-dark-ink:#ffffff;

  --gold-light:#fef3c7; --gold-mid:#fde68a; --gold-dark:#ca8a04;
  --gold-light-ink:#a16207; --gold-mid-ink:#a16207; --gold-dark-ink:#ffffff;

  --pink-light:#fce7f3; --pink-mid:#fbcfe8; --pink-dark:#be185d;
  --pink-light-ink:#9d174d; --pink-mid-ink:#9d174d; --pink-dark-ink:#ffffff;

  --cyan-light:#cffafe; --cyan-mid:#a5f3fc; --cyan-dark:#0e7490;
  --cyan-light-ink:#155e75; --cyan-mid-ink:#155e75; --cyan-dark-ink:#ffffff;

  --blue-light:#e9eefc; --blue-mid:#c7d2fe; --blue-dark:#1e3a8a;  /* app-derived */
  --blue-light-ink:#1e3a8a; --blue-mid-ink:#1e3a8a; --blue-dark-ink:#ffffff;

  /* ---- Neon glow tone per family: a vivid ACCENT, not a fill tier.
     Colors the shadow only. Blue's glow is the vivid checkbox blue. ---- */
  --red-glow:#ef4444; --gold-glow:#f0b429; --pink-glow:#ec4899;
  --cyan-glow:#06b6d4; --blue-glow:#2563eb;
}
```

---

## 2. Panels (dark)

```css
.a-panel {
  background: var(--panel); border: none; border-radius: var(--r-xl);
  padding: 12px; color: var(--text);
  box-shadow: var(--ring-hairline);   /* hairline, never a border */
  min-height: 0; overflow: auto;
}
```

---

## 3. Cards — `class="a-card <color> <tier>"`

Tinted fill + colored left stripe + **neon glow** in the family color. Pick
`color` by meaning (blue = normal, gold = experimental, red = locked/danger,
cyan = info, pink = special). Default = `blue light`.

**Cards have only two tiers: `light` (default) and `dark` (emphasis).** There is
no mid-tier card — `mid` is reserved for the light card's stripe accent (below)
and for buttons (§4).

```css
.a-card {
  --fill: var(--blue-light); --ink: var(--blue-light-ink);
  --stripe: var(--blue-dark); --glow: var(--blue-glow);
  border: none; border-radius: var(--r-lg);
  padding: 10px 12px; text-align: left; cursor: pointer;
  background: var(--fill); color: var(--ink);
  box-shadow:
    inset 4px 0 0 var(--stripe),
    0 3px 12px color-mix(in srgb, var(--glow) 55%, transparent),
    0 0 24px   color-mix(in srgb, var(--glow) 30%, transparent);
  transition: background 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}
.a-card:hover {
  transform: translateY(-1px);
  box-shadow:
    inset 4px 0 0 var(--stripe),
    0 4px 16px color-mix(in srgb, var(--glow) 68%, transparent),
    0 0 30px   color-mix(in srgb, var(--glow) 42%, transparent);
}
.a-card .title { font-weight: 700; }
.a-card .meta  { font-size: 11px; font-weight: 600; opacity: 0.75; }

/* color sets the DEFAULT stripe (dark tone) + glow */
.a-card.red {--stripe:var(--red-dark); --glow:var(--red-glow);}
.a-card.gold{--stripe:var(--gold-dark);--glow:var(--gold-glow);}
.a-card.pink{--stripe:var(--pink-dark);--glow:var(--pink-glow);}
.a-card.cyan{--stripe:var(--cyan-dark);--glow:var(--cyan-glow);}
.a-card.blue{--stripe:var(--blue-dark);--glow:var(--blue-glow);}

/* fill + ink per color × tier.
   LIGHT's stripe is the family's MID tone (not dark) — the rim rule.
   DARK's stripe is a darker-than-fill shade (mix with black), for a subtle
   deep edge instead of a pale contrast bar. */
.a-card.red.light{--fill:var(--red-light);--ink:var(--red-light-ink);--stripe:var(--red-mid);}
.a-card.red.dark{--fill:var(--red-dark);--ink:var(--red-dark-ink);--stripe:color-mix(in srgb, var(--red-dark) 80%, black);}
.a-card.gold.light{--fill:var(--gold-light);--ink:var(--gold-light-ink);--stripe:var(--gold-mid);}
.a-card.gold.dark{--fill:var(--gold-dark);--ink:var(--gold-dark-ink);--stripe:color-mix(in srgb, var(--gold-dark) 80%, black);}
.a-card.pink.light{--fill:var(--pink-light);--ink:var(--pink-light-ink);--stripe:var(--pink-mid);}
.a-card.pink.dark{--fill:var(--pink-dark);--ink:var(--pink-dark-ink);--stripe:color-mix(in srgb, var(--pink-dark) 80%, black);}
.a-card.cyan.light{--fill:var(--cyan-light);--ink:var(--cyan-light-ink);--stripe:var(--cyan-mid);}
.a-card.cyan.dark{--fill:var(--cyan-dark);--ink:var(--cyan-dark-ink);--stripe:color-mix(in srgb, var(--cyan-dark) 80%, black);}
.a-card.blue.light{--fill:var(--blue-light);--ink:var(--blue-light-ink);--stripe:var(--blue-mid);}
.a-card.blue.dark{--fill:var(--blue-dark);--ink:var(--blue-dark-ink);--stripe:color-mix(in srgb, var(--blue-dark) 80%, black);}
```

---

## 4. Buttons — `class="a-btn <color> <tier>"`

Same palette + neon glow; `700` weight, lifts on hover, presses back on
`:active`.

```css
.a-btn {
  --fill: var(--blue-light); --ink: var(--blue-light-ink); --glow: var(--blue-glow);
  border: none; border-radius: var(--r-md); padding: 7px 14px;
  font-weight: 700; cursor: pointer;
  background: var(--fill); color: var(--ink);
  box-shadow:
    0 2px 8px color-mix(in srgb, var(--glow) 55%, transparent),
    0 0 16px  color-mix(in srgb, var(--glow) 30%, transparent);
  transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease;
}
.a-btn:hover {
  transform: translateY(-1px);
  box-shadow:
    0 4px 12px color-mix(in srgb, var(--glow) 70%, transparent),
    0 0 22px   color-mix(in srgb, var(--glow) 45%, transparent);
  filter: brightness(1.03);
}
.a-btn:active   { transform: translateY(0); box-shadow: 0 2px 8px color-mix(in srgb, var(--glow) 55%, transparent); }
.a-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }

/* color sets glow */
.a-btn.red {--glow:var(--red-glow);}  .a-btn.gold{--glow:var(--gold-glow);}
.a-btn.pink{--glow:var(--pink-glow);} .a-btn.cyan{--glow:var(--cyan-glow);}
.a-btn.blue{--glow:var(--blue-glow);}

/* fill + ink for every color × tier */
.a-btn.red.light{--fill:var(--red-light);--ink:var(--red-light-ink);}
.a-btn.red.mid {--fill:var(--red-mid); --ink:var(--red-mid-ink);}
.a-btn.red.dark{--fill:var(--red-dark);--ink:var(--red-dark-ink);}
.a-btn.gold.light{--fill:var(--gold-light);--ink:var(--gold-light-ink);}
.a-btn.gold.mid {--fill:var(--gold-mid); --ink:var(--gold-mid-ink);}
.a-btn.gold.dark{--fill:var(--gold-dark);--ink:var(--gold-dark-ink);}
.a-btn.pink.light{--fill:var(--pink-light);--ink:var(--pink-light-ink);}
.a-btn.pink.mid {--fill:var(--pink-mid); --ink:var(--pink-mid-ink);}
.a-btn.pink.dark{--fill:var(--pink-dark);--ink:var(--pink-dark-ink);}
.a-btn.cyan.light{--fill:var(--cyan-light);--ink:var(--cyan-light-ink);}
.a-btn.cyan.mid {--fill:var(--cyan-mid); --ink:var(--cyan-mid-ink);}
.a-btn.cyan.dark{--fill:var(--cyan-dark);--ink:var(--cyan-dark-ink);}
.a-btn.blue.light{--fill:var(--blue-light);--ink:var(--blue-light-ink);}
.a-btn.blue.mid {--fill:var(--blue-mid); --ink:var(--blue-mid-ink);}
.a-btn.blue.dark{--fill:var(--blue-dark);--ink:var(--blue-dark-ink);}
```

---

## 5. Inputs, selects, textareas (dark)

Inputs stay dark so cards + buttons remain the colored, glowing elements.

```css
.a-input, .a-select, .a-textarea {
  width: 100%; padding: 10px 12px; border: none; border-radius: var(--r-md);
  box-sizing: border-box; font-family: inherit;   /* NOT `font: inherit` */
  background: var(--panel-2); color: var(--text);
  box-shadow: var(--ring-hairline);
}
.a-input:focus, .a-select:focus, .a-textarea:focus { outline: none; box-shadow: var(--focus-ring); }
```

**Selects custom-drawn:** `appearance: none`, `padding-right: 34px`, chevron as
inline-SVG background (`#94a3b8` stroke — exact data-URI in the example).

---

## 6. Typography

Keep shelfedit's system stack. **Text is bold like the app** — labels, card
titles, and buttons are `700`; card meta is `600`.

---

## 7. Motion

- Transitions `120ms ease` on `transform`, `box-shadow`, `background`,
  `filter`. Never `all`.
- Cards & buttons lift `translateY(-1px)` on hover and the glow intensifies;
  buttons press back to `translateY(0)` on `:active`.

---

## 8. Do / Don't

**Do**
- Keep shell + panels dark; cards and buttons take a palette `color` + `tier`.
- Let each element glow in its own family color; blue glows `#2563eb`.
- Keep `mid` a pale pastel (the family's `-200`/`-300` token) — never vivid.
- Light and mid bg → dark text; dark bg → white text.
- On cards, give the **light** tier's stripe the family's **mid** color, and the
  **dark** tier's stripe a black-mixed, darker-than-fill shade.
- Remember cards only come in `light`/`dark`; buttons keep all three tiers.

**Don't**
- Don't use pure white / ultra-light fills — the lightest is a color's `light`.
- Don't use a near-black shadow — shadows are the family's neon glow.
- Don't make `mid` a saturated/vivid color — that's the `glow` accent's job.
- Don't add a `mid`-tier card — it doesn't exist in this system.
- Don't make the shell or panels light, or use native `outline` for focus.
