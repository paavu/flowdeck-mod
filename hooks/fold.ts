// Every foldable row in the panel puts its chevron first, right before its name: `▸` folded, `▾` open. Row actions
// (the archive icon, ✕, Restore) go after the name, never next to the chevron.
export const FOLD_OPEN = '▾'
export const FOLD_SHUT = '▸'
export const foldGlyph = (isOpen: boolean): string => (isOpen ? FOLD_OPEN : FOLD_SHUT)
