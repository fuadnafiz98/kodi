import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import MagicString from 'magic-string'
import { transformWithEsbuild, type Plugin } from 'vite'

// The renderer displays code and review text from arbitrary repositories, so it
// declares a policy instead of relying on the default that Electron warns about.
// Production reaches the main process over IPC only and needs no network at all;
// the dev server needs its HMR socket.
//
// Verified enforced on the packaged file:// build, not just declared: an injected
// inline script does not execute, a securitypolicyviolation fires for
// script-src-elem, and Electron's "Insecure Content-Security-Policy" warning
// stops being emitted. Highlighting workers, bundled fonts and the agent stream
// all keep working under it.
function contentSecurityPolicyPlugin(): Plugin {
  return {
    name: 'kodi:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, context) {
        const development = context.server != null
        const policy = [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "font-src 'self'",
          "img-src 'self' data:",
          "media-src 'self' blob:",
          "worker-src 'self' blob:",
          development ? "connect-src 'self' ws: wss: http://localhost:*" : "connect-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "object-src 'none'"
        ].join('; ')
        return [{
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend'
        }]
      }
    }
  }
}

// @pierre/diffs only reaches for shiki's WASM oniguruma engine when
// preferredHighlighter is 'shiki-wasm' (highlighter/shared_highlighter.js:15,
// worker/worker.js:1764); it defaults to 'shiki-js' and nothing here overrides
// it, so the base64-inlined wasm chunk — 622,336 bytes in the last build — is
// shipped and never fetched. The stub throws instead of resolving empty so a
// future engine switch fails loudly at the import rather than deep inside shiki.
// The allowlist IS the preference table: every selectable theme ships, nothing
// else does, and the light/dark split comes from EDITOR_THEMES rather than
// name-sniffing (catppuccin-latte carries no 'light' in its name).
import { EDITOR_THEMES, getEditorThemeType } from './src/shared/editorThemes.js'

const SHIKI_THEME_ALLOWLIST = new Set(Object.keys(EDITOR_THEMES))
const THEME_TYPE: Record<string, 'dark' | 'light'> = Object.fromEntries(
  Object.keys(EDITOR_THEMES).map((name) => [name, getEditorThemeType(name as keyof typeof EDITOR_THEMES)])
)
const lightTheme = (name: string): boolean => THEME_TYPE[name] === 'light'

