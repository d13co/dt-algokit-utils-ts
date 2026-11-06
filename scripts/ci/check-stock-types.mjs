// Type-checks the built declarations in dist/ against stock algosdk, as a consumer without dt-algosdk sees them.
//
// Usage: node scripts/ci/check-stock-types.mjs   (after `npm run build`; needs the npm registry)
//
// The build checks dist/*.d.ts against the dt-algosdk the repo builds with (tsconfig.dist-check.json). This checks them
// again against stock algosdk: the oldest of the peer range (3.5.2 of `^3.5.2 || ^<dt-algosdk>`) and the newest it
// matches (`^3.5.2`), so a published type that names something only dt-algosdk has fails here and not in a consumer's build.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const range = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).peerDependencies.algosdk
const oldest = range
  .split('||')
  .map((r) => r.trim().replace(/^\^/, ''))
  .find((v) => /^\d+\.\d+\.\d+$/.test(v))
if (!oldest) throw new Error(`No stock algosdk version in the algosdk peer range ${range}`)

/** Type-checks dist/ against the stock algosdk `spec` resolves to; returns whether it passed. */
function check(spec) {
  // The real path: tsc's trace shows real paths, and a temp dir can be behind a symlink (/var on macOS)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stock-algosdk-')))
  try {
    // --prefix reads no .npmrc of the repo's, so its min-release-age doesn't apply: the install runs no scripts, and tsc only
    // reads its .d.ts files
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    execFileSync(npm, ['install', '--prefix', dir, '--no-save', '--no-package-lock', '--ignore-scripts', `algosdk@${spec}`], {
      stdio: 'inherit',
    })
    const sdk = join(dir, 'node_modules', 'algosdk')
    const installed = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'))
    if (installed.name !== 'algosdk' || !/^\d+\.\d+\.\d+$/.test(installed.version) || (spec === oldest && installed.version !== oldest))
      throw new Error(`algosdk@${spec} installed ${installed.name}@${installed.version}`)
    const stock = installed.version

    // dist/ copied next to it, as in a consumer's node_modules: its imports of algosdk find the stock install
    cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true, filter: (src) => !/\.(m?js|map)$/.test(src) })
    const tsconfig = join(dir, 'tsconfig.json')
    writeFileSync(
      tsconfig,
      JSON.stringify({
        extends: join(root, 'tsconfig.dist-check.json'),
        compilerOptions: { typeRoots: [join(root, 'node_modules', '@types')] },
        include: [join(dir, 'dist', '**', '*.d.ts')],
      }),
    )
    console.log(`Type-checking dist/*.d.ts against algosdk@${stock}`)
    // --traceResolution shows where algosdk resolved: to the stock install, not the repo's dt-algosdk
    const tsc = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfig, '--traceResolution'], {
      encoding: 'utf8',
      maxBuffer: 1 << 30,
    })
    if (tsc.error) throw tsc.error
    const lines = tsc.stdout.split('\n')
    const resolved = lines.filter((line) => /^======== Module name 'algosdk(\/[^']*)?' was successfully resolved to/.test(line))
    const elsewhere = resolved.filter((line) => !line.includes(`'${sdk}/`))
    // tsc prints its errors to stdout among the trace, each starting with a path and a (line,col) position
    const errors = lines.filter((line) => /\(\d+,\d+\): error TS/.test(line) || /^error TS/.test(line))
    for (const line of [...errors, ...elsewhere]) console.error(line)
    if (tsc.status !== 0 || errors.length || elsewhere.length || !resolved.length) {
      console.error(
        `Failed: tsc exited with ${tsc.status}, ${errors.length} errors, ${resolved.length} algosdk imports resolved, ${elsewhere.length} elsewhere`,
      )
      return false
    }
    console.log(`OK: ${resolved.length} algosdk imports resolved to algosdk@${stock}`)
    return true
  } catch (error) {
    // Failed, but the other version is still checked
    console.error(`Failed: algosdk@${spec}: ${error instanceof Error ? error.message : error}`)
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The oldest stock algosdk of the peer range, and the newest, which a new install gets
const results = [oldest, `^${oldest}`].map(check)
if (!results.every(Boolean)) process.exitCode = 1
