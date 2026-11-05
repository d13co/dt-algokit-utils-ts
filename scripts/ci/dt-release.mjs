// Keep the versions in the docs in step with package.json, and check them before a release.
//
// Usage:
//   node scripts/ci/dt-release.mjs update        rewrite the docs for the package.json versions
//   node scripts/ci/dt-release.mjs check [tag]   fail if the docs, package-lock.json, the dt-algosdk versions or the tag disagree
//
// The docs name two versions: @d13co/dt-algokit-utils@<package.json version> and
// dt-algosdk@<the exact dt-algosdk devDependency>, in the install snippets. The devDependency is
// npm:dt-algosdk@<version>, or file:./vendor/dt-algosdk-<version>.tgz while that version isn't on npm (not for a release:
// `check <tag>` needs npm:).
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file) => readFileSync(join(root, file), 'utf8')
const readJson = (file) => JSON.parse(read(file))

const NAME = '@d13co/dt-algokit-utils'
const DOCS = ['README.md', 'docs/dt-fork.md']
const FORMAT = '<algokit-utils version>-dt.<dt-algorand release>.<x.y.z>'
const VERSION_FORMAT = /^\d+\.\d+\.\d+-dt\.\d+\.\d+\.\d+\.\d+$/
const DT_VERSION = /\d+\.\d+\.\d+-dt(?:\.\d+)+/.source
// npm:@d13co/dt-algokit-utils@9.2.3-dt.4.1.0.0 and npm:dt-algosdk@3.9.0-dt.4.1.0.0 in the install snippets
const utilsRef = new RegExp(`@d13co/dt-algokit-utils@(${DT_VERSION})`, 'g')
const sdkRef = new RegExp(`(?<![\\w@/-])dt-algosdk@(${DT_VERSION})`, 'g')

const [mode, tag] = process.argv.slice(2)
const pkg = readJson('package.json')
const { version } = pkg
const sdkSpec = pkg.devDependencies?.algosdk ?? ''
const sdkVersion = (/^npm:dt-algosdk@(.+)$/.exec(sdkSpec) ?? /^file:\.\/vendor\/dt-algosdk-(.+)\.tgz$/.exec(sdkSpec))?.[1]

// Compares two dt prereleases of the same x.y.z, identifier by identifier (all numeric after `dt`)
const comparePre = (a, b) => {
  const [pa, pb] = [a, b].map((v) => v.split('-')[1].split('.').slice(1).map(Number))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1)
    if (d) return Math.sign(d)
  }
  return 0
}

if (mode === 'update') {
  if (!VERSION_FORMAT.test(version)) {
    console.error(`version ${version} is not ${FORMAT}`)
    process.exit(1)
  }
  if (!sdkVersion || !new RegExp(`^${DT_VERSION}$`).test(sdkVersion)) {
    console.error(
      `devDependencies.algosdk is ${sdkSpec}, not npm:dt-algosdk@<exact dt version> or file:./vendor/dt-algosdk-<exact dt version>.tgz`,
    )
    process.exit(1)
  }
  for (const file of DOCS) {
    const text = read(file)
    const updated = text.replace(utilsRef, `${NAME}@${version}`).replace(sdkRef, `dt-algosdk@${sdkVersion}`)
    writeFileSync(join(root, file), updated)
    console.log(`${file}: ${text === updated ? 'unchanged' : 'updated'}`)
  }
  console.log(`${NAME} ${version}, dt-algosdk ${sdkVersion}`)
} else if (mode === 'check') {
  const errors = []
  const lock = readJson('package-lock.json')
  if (pkg.name !== NAME) errors.push(`package.json name is ${pkg.name}`)
  if (!VERSION_FORMAT.test(version)) errors.push(`version ${version} is not ${FORMAT}`)
  if (lock.version !== version || lock.packages[''].version !== version)
    errors.push(`package-lock.json version ${lock.version} is not ${version}`)
  if (tag && tag !== `v${version}`) errors.push(`tag ${tag} is not v${version}`)

  // The repo builds and tests against one exact dt-algosdk, and the peer range must accept it
  if (!sdkVersion || !new RegExp(`^${DT_VERSION}$`).test(sdkVersion)) {
    errors.push(
      `devDependencies.algosdk is ${sdkSpec}, not npm:dt-algosdk@<exact dt version> or file:./vendor/dt-algosdk-<exact dt version>.tgz`,
    )
  } else {
    const locked = lock.packages['node_modules/algosdk']?.version
    if (locked !== sdkVersion) errors.push(`package-lock.json has dt-algosdk ${locked}, not ${sdkVersion}`)
    const peer = pkg.peerDependencies?.algosdk ?? ''
    const dtRanges = peer
      .split('||')
      .map((r) => r.trim())
      .filter((r) => r.includes('-dt.'))
    const accepts = dtRanges.some((r) => {
      const min = /^\^(.+)$/.exec(r)?.[1]
      return min && min.split('-')[0] === sdkVersion.split('-')[0] && comparePre(min, sdkVersion) <= 0
    })
    if (!accepts) errors.push(`peerDependencies.algosdk ${peer} has no ^<dt-algosdk> range that accepts ${sdkVersion}`)
    // A release's users install dt-algosdk from npm: a vendored one may not be there, or not be the same build
    if (tag && !sdkSpec.startsWith('npm:'))
      errors.push(`devDependencies.algosdk is ${sdkSpec}: a release needs npm:dt-algosdk@${sdkVersion}, published first`)
  }

  for (const file of DOCS) {
    const text = read(file)
    for (const [ref, found] of text.matchAll(utilsRef)) if (found !== version) errors.push(`${file}: ${ref} is not ${version}`)
    for (const [ref, found] of text.matchAll(sdkRef)) if (found !== sdkVersion) errors.push(`${file}: ${ref} is not ${sdkVersion}`)
  }

  if (errors.length) {
    errors.forEach((e) => console.error(e))
    console.error('Run `node scripts/ci/dt-release.mjs update` after setting the versions')
    process.exit(1)
  }
  console.log(`${NAME} ${version} (dt-algosdk ${sdkVersion}) is consistent${tag ? ` with ${tag}` : ''}`)
} else {
  console.error('Usage: dt-release.mjs update | check [tag]')
  process.exit(1)
}
