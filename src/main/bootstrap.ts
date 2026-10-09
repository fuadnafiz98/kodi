import { enableCompileCache } from 'node:module'
import { join } from 'node:path'

import { app } from 'electron'

// The main bundle is ~200 KB, and Node compiles every function it runs on every
// launch: ~45 ms of the browser main thread before the window exists, the same
// thread that delivers input. Node's compile cache keeps that work between
// launches; it covers only modules loaded after it is enabled, so this entry
// enables it and then loads the app.
try {
  enableCompileCache(join(app.getPath('userData'), 'Main Code Cache'))
} catch {
  // Without the cache the app starts as it always did.
}

await import('./index.js')