function trimShikiThemesPlugin(): Plugin {
  return {
    name: 'kodi:trim-shiki-themes',
    enforce: 'pre',
    transform(_code, id) {
      const normalized = id.split('?')[0]?.replaceAll('\\', '/') ?? id
      // @pierre/diffs createHighlighter() reads shiki's bundledThemes map
      // (shiki/dist/themes.mjs). Pierre collections are a second registry.
      if (normalized.endsWith('/shiki/dist/themes.mjs') || normalized.endsWith('/shiki/dist/themes.js')) {
        const names = [...SHIKI_THEME_ALLOWLIST].filter((name) => !name.startsWith('pierre-'))
        const info = names.map((name) => {
          const type = lightTheme(name) ? 'light' : 'dark'
          return `{id:${JSON.stringify(name)},displayName:${JSON.stringify(name)},type:${JSON.stringify(type)},import:()=>import(${JSON.stringify(`@shikijs/themes/${name}`)})}`
        })
        return [
          `const bundledThemesInfo=[${info.join(',')}];`,
          'const bundledThemes=Object.fromEntries(bundledThemesInfo.map((i)=>[i.id,i.import]));',
          'export{bundledThemes,bundledThemesInfo};'
        ].join('\n')
      }
      if (normalized.endsWith('/collections/shiki.js')) {
        const names = [...SHIKI_THEME_ALLOWLIST].filter((name) => !name.startsWith('pierre-'))
        const light = names.filter(lightTheme)
        const lightNames = new Set(light)
        const dark = names.filter((name) => !lightNames.has(name))
        const imports = names.map((name) =>
          `${JSON.stringify(name)}: () => import(${JSON.stringify(`@shikijs/themes/${name}`)})`
        )
        return [
          'import { createThemeCollection } from "../modules/createThemeCollection.js";',
          'import { createTheme } from "../modules/createTheme.js";',
          'const SHIKI_COLLECTION = "shiki";',
          `const LIGHT_SHIKI_THEMES = ${JSON.stringify(light)};`,
          `const DARK_SHIKI_THEMES = ${JSON.stringify(dark)};`,
          'const LIGHT_SHIKI_THEME_NAMES = new Set(LIGHT_SHIKI_THEMES);',
          'function shikiColorScheme(name) { return LIGHT_SHIKI_THEME_NAMES.has(name) ? "light" : "dark"; }',
          `const SHIKI_THEME_IMPORTS = { ${imports.join(',')} };`,
          'function createShikiTheme(name) { return createTheme({ name, collection: SHIKI_COLLECTION, colorScheme: shikiColorScheme(name), load: SHIKI_THEME_IMPORTS[name] }); }',
          'export const shikiThemes = createThemeCollection({ themes: [...LIGHT_SHIKI_THEMES, ...DARK_SHIKI_THEMES].map(createShikiTheme) });'
        ].join('\n')
      }
      if (normalized.endsWith('/collections/pierre.js')) {
        const names = [...SHIKI_THEME_ALLOWLIST].filter((name) => name.startsWith('pierre-'))
        const light = names.filter(lightTheme)
        const lightNames = new Set(light)
        const dark = names.filter((name) => !lightNames.has(name))
        const imports = names.map((name) =>
          `${JSON.stringify(name)}: () => import(${JSON.stringify(`@pierre/theme/${name}`)})`
        )
        const labels = Object.fromEntries(names.map((name) => [name, name]))
        return [
          'import { createThemeCollection } from "../modules/createThemeCollection.js";',
          'import { createTheme } from "../modules/createTheme.js";',
          'const PIERRE_COLLECTION = "pierre";',
          `const DARK_PIERRE_THEMES = ${JSON.stringify(dark)};`,
          `const LIGHT_PIERRE_THEMES = ${JSON.stringify(light)};`,
          'const PIERRE_THEMES = [...LIGHT_PIERRE_THEMES, ...DARK_PIERRE_THEMES];',
          'const LIGHT_PIERRE_THEME_NAMES = new Set(LIGHT_PIERRE_THEMES);',
          'function pierreColorScheme(name) { return LIGHT_PIERRE_THEME_NAMES.has(name) ? "light" : "dark"; }',
          `const PIERRE_THEME_DISPLAY_NAMES = ${JSON.stringify(labels)};`,
          `const PIERRE_THEME_IMPORTS = { ${imports.join(',')} };`,
          'function createPierreTheme(name) { return createTheme({ name, collection: PIERRE_COLLECTION, colorScheme: pierreColorScheme(name), displayName: PIERRE_THEME_DISPLAY_NAMES[name], load: PIERRE_THEME_IMPORTS[name] }); }',
          'export const pierreThemes = createThemeCollection({ themes: PIERRE_THEMES.map(createPierreTheme) });'
        ].join('\n')
      }
      return null
    }
  }
}

// @pierre/diffs creates a main-thread highlighter only when the worker pool is
// not working or an edit session is attached (renderers/FileRenderer.js:132);
// every diff in this app is tokenised in the diff worker, which has its own copy
// of the engine. The static import still made the renderer fetch, parse and
// evaluate 173 KB of textmate + oniguruma before the first paint, because an ES
// import is evaluated whether or not its bindings are ever read. Both call sites
// below are already inside an async function, so the engine can be fetched on the
// first main-thread highlight instead. The worker keeps the eager import.
const SHARED_HIGHLIGHTER_MODULE = '/@pierre/diffs/dist/highlighter/shared_highlighter.js'
const HIGHLIGHTER_ENGINE_IMPORT =
  'import { createHighlighter, createJavaScriptRegexEngine, createOnigurumaEngine } from "shiki";'
