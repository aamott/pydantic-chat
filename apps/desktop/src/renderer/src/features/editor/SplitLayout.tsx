/**
 * Horizontal chat | tools split built on react-resizable-panels v4
 * (`Group`/`Panel`/`Separator`). Split sizes persist via the built-in
 * `useDefaultLayout` hook (localStorage under `react-resizable-panels:*`).
 *
 * `onlySaveAfterUserInteractions` is set so mount-time/layout-recompute
 * writes can't clobber the user's last manual split.
 */
import type { ReactNode } from 'react'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'

interface SplitLayoutProps {
  /** Left (chat) pane content. */
  chat: ReactNode
  /** Right (tools) pane content. */
  right: ReactNode
}

export function SplitLayout({ chat, right }: SplitLayoutProps): React.JSX.Element {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'main-split',
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  })

  return (
    <Group
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="min-h-0 flex-1"
    >
      <Panel id="chat" minSize="30%" className="h-full min-w-0">
        {chat}
      </Panel>
      <Separator className="w-1 bg-neutral-200 transition-colors hover:bg-blue-300 data-[separator=active]:bg-blue-500" />
      <Panel
        id="right"
        defaultSize="35%"
        minSize="280px"
        maxSize="80%"
        className="h-full min-w-0 border-l border-neutral-200"
      >
        {right}
      </Panel>
    </Group>
  )
}
