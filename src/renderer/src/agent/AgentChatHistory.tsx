import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { IconClockArrow, IconX } from '@pierre/icons'

import { usePopoverDismiss } from '../app/usePopoverDismiss'
import { formatChatTime } from './agentFormat'
import { useAgentChats, useRunningChats } from './agentChats'

export interface AgentChatHistoryProps {
  currentChatId: string
  onOpenChat(id: string): void
  onDeleteChat(id: string): void
}

/** The header's chat list: every earlier conversation, newest first, one click back. */
export function AgentChatHistory({
  currentChatId,
  onOpenChat,
  onDeleteChat
}: AgentChatHistoryProps): React.JSX.Element | null {
  const chats = useAgentChats()
  const running = useRunningChats()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(0)
  const hostRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])
  usePopoverDismiss(open, hostRef, close)

  useLayoutEffect(() => {
    if (!open) return
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>('.agent-chat-open')
    const current = [...(rows ?? [])].find((row) => row.dataset.current != null)
    ;(current ?? rows?.[0])?.focus()
  }, [open])

  if (chats.length === 0) return null

  const moveFocus = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.agent-chat-open') ?? [])]
    const index = rows.findIndex((row) => row === document.activeElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    rows[(index + step + rows.length) % rows.length]?.focus()
  }

  return (
    <div className="agent-chat-history" ref={hostRef}>
      <button ref={triggerRef} type="button" aria-label="Chats" title="Chats"
        aria-haspopup="dialog" aria-expanded={open} data-running={running.size > 0 ? '' : undefined}
        onClick={() => {
          setNow(Date.now())
          setOpen((value) => !value)
        }}>
        <IconClockArrow />
      </button>
      {open ? (
        <dialog open className="agent-chat-popover" aria-label="Chats">
          <ul ref={listRef} onKeyDown={moveFocus}>
            {chats.map((chat) => (
              <li key={chat.id}>
                <button type="button" className="agent-chat-open"
                  data-current={chat.id === currentChatId ? '' : undefined}
                  aria-current={chat.id === currentChatId ? 'true' : undefined}
                  onClick={() => {
                    onOpenChat(chat.id)
                    close()
                  }}>
                  <span>{chat.title}</span>
                  <small>
                    {running.has(chat.id) ? <span className="agent-chat-running">Answering · </span> : null}
                    {chat.turns.length === 1 ? '1 question' : `${chat.turns.length} questions`}
                    {' · '}
                    {formatChatTime(chat.updatedAt, now)}
                  </small>
                </button>
                <button type="button" className="agent-chat-delete" aria-label={`Delete chat ${chat.title}`}
                  title="Delete chat" onClick={() => onDeleteChat(chat.id)}>
                  <IconX />
                </button>
              </li>
            ))}
          </ul>
        </dialog>
      ) : null}
    </div>
  )
}
