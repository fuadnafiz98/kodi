import { describe, expect, test } from 'bun:test'

import {
  isAllowedGitHubMediaUrl,
  isVideoMarkdownHref,
  isVideoMarkdownLink,
  markdownLinkText,
  videoMimeTypeFromHref
} from './markdownVideo.js'

describe('markdown video links', () => {
  test('detects common video extensions on the href or the link text', () => {
    expect(isVideoMarkdownHref('https://github.com/user-attachments/assets/clip.webm')).toBe(true)
    expect(isVideoMarkdownHref('https://example.com/notes.md')).toBe(false)
    expect(isVideoMarkdownLink(
      'https://github.com/user-attachments/assets/aaaa-bbbb',
      'Screencast From 2026-09-04 11-34-01.webm'
    )).toBe(true)
    expect(isVideoMarkdownLink('https://github.com/owner/repo', 'Open review')).toBe(false)
    expect(videoMimeTypeFromHref('demo.mov?raw=1')).toBe('video/quicktime')
    expect(markdownLinkText(['Screencast', '.mp4'])).toBe('Screencast.mp4')
  })

  test('allows only GitHub media hosts', () => {
    expect(isAllowedGitHubMediaUrl('https://github.com/user-attachments/assets/aaaa')).toBe(true)
    expect(isAllowedGitHubMediaUrl('https://private-user-images.githubusercontent.com/1/clip.mp4')).toBe(true)
    expect(isAllowedGitHubMediaUrl('https://example.com/clip.mp4')).toBe(false)
    expect(isAllowedGitHubMediaUrl('http://github.com/user-attachments/assets/aaaa')).toBe(false)
  })
})
