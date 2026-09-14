import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconCopy } from '@pierre/icons'

export function AnswerActions({ answer }: { answer: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current)
  }, [])
  const copyAnswer = async (): Promise<void> => {
    await navigator.clipboard.writeText(answer)
    setCopied(true)
    if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => {
      copiedTimerRef.current = null
      setCopied(false)
    }, 1_600)
  }
  return <div className="agent-answer-actions"><button type="button" onClick={() => {
    void copyAnswer()
  }}>{copied ? <IconCheck aria-hidden="true" /> : <IconCopy aria-hidden="true" />}{copied ? 'Copied' : 'Copy answer'}</button></div>
}
