import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

import { parseMarkdown } from './markdown'
import { MarkdownContent } from './MarkdownContent'

afterEach(cleanup)

describe('MarkdownContent', () => {
  test('draws a code span inside bold as code, not backticks', () => {
    const { container } = render(<MarkdownContent blocks={parseMarkdown('**Yes, `[1]` is safe.** Here is why.')} className="answer" />)
    const strong = container.querySelector('strong')!
    expect(strong.textContent).toBe('Yes, [1] is safe.')
    expect(strong.querySelector('code')?.textContent).toBe('[1]')
  })

  test('gives a code block its language on its own row above the code', () => {
    const { container } = render(<MarkdownContent blocks={parseMarkdown('```python\nreturn a, b\n```')} className="answer" />)
    const pre = container.querySelector('pre')!
    expect(pre.firstElementChild?.className).toBe('agent-code-language')
    expect(pre.querySelector('code')?.textContent).toBe('return a, b')
  })

  test('draws a table in its own scroller, cells aligned and inline markdown kept', () => {
    const { container } = render(<MarkdownContent
      blocks={parseMarkdown('| Input | Count |\n|---|--:|\n| `a|b` | **3** |')} className="answer" />)
    const table = container.querySelector('.agent-table-scroll > table')!
    expect([...table.querySelectorAll('th')].map((cell) => cell.textContent)).toEqual(['Input', 'Count'])
    const cells = [...table.querySelectorAll('tbody td')]
    expect(cells[0]?.querySelector('code')?.textContent).toBe('a|b')
    expect(cells[1]?.querySelector('strong')?.textContent).toBe('3')
    expect((cells[1] as HTMLElement).style.textAlign).toBe('right')
  })
})
