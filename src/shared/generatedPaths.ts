/**
 * Path heuristics for files a reviewer does not read line by line: lockfiles,
 * snapshots, codegen output, minified bundles. A repository's own
 * `.gitattributes` (`linguist-generated`) overrides these in main.
 */

const GENERATED_DIRECTORIES = new Set([
  '__generated__',
  '__snapshots__',
  '.generated',
  'codegen',
  'gen',
  'generated',
  'generated-sources',
  'generated-src'
])

const LOCKFILES = new Set([
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'gemfile.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
  'composer.lock',
  'go.sum',
  'flake.lock'
])

const GENERATED_SUFFIXES = [
  '.d.ts.map',
  '.g.dart',
  '.generated.cjs',
  '.generated.css',
  '.generated.js',
  '.generated.jsx',
  '.generated.mjs',
  '.generated.ts',
  '.generated.tsx',
  '.pb.go',
  '.pb.gw.go',
  '.snap',
  '.snapshot',
  '-generated.js',
  '-generated.ts',
  '-generated.tsx',
  '.min.cjs',
  '.min.css',
  '.min.js',
  '.min.mjs',
  '.pb.cc',
  '.pb.h',
  '.pb.rb',
  '_generated.go',
  '_generated.rs',
  '_pb2.py',
  '_pb2_grpc.py'
]

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return (slash === -1 ? path : path.slice(slash + 1)).toLowerCase()
}

export function isLockfilePath(path: string): boolean {
  return LOCKFILES.has(basenameOf(path))
}

export function isSnapshotPath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower.split('/').slice(0, -1).includes('__snapshots__') ||
    lower.endsWith('.snap') || lower.endsWith('.snapshot')
}

export function isGeneratedPath(path: string): boolean {
  const basename = basenameOf(path)
  if (LOCKFILES.has(basename)) return true
  const directories = path.toLowerCase().split('/').slice(0, -1)
  if (directories.some((segment) => GENERATED_DIRECTORIES.has(segment))) return true
  if (GENERATED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return true
  return basename.endsWith('.map') && !basename.endsWith('.importmap')
}
