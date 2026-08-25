# Accessibility verification

Agent Observatory targets WCAG 2.2 AA for the local dashboard. Status and
provider identity are always exposed as text as well as color, interactive
graph nodes are native buttons, and the Debug dialog traps focus, closes with
Escape, and restores focus to its trigger.

## Measured contrast

The palette below was measured with the WCAG relative-luminance formula. Values
are foreground text against `--surface` (`#121517`); all exceed the 4.5:1 AA
threshold for normal text.

| Token | Color | Ratio |
| --- | --- | ---: |
| `--text` | `#eef1f2` | 16.15:1 |
| `--text-soft` | `#a7b0b6` | 8.32:1 |
| `--text-muted` | `#808a91` | 5.21:1 |
| `--working` | `#44c27a` | 8.07:1 |
| `--waiting` | `#e0a94f` | 8.69:1 |
| `--idle` | `#859099` | 5.63:1 |
| `--completed` | `#65a7e8` | 7.20:1 |
| `--failed` | `#e66a6a` | 5.79:1 |
| `--unknown` | `#9a8db8` | 6.00:1 |

`--text-muted` is also 4.50:1 against the lighter `--surface-3` (`#1e2327`).
Borders and decorative graph connectors are not used as the only way to convey
information.

## Automated coverage

- Graph nodes and workflow cards use native keyboard-operable controls.
- Provider filters, view tabs, relation controls, and selection use
  `aria-pressed`.
- Agent role help appears on both pointer hover and keyboard focus and is also
  included in the node's accessible name.
- Debug initial focus, focus containment, Escape close, and trigger restoration
  are covered by component tests.
- The responsive stylesheet removes horizontal page overflow at narrow widths
  and honors `prefers-reduced-motion`.

Run the checks with:

```bash
bun run typecheck
bun run test
bun run test:e2e
```

## Manual release checklist

- [ ] Tab through provider filters, graph/workflow switcher, graph nodes,
      relation controls, inspector, and Debug without a pointer.
- [ ] Open Debug from each available trigger; verify initial focus, forward and
      reverse focus wrapping, Escape close, backdrop close, and focus return.
- [ ] At 200% browser zoom, verify that all content remains reachable without
      horizontal page scrolling.
- [ ] At a 320 CSS-pixel viewport, verify one-column reflow, command-field
      selection, and that dialogs do not crop content.
- [ ] Enable reduced motion and verify that working-state animation stops.
- [ ] With a screen reader, confirm provider, status, selected state, relation
      direction, and relation evidence are announced without relying on color.

