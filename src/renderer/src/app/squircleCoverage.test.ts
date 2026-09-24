import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import { VIEWER_BASE_CSS } from '../diff/viewerCss'

const RENDERER_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** `::-webkit-*` included: those are generated boxes too, so `*` misses them. */
const PSEUDO = /::?(before|after|placeholder|-webkit-[a-z-]+|backdrop|marker|selection)/

function cssFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) cssFiles(path, found)
    else if (entry.name.endsWith('.css')) found.push(path)
  }
  return found
}

interface Rule { selector: string; body: string; file: string }

function rules(): Rule[] {
  return cssFiles(RENDERER_ROOT).flatMap((file) => {
    const css = readFileSync(file, 'utf8')
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
      selector: match[1]!.trim().replace(/\s+/g, ' '),
      body: match[2]!,
      file: file.slice(RENDERER_ROOT.length)
    }))
  })
}

describe('squircle coverage', () => {
  test('one universal rule shapes every element that carries a radius', () => {
    const styles = readFileSync(join(RENDERER_ROOT, 'app/styles.css'), 'utf8')
    expect(styles).toContain('* { corner-shape: squircle; }')
  })

  test('nothing opts back out to a circular corner', () => {
    // A 50% radius under a squircle is a rounded square, and that is the intent
    // everywhere now — avatars, chips, swatches, status dots and graph nodes.
    const offenders = rules()
      .filter((rule) => /corner-shape:\s*round/.test(rule.body))
      .map((rule) => `${rule.file} ${rule.selector}`)
    expect(offenders).toEqual([])
  })

  test('rounded generated boxes declare the shape themselves', () => {
    // The universal selector deliberately skips pseudo-elements — resolving it
    // against two extra boxes per element was measurable — so each rounded one
    // has to be named, here or in a grouped rule.
    const all = rules()
    const squircled = all
      .filter((rule) => /corner-shape:\s*squircle/.test(rule.body))
      .map((rule) => rule.selector)
      .join(' | ')
    const uncovered = all
      .filter((rule) => PSEUDO.test(rule.selector) && /border-radius/.test(rule.body))
      .filter((rule) => !rule.selector.split(',').some((part) => squircled.includes(part.trim())))
      .map((rule) => `${rule.file} ${rule.selector}`)
    expect(uncovered).toEqual([])
  })

  test('the diff shadow root shapes the corners the library rounds', () => {
    // The document rule stops at the shadow boundary. These are every selector
    // @pierre/diffs gives a radius that the app does not re-declare — the viewer's
    // own, plus the editor stylesheet it appends into the same root.
    expect(VIEWER_BASE_CSS).toContain('[data-diff-span]')
    expect(VIEWER_BASE_CSS).toContain('[data-separator-content]')
    expect(VIEWER_BASE_CSS).toContain('[data-code]::-webkit-scrollbar-thumb')
    expect(VIEWER_BASE_CSS).toContain('[data-editor-widget]')
    expect(VIEWER_BASE_CSS).toContain('[data-input-box] input')
    expect(VIEWER_BASE_CSS).toContain('[data-rtl]')
    expect(VIEWER_BASE_CSS).not.toMatch(/corner-shape:\s*round/)
  })

  test('the tree shadow root shapes the rows, the focus ring and the thumb', () => {
    const workspace = readFileSync(join(RENDERER_ROOT, 'app/RepositoryWorkspace.tsx'), 'utf8')
    const treeStyles = workspace.slice(workspace.indexOf('const TREE_STYLES'))
    expect(treeStyles).toContain('[data-type="item"]::before')
    expect(treeStyles).toContain('::-webkit-scrollbar-thumb')
    expect(treeStyles).toContain('[data-type="context-menu-anchor"] > slot')
  })
})