const SHARED_HIGHLIGHTER_SIGNATURE =
  'async function getSharedHighlighter({ themes, langs, preferredHighlighter = "shiki-js" }) {'

function lazyHighlighterEnginePlugin(): Plugin {
  return {
    name: 'kodi:lazy-highlighter-engine',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.split('?')[0]?.replaceAll('\\', '/') ?? id
      if (!normalized.endsWith(SHARED_HIGHLIGHTER_MODULE)) return null
      if (!code.includes(HIGHLIGHTER_ENGINE_IMPORT) || !code.includes(SHARED_HIGHLIGHTER_SIGNATURE)) {
        throw new Error(
          "@pierre/diffs shared_highlighter.js no longer matches kodi:lazy-highlighter-engine. Update the anchors after checking that getSharedHighlighter is still async, or remove the plugin and accept the engine on the boot path."
        )
      }
      return code
        .replace(HIGHLIGHTER_ENGINE_IMPORT, '')
        .replace(
          SHARED_HIGHLIGHTER_SIGNATURE,
          `${SHARED_HIGHLIGHTER_SIGNATURE}\n  const { createHighlighter, createJavaScriptRegexEngine, createOnigurumaEngine } = await import('shiki')`
        )
    }
  }
}

// The other static edge from the viewer into the tokenizer: every theme
// descriptor wraps its loader in `normalizeTheme`, which lives in @shikijs/core.
// The wrapper is async and only runs when a theme is actually loaded for a
// main-thread highlighter, so the normaliser travels with the engine.
const THEME_NORMALIZER_MODULE = '/@pierre/theming/dist/modules/createTheme.js'
const THEME_NORMALIZER_IMPORT = 'import { normalizeTheme } from "shiki/core";'
const THEME_NORMALIZER_CALL = 'return normalizeTheme(unwrapDefault(await loader()));'

function lazyThemeNormalizerPlugin(): Plugin {
  return {
    name: 'kodi:lazy-theme-normalizer',
    enforce: 'pre',
    transform(code, id) {
      const normalized = id.split('?')[0]?.replaceAll('\\', '/') ?? id
      if (!normalized.endsWith(THEME_NORMALIZER_MODULE)) return null
      if (!code.includes(THEME_NORMALIZER_IMPORT) || !code.includes(THEME_NORMALIZER_CALL)) {
        throw new Error(
          '@pierre/theming createTheme.js no longer matches kodi:lazy-theme-normalizer. Update the anchors after checking that the loader is still async, or remove the plugin and accept the tokenizer on the boot path.'
        )
      }
      return code
        .replace(THEME_NORMALIZER_IMPORT, '')
        .replace(
          THEME_NORMALIZER_CALL,
          `const { normalizeTheme } = await import('shiki/core')\n\t\t${THEME_NORMALIZER_CALL}`
        )
    }
  }
}

// Both viewers ship their stylesheet as one JS string — the build's minifier only
// shortens code, so its indentation and blank lines reached the boot path
// verbatim (~15 KB). The CSS minifier gives the same rules in less.
const LIBRARY_STYLE_MODULES = ['/@pierre/diffs/dist/style.js', '/@pierre/trees/dist/style.js']
const LIBRARY_STYLE_DECLARATION = /var style_default = ("(?:[^"\\]|\\.)*");/

