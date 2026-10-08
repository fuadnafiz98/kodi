/** Patches shared by the guide tests. */

export function modifiedFile(path: string, hunks: Array<{ oldStart: number; newStart: number; lines: string[] }>): string {
  const body = hunks.map(({ oldStart, newStart, lines }) => {
    const oldCount = lines.filter((line) => !line.startsWith('+')).length
    const newCount = lines.filter((line) => !line.startsWith('-')).length
    return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...lines].join('\n')
  }).join('\n')
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    body
  ].join('\n')
}

export function binaryFile(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 3333333..4444444 100644',
    `Binary files a/${path} and b/${path} differ`
  ].join('\n')
}

export function renamedFile(from: string, to: string): string {
  return [
    `diff --git a/${from} b/${to}`,
    'similarity index 100%',
    `rename from ${from}`,
    `rename to ${to}`
  ].join('\n')
}

export function joinPatch(...sections: string[]): string {
  return `${sections.join('\n')}\n`
}
