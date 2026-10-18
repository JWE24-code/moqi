/**
 * `$EDITOR` is a command line, not a program name: run the real invocation
 * against fake editors and check what they received.
 *
 * Run with: node --experimental-strip-types tests/editor-smoke.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { editorInvocation } from '../src/local-platform.ts'

const dir = mkdtempSync(join(tmpdir(), 'moqi-editor-'))
try {
  // A fake editor that records its arguments, one per line, into the file it was given.
  const fake = join(dir, 'fake editor.sh')
  writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$(eval echo \\${$#})"\n')
  chmodSync(fake, 0o755)
  const quotedFake = `'${fake}'`

  const run = (editor: string, file: string): string[] => {
    const [program, args] = editorInvocation(editor, file)
    const result = spawnSync(program, args, { encoding: 'utf8' })
    assert.equal(result.status, 0, `editor exited ${String(result.status)}: ${result.stderr}`)
    return readFileSync(file, 'utf8').trimEnd().split('\n')
  }

  // The Omarchy shape: a launcher plus a flag (the bug: spawn treated the whole string as one program).
  const plain = join(dir, 'rules.yaml')
  assert.deepEqual(run(`${quotedFake} --inline`, plain), ['--inline', plain])

  // A plain program name still works.
  assert.deepEqual(run(quotedFake, plain), [plain])

  // A path with spaces and quotes reaches the editor as one argument, unexpanded.
  const awkward = join(dir, `it's a "rules" file $HOME.yaml`)
  assert.deepEqual(run(`${quotedFake} --wait`, awkward), ['--wait', awkward])

  // The invocation never splices the path into the command text.
  const [, args] = editorInvocation('vi', '/tmp/x; rm -rf ~')
  assert.equal(args[1], 'vi "$1"')
  assert.equal(args[3], '/tmp/x; rm -rf ~')

  console.log('editor-smoke: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