function minifyLibraryStylesPlugin(): Plugin {
  return {
    name: 'kodi:minify-library-styles',
    enforce: 'pre',
    async transform(code, id) {
      const normalized = id.split('?')[0]?.replaceAll('\\', '/') ?? id
      if (!LIBRARY_STYLE_MODULES.some((module) => normalized.endsWith(module))) return null
      const declaration = LIBRARY_STYLE_DECLARATION.exec(code)
      if (declaration?.[1] == null) {
        throw new Error(`${normalized} no longer declares its stylesheet as \`var style_default = "…"\`. Update kodi:minify-library-styles.`)
      }
      const css = JSON.parse(declaration[1]) as string
      const minified = await transformWithEsbuild(css, 'style.css', { loader: 'css', minify: true, target: 'chrome130' })
      return { code: code.replace(declaration[1], JSON.stringify(minified.code.trim())), map: null }
    }
  }
}

// Our own stylesheets for the viewers' shadow roots are template strings too
// (`*_CSS`, `*_STYLES`), and their indentation reached the bundle the same way.
// Whitespace that spans a line break is one space to CSS, and none beside a
// brace, `;` or `,`. Only the literal text is touched, never a `${…}` part.
const CSS_STRING_DECLARATION = /[A-Z0-9](?:_CSS|_STYLES) = `/
const CSS_STRING_NAME = /(?:_CSS|_STYLES)$/

interface SyntaxNode {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

function visitDeclarators(node: unknown, visit: (declarator: SyntaxNode) => void): void {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) visitDeclarators(child, visit)
    return
  }
  const syntax = node as SyntaxNode
  if (syntax.type === 'VariableDeclarator') visit(syntax)
  for (const key in syntax) visitDeclarators(syntax[key], visit)
}

function collapseCssWhitespace(raw: string): string {
  return raw
    .replace(/\s*\n\s*/g, '\n')
    .replace(/([{};,])\n|\n(?=[{}])/g, '$1')
    .replaceAll('\n', ' ')
}

function collapseCssStringsPlugin(): Plugin {
  return {
    name: 'kodi:collapse-css-strings',
    apply: 'build',
    transform(code, id) {
      const file = id.split('?')[0]?.replaceAll('\\', '/') ?? id
      if (!file.includes('/src/renderer/src/') || !CSS_STRING_DECLARATION.test(code)) return null
      const output = new MagicString(code)
      visitDeclarators(this.parse(code), (declarator) => {
        const name = declarator.id as SyntaxNode | undefined
        const init = declarator.init as SyntaxNode | null | undefined
        if (name?.type !== 'Identifier' || !CSS_STRING_NAME.test(String(name.name))) return
        if (init?.type !== 'TemplateLiteral') return
        for (const quasi of init.quasis as SyntaxNode[]) {
          const raw = (quasi.value as { raw: string }).raw
          if (code.slice(quasi.start, quasi.end) !== raw) {
            throw new Error(`kodi:collapse-css-strings misread a template string in ${file}.`)
          }
          const collapsed = collapseCssWhitespace(raw)
          if (collapsed === raw) continue
          if (collapsed === '') output.remove(quasi.start, quasi.end)
          else output.overwrite(quasi.start, quasi.end, collapsed)
        }
      })
      if (!output.hasChanged()) return null
      return { code: output.toString(), map: output.generateMap({ hires: true }) }
    }
  }
}

function preloadBootChunkPlugin(): Plugin {
  return {
    name: 'kodi:preload-boot',
    transformIndexHtml: {
      order: 'post',
      handler(_html, context) {
        if (context.bundle == null) return []
        const tags: Array<{ tag: string; attrs: Record<string, string>; injectTo: 'head' }> = []
        for (const file of Object.values(context.bundle)) {
          if (file.type === 'chunk' && file.name === 'boot') {
            tags.push({
              tag: 'link',
              attrs: { rel: 'modulepreload', crossorigin: '', href: `./${file.fileName}` },
              injectTo: 'head'
            })
          } else if (file.type === 'asset' && file.fileName.endsWith('.css') && file.fileName.includes('boot-')) {
            // Without crossorigin the preload's credentials mode does not match
            // the stylesheet link Vite emits, so Chromium discards the warmed
            // response and fetches the sheet a second time.
            tags.push({
              tag: 'link',
              attrs: { rel: 'preload', as: 'style', crossorigin: '', href: `./${file.fileName}` },
              injectTo: 'head'
            })
          }
        }
        return tags
      }
    }
  }
}

// Rollup names shared chunks after an arbitrary module inside them, which is how
// the markdown pipeline ended up hiding in a chunk called BackToTopButton. Naming
// the four heavy vendor groups makes `bun run check:entry` and a source-map read
// say what actually ships on the pre-mount path.
const VENDOR_CHUNKS: ReadonlyArray<readonly [string, RegExp]> = [
  ['vendor-react', /\/node_modules\/(?:react|react-dom|scheduler)\//],
  // The code editor is only imported when a file is opened for editing
  // (useFileEditing.ts). Left inside vendor-diffs it rode the viewer's static
  // import and dragged shiki's textmate tokenizer onto the boot path with it.
  ['vendor-diffs-edit', /\/node_modules\/@pierre\/diffs\/dist\/(?:edit|editor)\//],
  ['vendor-diffs', /\/node_modules\/@pierre\/diffs\//],
  // hast-*, property-information and the entity tables are shared with shiki's
  // HTML serializer, so they stay out of this group: pulling them in makes
  // vendor-markdown a dependency of the highlighter and puts it back on the
  // pre-mount path.
  [
    'vendor-markdown',
    /\/node_modules\/(?:react-markdown|rehype-[^/]+|remark-[^/]+|micromark[^/]*|mdast-[^/]+|parse5|unified)\//
  ],
  // The HTML serializer and its tables are shared by the markdown pipeline and
  // shiki. Left unassigned Rollup folded them into vendor-shiki, which made the
  // whole tokenizer engine a static dependency of both.
  [
    'vendor-hast',
    /\/node_modules\/(?:hast-util-to-html|hast-util-whitespace|property-information|stringify-entities|character-entities[^/]*|comma-separated-tokens|space-separated-tokens|html-void-elements|zwitch|ccount)\//
  ],
  // Named rather than left to Rollup, which merges an unassigned shared module
  // into whichever chunk already imports it — here, the engine it is supposed to
  // keep off the boot path.
  ['vendor-shiki-langs', /\/node_modules\/shiki\/dist\/langs-bundle-full/],
  ['vendor-shiki', /\/node_modules\/(?:shiki|@shikijs\/[^/]+|oniguruma-[^/]+)\//]
]

// Two shiki leaves the viewer needs before it can highlight anything: the
// language registry `resolveLanguage` looks names up in, and the token-style
// transformer the renderers wrap every file with. Neither pulls the tokenizer in,
// but grouping them with it made the engine a static dependency of the viewer, so
// they are left for Rollup to place next to their importer.
const MAIN_THREAD_HIGHLIGHT_SUPPORT = /\/node_modules\/@shikijs\/transformers\//

// Every grammar and theme is already an on-demand chunk keyed by language name.
// Folding them into vendor-shiki with the engine shipped 8.2 MB of grammars in
// one chunk, so they stay out of the grouping.
const ON_DEMAND_HIGHLIGHT_ASSETS =
  /\/node_modules\/(?:@shikijs\/(?:langs|themes)|@pierre\/theme|shiki\/dist\/langs)\//

function vendorChunk(id: string): string | undefined {
  const normalized = id.replaceAll('\\', '/')
  // Vite's dynamic-import preload helper is shared by every lazy chunk. Left
  // unassigned it is small enough for Rollup's chunk merging to fold it into a
  // vendor group — it landed in vendor-shiki, and the entry then statically
  // imported 208 KB of highlighter before boot. A manual chunk is never merged.
  if (normalized.includes('vite/preload-helper')) return 'vite-preload'
  if (ON_DEMAND_HIGHLIGHT_ASSETS.test(normalized)) return undefined
  if (MAIN_THREAD_HIGHLIGHT_SUPPORT.test(normalized)) return undefined
  for (const [name, pattern] of VENDOR_CHUNKS) {
    if (pattern.test(normalized)) return name
  }
  return undefined
}

function dropShikiWasmPlugin(): Plugin {
  const stubId = '\0kodi:shiki-wasm-stub'
  return {
    name: 'kodi:drop-shiki-wasm',
    // Vite's own resolver is a core plugin and wins over unenforced user
    // plugins, so without 'pre' the specifier is already resolved by the time
    // this runs and the chunk ships anyway.
    enforce: 'pre',
    resolveId(source) {
      return source === 'shiki/wasm' ? stubId : null
    },
    load(id) {
      if (id !== stubId) return null
      return "throw new Error('shiki/wasm is stubbed out of this build; the highlighter uses the JS regex engine. Remove the kodi:drop-shiki-wasm plugin to ship the oniguruma engine.')\n"
    }
  }
}

interface CompilerLogEvent {
  kind: string
  fnName?: string | null
  fnLoc?: { start?: { line?: number } } | null
  detail?: { reason?: string; description?: string } | null
}

// A component the compiler skips is a component nothing in it is memoised in, and
// the build says nothing about it. KODI_COMPILER_LOG=1 prints one line per skip
// with the reason; src/renderer/src/reactCompiler.test.ts keeps the hot components
// honest without the build.
function reactCompilerOptions(): Record<string, unknown> {
  const options: Record<string, unknown> = { target: '19' }
  if (process.env.KODI_COMPILER_LOG !== '1') return options
  options.logger = {
    logEvent(filename: string | null, event: CompilerLogEvent) {
      if (event.kind === 'CompileSuccess') return
      const where = `${filename ?? '?'}:${event.fnLoc?.start?.line ?? '?'}`
      const reason = event.detail?.reason ?? event.detail?.description ?? ''
      console.log(`[react-compiler] ${event.kind} ${event.fnName ?? ''} ${where} ${reason}`)
    }
  }
  return options
}

// The About panel reports when this bundle was built. `SOURCE_DATE_EPOCH` wins
// when it is set, so a reproducible build stays byte-identical instead of
// baking in the wall clock of whoever ran it.
function buildTime(): string {
  const reproducible = process.env.SOURCE_DATE_EPOCH
  const seconds = reproducible == null ? Number.NaN : Number(reproducible)
  const built = Number.isFinite(seconds) ? new Date(seconds * 1_000) : new Date()
  return built.toISOString()
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __BUILD_TIME__: JSON.stringify(buildTime())
    },
    build: {
      // electron-vite ships minification off by default; every byte here is
      // parsed on every cold start, so all three targets opt in explicitly.
      minify: 'esbuild',
      rollupOptions: {
        input: resolve('src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      minify: 'esbuild',
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      // @pierre/trees still nests theme 1.1.0. Dedupe onto the root 2.0.0 so
      // Explorer and the highlighter share one pierre-light chunk.
      dedupe: ['@pierre/theme']
    },
    plugins: [
      react({
        babel: {
          plugins: [['babel-plugin-react-compiler', reactCompilerOptions()]]
        }
      }),
      contentSecurityPolicyPlugin(),
      preloadBootChunkPlugin(),
      dropShikiWasmPlugin(),
      trimShikiThemesPlugin(),
      lazyHighlighterEnginePlugin(),
      lazyThemeNormalizerPlugin(),
      minifyLibraryStylesPlugin(),
      collapseCssStringsPlugin()
    ],
    build: {
      minify: 'esbuild',
      cssMinify: 'esbuild',
      sourcemap: 'hidden',
      rollupOptions: {
        output: {
          manualChunks: vendorChunk
        }
      }
    },
    worker: {
      format: 'es',
      plugins: () => [dropShikiWasmPlugin(), trimShikiThemesPlugin()]
    }
  }
})
