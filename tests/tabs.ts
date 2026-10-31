// The panel's flowdeck group shows one list at a time under its tabs. These select a tab the way a person does (a press
// on its Button); the choice is held for the session, so every later mount draws that tab.

export type Tab = 'active' | 'finished' | 'archive' | 'trash'

/** A tab's own label, `Active (2)`: left out where a test collects the rows' coloured words. */
export const TAB_TEXT = /^(● )?(Active|Finished|Archive|Trash)( \(\d+\))?$/

export async function showTab($: any, tab: Tab): Promise<void> {
  const p = await $.ui.mount({ plugin: 'flowdeck', surface: 'terminal', component: 'Pane', requestId: 'flowdeck-agents', props: { bodyColumns: 80 } } as any)
  await p.press({ key: `tab-${tab}` })
  await p.unmount()
}

/** What `read` finds in each tab's pane, in the order given; the Active tab is shown again after. */
export async function acrossTabs($: any, mount: () => Promise<any>, read: (p: any) => Promise<any[]>, tabs: Tab[] = ['active', 'finished']): Promise<any[]> {
  const out: any[] = []
  for (const tab of tabs) {
    await showTab($, tab)
    const p = await mount()
    out.push(...(await read(p)))
    await p.unmount()
  }
  await showTab($, 'active')
  return out
}
