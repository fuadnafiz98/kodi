import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformAsync } from '@babel/core'

// A component the React Compiler skips keeps none of its work between renders,
// and a build prints nothing about it. These are the components on the typing and
// startup paths, where a silent bail-out is the difference between 0 and 2.4
// workspace renders per keystroke.
const HOT_COMPONENTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['app/App.tsx', ['App', 'AppLayout', 'AgentSessionLayout']],
  // Split out of App.tsx: the chrome and the stage render on every app render.
  ['app/AppChrome.tsx', ['AppChrome']],
  ['app/WorkspaceStage.tsx', ['WorkspaceStage']],
  ['app/CachedWorkspaceFallback.tsx', ['CachedWorkspaceFallback']],
  ['palette/CommandPalette.tsx', ['CommandPalette']],
  ['palette/CommandPaletteHost.tsx', ['CommandPaletteHost', 'CommandPaletteShell']],
  // Split out of CommandPalette.tsx: the rows are what a keystroke re-renders.
  ['palette/PaletteResults.tsx', ['PaletteResults']],
  ['palette/PaletteRow.tsx', ['PaletteRow']],
  ['palette/paletteActions.ts', ['usePaletteActions']],
  ['app/RepositoryWorkspace.tsx', ['RepositoryWorkspace']],
  // Split out of AppView.tsx; both are in the chunk that paints first.
  ['app/Titlebar.tsx', ['Titlebar']],
  ['diff/DiffToolbar.tsx', ['DiffToolbar']]
]

const SOURCE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..')

interface CompilerEvent {
  kind: string
  fnName?: string | null
  fnLoc?: { start?: { line?: number } } | null
  detail?: { reason?: string; details?: ReadonlyArray<{ loc?: { start?: { line?: number } } }> } | null
}

async function compile(file: string): Promise<CompilerEvent[]> {
  const events: CompilerEvent[] = []
  const source = await readFile(join(SOURCE_DIRECTORY, file), 'utf8')
  await transformAsync(source, {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['typescript', 'jsx'] },
    plugins: [['babel-plugin-react-compiler', {
      target: '19',
      logger: { logEvent: (_filename: string | null, event: CompilerEvent) => events.push(event) }
    }]]
  })
  return events
}

function describeFailure(event: CompilerEvent): string {
  const line = event.detail?.details?.[0]?.loc?.start?.line ?? event.fnLoc?.start?.line ?? '?'
  return `${event.kind} at line ${line}: ${event.detail?.reason ?? 'unknown reason'}`
}

describe('React Compiler', () => {
  for (const [file, components] of HOT_COMPONENTS) {
    test(`compiles the hot components in ${file}`, async () => {
      const events = await compile(file)
      const compiled = new Set(events
        .filter((event) => event.kind === 'CompileSuccess')
        .map((event) => event.fnName ?? ''))

      for (const component of components) {
        if (compiled.has(component)) continue
        throw new Error(
          `${file}: the compiler skipped ${component}. Reasons reported for this file:\n  `
          + (events
            .filter((event) => event.kind !== 'CompileSuccess')
            .map(describeFailure)
            .join('\n  ') || '(none — is the component still named this?)')
        )
      }

      expect(compiled.size).toBeGreaterThanOrEqual(components.length)
    })
  }
})
