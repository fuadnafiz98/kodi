import { describe, expect, test } from 'bun:test'

import {
  createImagePreviewSide,
  hasImagePreview,
  imageMimeType,
  imagePreviewCacheKey,
  isImagePath
} from './imagePreview.js'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

describe('imagePreview', () => {
  test('maps common raster extensions and ignores everything else', () => {
    expect(imageMimeType('extensions/kodi/assets/icon.png')).toBe('image/png')
    expect(imageMimeType('photo.JPEG')).toBe('image/jpeg')
    expect(isImagePath('src/lib/kodi.ts')).toBe(false)
    expect(isImagePath('notes.svg')).toBe(true)
  })

  test('encodes a binary png and skips empty or text svg', () => {
    const preview = createImagePreviewSide('icon.png', TINY_PNG, true)
    expect(preview?.mimeType).toBe('image/png')
    expect(preview?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(createImagePreviewSide('icon.png', Buffer.alloc(0), true)).toBeNull()
    expect(createImagePreviewSide('mark.svg', Buffer.from('<svg></svg>'), false)).toBeNull()
  })

  test('treats a preview as present only when a side has bytes', () => {
    const side = createImagePreviewSide('icon.png', TINY_PNG, true)!
    expect(hasImagePreview({ old: null, new: side })).toBe(true)
    expect(hasImagePreview({ old: null, new: null })).toBe(false)
    expect(hasImagePreview(null)).toBe(false)
    expect(imagePreviewCacheKey({ old: null, new: side })).toContain(String(side.byteLength))
  })
})
