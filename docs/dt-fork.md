# dt-algokit-utils: differences from algokit-utils

`@d13co/dt-algokit-utils` is a fork of [`@algorandfoundation/algokit-utils`](https://github.com/algorandfoundation/algokit-utils-ts) (based on 9.2.3-beta.2) that adds support for [dtalgod](https://github.com/d13co/dt-algorand), an algod with time travel (state at any past round, and the rounds at which objects changed) and extended simulate (several transaction groups and several rounds per request).

- [Compatibility](#compatibility)
- [Installing](#installing)
- [API changes at a glance](#api-changes-at-a-glance)
- [Reads at a past round](#reads-at-a-past-round)
- [App clients pinned to a round](#app-clients-pinned-to-a-round)
- [Versions: when objects changed](#versions-when-objects-changed)
- [Extended simulate](#extended-simulate)
- [Aborting requests](#aborting-requests)
- [Errors](#errors)
- [Tests](#tests)
- [Building and publishing](#building-and-publishing)

## Compatibility

The fork is additive: every new parameter is optional and every new feature lives in a new method or module, so existing code, types and generated typed clients work unchanged.

- It runs on stock `algosdk` (`^3.5.2`). The fork of algosdk is detected at runtime; without it, the new features throw a `DTNotAvailableError` and everything else behaves as upstream.
- The public types never reference the algosdk fork's types, so it type-checks against stock algosdk too.
- Against a stock algod, reads without `round` and `composer.simulate()` behave as upstream (except that `composer.simulate({ round })` builds transactions valid at that round). Reads with `round` throw rather than return the latest state.

## Installing

The new features need two packages:

| Package                                                                            | Replaces                            | Adds                                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| [`@d13co/dt-algokit-utils`](https://www.npmjs.com/package/@d13co/dt-algokit-utils) | `@algorandfoundation/algokit-utils` | the APIs below                                                  |
| [`dtalgosdk`](https://www.npmjs.com/package/dtalgosdk)                             | `algosdk`                           | `DTAlgodClient`, the time-travel and extended-simulate requests |

algokit-utils, your code, generated typed clients and any other library must all load the same copy of each, so install both under their upstream names (npm aliases) and override them for the whole dependency tree. Imports stay `@algorandfoundation/algokit-utils` and `algosdk`. See [the README](../README.md#installing-the-fork) for the npm, pnpm, yarn and bun snippets.

To check the result:

```sh
npm ls algosdk @algorandfoundation/algokit-utils   # every entry should be the dtalgosdk / @d13co/dt-algokit-utils alias
pnpm why algosdk                                    # should list only dtalgosdk
```

At runtime, `await algorand.client.supportsDT()` (or `algorand.dt.supported()`) is `true` only when the algosdk fork is loaded and the node has time travel.

## API changes at a glance

New:

| Where                                                                                                         | What                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `algorand.dt` (`DTManager`)                                                                                   | Version listings: `get…Versions` (a page) and `iterate…Versions` (async iterator) for boxes, all boxes of an app, apps, assets, accounts, account asset holdings and account app local states; `supported()` |
| `algorand.simulate` (`SimulateManager`)                                                                       | `groups(composers, options)`, `rounds(composers, rounds, options)` and `limits()`                                                                                                                            |
| `algorand.client.dtAlgod`                                                                                     | The algod client as the fork's `DTAlgodClient`                                                                                                                                                               |
| `algorand.client.supportsDT()`                                                                                | Whether the fork is loaded and the node has time travel                                                                                                                                                      |
| `AppClient.atRound(round)`, `AppClient.round`                                                                 | A clone of the client pinned to a past round, and the round it's pinned to                                                                                                                                   |
| `DTNotAvailableError`, `isDTUnsupportedError` (exported from the package root)                                | See [Errors](#errors)                                                                                                                                                                                        |
| `accountInformationFromAlgod`, `AssetManager.assetInformationFromAlgod`, `AppManager.appInformationFromAlgod` | The converters from algod models that the existing getters use, exposed for the version listings                                                                                                             |

Changed (all additions are optional):

| Method                                                                                                                                                        | Change                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `algorand.account.getInformation(address, options?)`                                                                                                          | `{ round }`                                                                                                                                   |
| `algorand.asset.getById(assetId, options?)`, `getAccountInformation(address, assetId, options?)`                                                              | `{ round }`                                                                                                                                   |
| `algorand.app.getById`, `getGlobalState`, `getLocalState`, `getBoxNames`, `getBoxValue`, `getBoxValues`                                                       | `{ round, signal }`                                                                                                                           |
| `algorand.app.getBoxValueFromABIType`, `getBoxValuesFromABIType`                                                                                              | `round` in the box request params                                                                                                             |
| `AppClient` state reads (`getGlobalState`, `getLocalState`, `getBoxNames`, `getBoxValue(s)`, `getBoxValue(s)FromABIType`, and `state.*` in generated clients) | `{ round }`, defaulting to the client's pinned round                                                                                          |
| `AppClient` constructor / `clone` params                                                                                                                      | `round`                                                                                                                                       |
| `AppClient` readonly ABI calls                                                                                                                                | Simulated at the pinned round, if any; their extra opcode budget follows the node's reported `maxExtraOpcodeBudget` (320,000 if not reported) |
| `composer.simulate(options)`                                                                                                                                  | With `round`, transactions that don't set their own validity are built valid at that round; `signal`                                          |
| `AlgoHttpClientWithRetry`                                                                                                                                     | Passes fetch options (`customOptions`) through, stops retrying and backing off when their `signal` aborts                                     |

## Reads at a past round

Pass `{ round }` to the usual reads to get the state as of the end of that round:

```typescript
const account = await algorand.account.getInformation(address, { round: 45_000_000n })
const holding = await algorand.asset.getAccountInformation(address, assetId, { round: 45_000_000n })
const globalState = await algorand.app.getGlobalState(appId, { round: 45_000_000n })
const box = await algorand.app.getBoxValue(appId, 'config', { round: 45_000_000n })
```

The same option is on `getById`, `getLocalState`, `getBoxNames`, `getBoxValues`, `getBoxValue(s)FromABIType` and the `AppClient` state methods. Box listings at a past round can come in pages; `getBoxNames` follows them. A node that can't serve the round throws (`isDTUnsupportedError(e)`) rather than returning the latest state.

`composer.simulate({ round })` builds transactions that don't set their own validity so they are valid at that round.

## App clients pinned to a round

An `AppClient` pinned to a round reads state and simulates readonly ABI calls at that round, and can't send transactions. Generated typed clients take an `AppClient`, so they can be pinned too:

```typescript
const past = appClient.atRound(45_000_000n)
await past.state.global.getAll()
await past.send.call({ method: 'get_price' })

const typedPast = new MyAppClient(myAppClient.appClient.atRound(45_000_000n))
await typedPast.state.global.counter()
```

`atRound(undefined)` returns a client that reads the latest state again.

## Versions: when objects changed

`algorand.dt` lists the rounds at which a box, all of an app's boxes, an app, an asset or an account changed, optionally with the values, a page at a time (`get…Versions`) or as an async iterator (`iterate…Versions`):

```typescript
const { versions, nextToken } = await algorand.dt.getBoxVersions(appId, 'counter', {
  order: 'desc',
  limit: 10,
  includeValues: true,
})

for await (const { round, boxes } of algorand.dt.iterateBoxesVersions(appId, { minRound: 45_000_000n })) {
  // the boxes that changed in each round
}

const { versions: appVersions } = await algorand.dt.getAppVersions(appId, { includeValues: true })
appVersions.map((v) => v.app?.globalState)
```

Also `getAssetVersions`, `getAccountVersions` (with `exclude`), `getAccountAssetVersions` and `getAccountAppVersions`. Options: `minRound`, `maxRound`, `order` (`'asc'` or `'desc'`), `limit`, `includeValues`, and for a page `next` (the previous page's `nextToken`) and `signal`. `algorand.dt.supported()` tells whether the node has time travel.

## Extended simulate

`algorand.simulate` simulates without signatures, for reads and dry runs:

```typescript
// Several groups in one request: one after the other in one block, or each on its own with `parallel`
const [funded, spent] = await algorand.simulate.groups([fundComposer, spendComposer], { allowUnnamedResources: true })

// The same groups at many rounds: packed into as few requests as the node's limits allow, with the transactions built valid at each window of rounds
const composer = algorand.newGroup().addAppCallMethodCall(await appClient.params.call({ method: 'get_price' }))
for (const {
  round,
  groups: [g],
} of await algorand.simulate.rounds(composer, rounds, { allowUnnamedResources: true })) {
  if (g.ok) console.log(round, g.result.returns?.[0]?.returnValue)
  else console.log(round, g.error.kind, g.error.message)
}
```

Each outcome is `{ ok: true, result }`, with the same result shape as `composer.simulate()`, or `{ ok: false, error }`.

### Node limits

`simulate.groups` and `simulate.rounds` keep to the node's simulate limits, which dtalgod reports (`GET /v2/transactions/simulate/limits`) and `algorand.simulate.limits()` returns. They are asked for once per algod client. Requests hold at most `maxTxnGroups` groups and `maxRounds` rounds, and an `extraOpcodeBudget` above `maxExtraOpcodeBudget` throws, as do `protocol: 'future'` and `execTraceConfig` when the node reports the developer API off (a node that doesn't report its limits checks these itself). Readonly `AppClient` calls use the node's full `maxExtraOpcodeBudget` (320,000 on a node that doesn't report it).

A node without the limits endpoint (stock algod, or a dtalgod built before it) gets stock algod's limits, with `reported: false`. Each request then holds one group (sequential groups beyond one throw; `parallel` groups get one request each), and `simulate.rounds` sends one request per round with `round` set instead of `rounds`. On an older dtalgod, pass `maxGroups` and `maxRounds` (its defaults are 16) to use its extended simulate.

### Rounds far apart, under a later protocol

A transaction is valid for at most 1,000 rounds, so `simulate.rounds` normally puts rounds more than 1,000 apart in separate requests. With `validityWindow: 'rewrite'`, the node moves each transaction's validity window to every simulated round (dropping its signature), and with `'skip'` it evaluates the transactions as built outside their window; either way rounds of any span share a request. `protocol` (on `groups` and `rounds`) simulates under a later consensus protocol (`v24` to `v42`, `latest`, `future` on a node with the developer API, or a version string), as if an upgrade took effect right after the round, and each outcome's `protocolOverride` says how it applied:

```typescript
for (const { round, protocolOverride, groups } of await algorand.simulate.rounds(composer, [20_000_000n, 45_000_000n], {
  validityWindow: 'rewrite',
  protocol: 'latest',
})) {
  console.log(round, protocolOverride?.from, '->', protocolOverride?.to, groups[0].ok)
  for (const note of protocolOverride?.notes ?? []) console.log('  ', note.code, note.message)
}
```

With `'rewrite'` the transaction IDs change, so the results' `txIds` are those as built; transactions that differ only by their validity window need distinct notes, or the later one fails as a duplicate. These options need a dtalgod with these features and an algosdk fork that has them (every `dtalgosdk` release does; on an older build of the fork without the `simulate-limits` feature, the defaults of 16 groups and 16 rounds apply); an older fork throws a `DTNotAvailableError`, an older node a `DTUnsupportedError`.

## Aborting requests

`algorand.app` reads (except `getBoxValue(s)FromABIType`), `algorand.dt` version pages and `algorand.simulate.groups`/`rounds` take an optional `signal` (an `AbortSignal`), passed to fetch. An aborted request is never retried, and a retry backoff in progress ends as soon as the signal aborts. `composer.simulate({ signal })` checks the signal before and after the request (algosdk's composer can't pass it to fetch). The node's support probe and simulate limits are cached per client and shared, so they are read without the signal.

```typescript
const controller = new AbortController()
setTimeout(() => controller.abort(), 5_000)
await algorand.app.getGlobalState(appId, { round: 45_000_000n, signal: controller.signal })
```

## Errors

| Error                     | Meaning                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `DTNotAvailableError`     | The loaded algosdk isn't the fork, or is an older fork without a feature an option needs (the message lists them) |
| `isDTUnsupportedError(e)` | The node doesn't support the request: a stock algod, an older dtalgod, or a round it can't serve                  |

## Tests

`src/types/dt.spec.ts` runs offline against a stub algod. `src/types/dt.live.spec.ts` runs against a MainNet dtalgod:

```sh
DT_ALGOD_SERVER=http://host:port npx vitest run src/types/dt.live.spec.ts
```

The algosdk fork is vendored as `vendor/dtalgosdk-3.9.0-dt.2.0.1.0.tgz` (a dev dependency), so the repo's own build and tests use it.

## Building and publishing

`npm run build` builds into `dist/`, with its own `package.json` and README, and the package is published from there (`npm publish ./dist`), never from the repo root (the root `prepublishOnly` refuses). The build rewrites the README's relative links to `https://github.com/d13co/dt-algokit-utils-ts/blob/main/`, so this branch must be the repo's `main`.

### CI and CD

- `.github/workflows/ci.yml` validates every push to `main` or `dtalgorand` and every pull request with `dt-ci.yml`: type check, lint, an audit of the production dependencies (the full audit only warns), build and the tests against LocalNet.
- `.github/workflows/cd.yml` publishes on a pushed tag `v<version>` (only tags with `-dt.` in them). It runs the same validation on the tagged commit, checks the tag matches `package.json`'s version, skips a version already on npm, then builds and runs `npm publish ./dist --tag latest --provenance`.
- The upstream workflows (semantic-release, docs publishing) are removed: they need the Algorand Foundation's bot and secrets.

One-time setup:

1. Create `github.com/d13co/dt-algokit-utils-ts` and push this branch as `main`.
2. For the first publish, add an npm granular access token with read and write access (allowed to bypass 2FA) as the `NPM_TOKEN` secret (npm can only set up trusted publishing for a package that already exists). The `npm` environment is created on the first run; add protection rules to it if you want to approve each publish.
3. After the first publish, on npmjs.com under the package's Settings, add a trusted publisher: GitHub Actions, organization `d13co`, repository `dt-algokit-utils-ts`, workflow `cd.yml`, environment `npm`. Then delete the `NPM_TOKEN` secret and the token.

### Releasing

1. Choose the version (see below) and set it with `npm version <version> --no-git-tag-version`, which updates `package.json` and `package-lock.json`.
2. Update the version in the README's install snippets. If `dtalgosdk` moved to a new base version (say `3.9.1-dt.…`), update its snippets too and add `|| ^<base>-dt.0` to the `algosdk` peer range in `package.json`: a prerelease only matches a range naming the same `x.y.z`.
3. Publish `dtalgosdk` at that version first, since the snippets point at it.
4. Commit, then tag and push: `git tag v<version> && git push origin main v<version>`. The CD workflow publishes it.

Versions follow the same scheme as `dtalgosdk`: `<upstream base>-dt.<dt-algorand N>.<x>.<y>.<z>`, e.g. `9.2.3-dt.2.0.0.1`.

- `9.2.3`: the upstream algokit-utils version the code is built on (`v9.2.3-beta.2`). Bump it when merging a new upstream release.
- `dt.2`: the dt-algorand release whose API this covers (tag `v5.0.4-dt2`). It means "covers up to", not "requires": missing node features are detected at runtime. Keep it a separate identifier (`dt.2`, not `dt2`) so npm compares the number numerically.
- `0.0.1`: this package's own release, semver-style (a major bump for breaking changes). Reset to `0.0.1` whenever the base or the dt number changes.

These are prereleases, so `^` ranges don't match them; consumers pin exact versions in their overrides. `publishConfig.tag` is `latest`, so each publish becomes the default install.
