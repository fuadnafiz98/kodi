import { expect, test } from 'bun:test'

import { ANNOTATION_LAYOUT_CSS } from './viewerCss'

test('insets annotation chrome and clears Pierre’s paired split selection paint', () => {
  expect(ANNOTATION_LAYOUT_CSS).toContain('[data-annotation-content]')
  expect(ANNOTATION_LAYOUT_CSS).toContain('[data-line-annotation][data-selected-line]')
  expect(ANNOTATION_LAYOUT_CSS).toContain('[data-gutter-buffer="annotation"][data-selected-line]')
})
