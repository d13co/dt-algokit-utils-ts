# dt-algokit-utils: differences from algokit-utils

`@d13co/dt-algokit-utils` is a fork of [`@algorandfoundation/algokit-utils`](https://github.com/algorandfoundation/algokit-utils-ts) (based on 9.2.3-beta.2) that adds support for [dtalgod](https://github.com/d13co/dt-algorand), an algod with time travel (state at any past round, and the rounds at which objects changed), extended simulate (several transaction groups per request) and read-only queries (many calls at many rounds per request).

- [Compatibility](#compatibility)
- [Installing](#installing)
- [API changes at a glance](#api-changes-at-a-glance)
- [Reads at a past round](#reads-at-a-past-round)
- [App clients pinned to a round](#app-clients-pinned-to-a-round)
- [Versions: when objects changed](#versions-when-objects-changed)
- [Box listings](#box-listings)
- [Asset holders](#asset-holders)
- [Extended simulate](#extended-simulate)
- [Queries](#queries)
- [Aborting requests](#aborting-requests)
- [Errors](#errors)
- [Tests](#tests)
- [Building and publishing](#building-and-publishing)

## Compatibility

The fork is additive: every new parameter is optional and every new feature lives in a new method or module, so existing code, types and generated typed clients work unchanged.

- It runs on stock `algosdk` (`^3.5.2`). dt-algosdk (`3.9.0-dt.5.2.0.0` or later) is detected at runtime by its `DTAlgodClient.features`; without it, the new features throw a `DTNotAvailableError` and everything else behaves as upstream.
- The public types never reference the algosdk fork's types, so it type-checks against stock algosdk too (CI checks the built types against the oldest and the newest stock algosdk of the peer range with `npm run check-stock-types`).
- The node side targets the current dt-algorand release, dt5 (`v5.0.5-dt5`). Older dtalgod releases are not supported; see [From dt4](#from-dt4) for what changed.
- dtalgod is told from stock algod by one check: its capabilities (`GET /v2/capabilities`, `algorand.client.capabilities()`), which every dtalgod node serves and stock algod doesn't (it answers 404). They are read once per algod client and also say which optional features the node has on (time travel, queries, the developer API) and the limits of its simulate and query requests. A capability that dt-algosdk doesn't report (an older or newer dt-algosdk), or a query limit that isn't a valid number, gets a safe default: stock algod's for simulate; for queries, the smallest counts (`maxTotalCalls` being `maxCalls` times `maxRounds`, as on nodes that don't report it) and 0 for the byte limits (no limit, or the protocol's for `maxCallLogBytes`).
- Each answer to a read at a round is also checked, by dt-algosdk: dtalgod marks it with an `X-Algod-TT-Round` header carrying the round (a 404 too), and an answer without it, or for another round, throws a `DTUnsupportedError`. This catches a load balancer that mixes nodes, where a read lands on a stock algod that ignores `round` and answers with the latest state. Box listings check the round in the body instead, since stock algod serves its last few rounds there. A proxy in front of the node must pass the header through: one that strips it makes every read at a round throw.
- Against a stock algod, reads without `round` and `composer.simulate()` behave as upstream (except that `composer.simulate({ round })` builds transactions valid at that round). Reads with `round`, `algorand.dt`, `algorand.simulate.groups` / `rounds` and `algorand.query` throw a `DTUnsupportedError` before sending anything, rather than return the latest state or a stock error.

The node features that are optional on a current dtalgod, and how each shows up:

| Feature                                                                | Node config                                | Without it                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Time travel: reads at a round, `algorand.dt`, simulate back to genesis | `EnableTimeTravel`                         | `DTUnsupportedError` before sending (`timeTravel` of the capabilities)                                               |
| Asset holders                                                          | `TimeTravelHoldersIndex` (and time travel) | `DTUnsupportedError` from the node's answer; an index still being built is a 503 thrown at once                      |
| Queries                                                                | `MaxAPIQueryCalls` above 0                 | `algorand.query.run` throws `DTUnsupportedError`; `groups` / `rounds` simulate instead (`query` of the capabilities) |
| Several groups per simulate request                                    | `MaxAPISimulateGroups` above 1             | sequential groups beyond `maxTxnGroups` throw (parallel groups always go one per request)                            |
| Execution traces, protocol `future`                                    | `EnableDeveloperAPI`                       | throws before sending (`developerApi` of the capabilities)                                                           |

## Installing

The new features need two packages:

| Package                                                                            | Replaces                            | Adds                                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| [`@d13co/dt-algokit-utils`](https://www.npmjs.com/package/@d13co/dt-algokit-utils) | `@algorandfoundation/algokit-utils` | the APIs below                                                  |
| [`dt-algosdk`](https://www.npmjs.com/package/dt-algosdk)                           | `algosdk`                           | `DTAlgodClient`, the time-travel and extended-simulate requests |

algokit-utils, your code, generated typed clients and any other library must all load the same copy of each, so install both under their upstream names (npm aliases) and override them for the whole dependency tree. Imports stay `@algorandfoundation/algokit-utils` and `algosdk`. See [the README](../README.md#installing-the-fork) for the npm, pnpm, yarn and bun snippets.

To check the result:

```sh
npm ls algosdk @algorandfoundation/algokit-utils   # every entry should be the dt-algosdk / @d13co/dt-algokit-utils alias
pnpm why algosdk                                    # should list only dt-algosdk
```

At runtime, `await algorand.client.supportsDT()` (or `algorand.dt.supported()`) is `true` only when dt-algosdk is loaded and the node is dtalgod with time travel on.

## API changes at a glance

New:

| Where                                                                                                               | What                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `algorand.dt` (`DTManager`)                                                                                         | Version listings: `get…Versions` (a page) and `iterate…Versions` (async iterator) for boxes, all boxes of an app, apps, assets, accounts, account asset holdings and account app local states, in a range or as of `rounds`, with `changedRound` and `changedKeys` (`includeKeys`), filtered by state `key` or box `prefix`; `getAssetHolders` / `iterateAssetHolders`; `supported()` |
| `algorand.simulate` (`SimulateManager`)                                                                             | `groups(composers, options)`, `rounds(composers, rounds, options)` and `limits()`                                                                                                                                                                                                                                                                                                     |
| `algorand.query` (`QueryManager`)                                                                                   | Read-only TEAL queries (`POST /v2/query`): `run(params, options)`, `groups(composers, options)` and `rounds(composers, rounds, options)` with simulate as the fallback, `limits()` and `supported()`                                                                                                                                                                                  |
| `algorand.app.getBoxes`, `appClient.getBoxes`                                                                       | An app's boxes under a name prefix, with values, from the paged box listing (pinned to `round` when given)                                                                                                                                                                                                                                                                            |
| `algorand.client.dtAlgod`                                                                                           | The algod client as the fork's `DTAlgodClient`                                                                                                                                                                                                                                                                                                                                        |
| `algorand.client.supportsDT()`                                                                                      | Whether the fork is loaded and the node has time travel                                                                                                                                                                                                                                                                                                                               |
| `algorand.client.capabilities()`                                                                                    | What the node can do (`GET /v2/capabilities`): whether it is dtalgod (`reported`), its optional features, its time limit and its simulate and query limits                                                                                                                                                                                                                            |
| `AppClient.atRound(round)`, `AppClient.round`                                                                       | A clone of the client pinned to a past round, and the round it's pinned to                                                                                                                                                                                                                                                                                                            |
| `composer.buildTransactionsWithValidity(validity)`                                                                  | `buildTransactions`, with the transactions that don't set their own validity valid from `firstValidRound` to `lastValidRound` (for a simulate at past rounds)                                                                                                                                                                                                                         |
| `DTNotAvailableError`, `isDTUnsupportedError`, `QueryCallError`, `QueryGroupError` (exported from the package root) | See [Errors](#errors)                                                                                                                                                                                                                                                                                                                                                                 |
| `accountInformationFromAlgod`, `AssetManager.assetInformationFromAlgod`, `AppManager.appInformationFromAlgod`       | The converters from algod models that the existing getters use, exposed for the version listings                                                                                                                                                                                                                                                                                      |

Changed (all additions are optional):

| Method                                                                                                                                                        | Change                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `algorand.account.getInformation(address, options?)`                                                                                                          | `{ round, signal }`                                                                                                                                                                                                                                                                                                                       |
| `algorand.asset.getById(assetId, options?)`, `getAccountInformation(address, assetId, options?)`                                                              | `{ round, signal }`                                                                                                                                                                                                                                                                                                                       |
| `algorand.app.getById`, `getGlobalState`, `getLocalState`, `getBoxNames`, `getBoxValue`, `getBoxValues`                                                       | `{ round, signal }`                                                                                                                                                                                                                                                                                                                       |
| `algorand.app.getBoxValueFromABIType`, `getBoxValuesFromABIType`                                                                                              | `round` and `signal` in the box request params                                                                                                                                                                                                                                                                                            |
| `AppClient` state reads (`getGlobalState`, `getLocalState`, `getBoxNames`, `getBoxValue(s)`, `getBoxValue(s)FromABIType`, and `state.*` in generated clients) | `{ round, signal }`, the round defaulting to the client's pinned round                                                                                                                                                                                                                                                                    |
| `appClient.state.box.getMap(mapName)`                                                                                                                         | One paged listing of the map's prefix with values, instead of a listing and one read per box; same entries, sorted by box name                                                                                                                                                                                                            |
| `AppClient` constructor / `clone` params                                                                                                                      | `round`                                                                                                                                                                                                                                                                                                                                   |
| `AppClient` readonly ABI calls                                                                                                                                | Simulated at the pinned round, if any; their extra opcode budget follows the node's reported `maxExtraOpcodeBudget` (320,000 if not reported)                                                                                                                                                                                             |
| `composer.simulate(options)`                                                                                                                                  | With `round`, transactions that don't set their own validity are built valid at that round; `signal`                                                                                                                                                                                                                                      |
| `AlgoHttpClientWithRetry`, `AlgoClientConfig`, `Config`                                                                                                       | With dt-algosdk, retries by its retry policy, changed per client (`retry` in `AlgoClientConfig`) or globally (`Config.configure({ retry })`), reporting each wait (`EventType.RetryWait` event, `onWait`, `waits`); passes fetch options (`customOptions`) through and stops retrying when their `signal` aborts. See [Retries](#retries) |

## From dt4

dt5 nodes dropped simulate's read extensions, which `POST /v2/query` replaced, and dt-algosdk `3.9.0-dt.5.2.0.0` dropped their requests; it also brought a retry policy shared with ghostkit and the Go SDK. In this fork:

| dt4                                                                                                                                                                                                                                                                                                                                                            | dt5                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parallel` sent the groups in requests of `maxGroups`                                                                                                                                                                                                                                                                                                          | Each parallel group goes in a request of its own                                                                                                                     |
| `simulate.rounds` packed rounds into requests (`maxRounds`)                                                                                                                                                                                                                                                                                                    | A request per round; `maxRounds` throws                                                                                                                              |
| `validityWindow: 'rewrite' \| 'skip'`                                                                                                                                                                                                                                                                                                                          | Throws: the groups are built valid at each round                                                                                                                     |
| `protocol` on simulate, `protocolOverride` on simulate outcomes                                                                                                                                                                                                                                                                                                | Throws: use `algorand.query` (`run`, or `groups` / `rounds`, which keep `protocol` on the query path)                                                                |
| `kind: 'round'` simulate errors                                                                                                                                                                                                                                                                                                                                | A round the node can't simulate throws                                                                                                                               |
| `simulate.maxRounds`, `simulate.resourceLimitMultiplier`                                                                                                                                                                                                                                                                                                       | Removed from the capabilities and `simulate.limits()`                                                                                                                |
| `SimulateProtocolOverride`, `SimulateProtocolNote`, `…NoteHit`, `…NoteCode`                                                                                                                                                                                                                                                                                    | `QueryProtocolOverride`, `QueryProtocolNote`, `QueryProtocolNoteHit`, `QueryProtocolNoteCode`                                                                        |
| —                                                                                                                                                                                                                                                                                                                                                              | `QueryLimits.maxTotalCalls` (calls × rounds per query request) and `maxCallStateBytes`                                                                               |
| `query.rounds` through simulate: a round that can't be simulated gave `kind: 'round'` outcomes                                                                                                                                                                                                                                                                 | Throws, as `simulate.rounds` does (the query path still gives `kind: 'round'`)                                                                                       |
| `maxRounds: 0` on `query.rounds` sent one simulate request per round                                                                                                                                                                                                                                                                                           | A `RangeError`: `maxRounds` caps the rounds per query request, so it is a positive integer                                                                           |
| `checkValidityWindow` (exported from `types/simulate-manager`)                                                                                                                                                                                                                                                                                                 | Removed                                                                                                                                                              |
| Transaction submits (`POST /v2/transactions`, `/async`) retried like other requests: after a 408, 413, 429, 500, 502, 503 or 504, or a network error with its code on the error itself (`ECONNRESET`, `ECONNREFUSED`, …)                                                                                                                                       | Retried only when the node surely didn't take them (a 429, a busy 503, a refused connection): check for the transaction instead ([Retries](#retries))                |
| `Retry-After` capped at 10 s, then retried                                                                                                                                                                                                                                                                                                                     | Honoured up to 30 s; a longer one gives up at once (`maxRetryAfterMs`)                                                                                               |
| 413 retried                                                                                                                                                                                                                                                                                                                                                    | Not retried                                                                                                                                                          |
| A network error from Node fetch (code on `cause`) failed at once                                                                                                                                                                                                                                                                                               | Retried, waiting at least 1 s after a refused connection: a stopped node (LocalNet down) fails after about 15 s; `retry: { maxTries: 1 }` or `false` to fail at once |
| Retry log: `algosdk request failed N times. Retrying in Xms: …`                                                                                                                                                                                                                                                                                                | `<formatRetryWait>: <METHOD> <path> failed: …`, plus an `EventType.RetryWait` event                                                                                  |
| With stock algosdk, the fork's retry handling (`Retry-After`, busy and history 503s, time-limited 504s)                                                                                                                                                                                                                                                        | Upstream algokit-utils' loop, stopping on an abort                                                                                                                   |
| `types/dt-support`: `SimulateRoundsWindowLike`; `roundIndex` and `kind: 'round'` of `RawSimulateGroupOutcome`; `roundResults`, `protocolOverride`, nested `groupResults()` and `groupResult()`'s `roundIndex` of `DTSimulateResponseLike`; `parallelGroups`, `rounds`, `skipValidityWindow`, `rewriteValidityWindow` and `protocol` of `DTSimulateRequestLike` | Removed; `groupResults()` is flat, and `QueryLimits` has the required `maxTotalCalls` and `maxCallStateBytes` (for mocks)                                            |
| `REQUIRED_DT_FEATURES` (exported from `types/dt-support`) listed `parallel-groups`, `simulate-rounds`, `pack-rounds`, `validity-window` and `simulate-protocol`                                                                                                                                                                                                | Those five dropped (dt5 dt-algosdk has none of them) and `query-total-calls` added: a dt-algosdk counts as dt-algosdk only with all of them                          |

The options that were removed throw at runtime too, naming what replaced them, for callers that don't type-check.

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

Also `getAssetVersions`, `getAccountVersions` (with `exclude`), `getAccountAssetVersions` and `getAccountAppVersions`. Options: `minRound`, `maxRound`, `order` (`'asc'` or `'desc'`), `limit`, `includeValues`, `signal`, and for a page `next` (the previous page's `nextToken`). An iterator passes `signal` to every page request, and stops at an abort, even within a page, throwing the signal's reason. `algorand.dt.supported()` tells whether the node has time travel.

Pages can be short, or empty, and still have a `nextToken`: only a missing `nextToken` means the end. Pass tokens back to the same node.

### As of rounds

`rounds` lists an object as of each of the given rounds instead of its versions in a range: one entry per distinct round, for the state at the end of that round, with `changedRound`, the round of the change in effect then. It samples history (a balance at each month end, a chart of global state) without one read per round.

```typescript
for await (const v of algorand.dt.iterateAssetVersions(assetId, { rounds: [1000n, 60_000_000n], includeValues: true })) {
  console.log(v.round, v.deleted ? 'did not exist' : `as of ${v.changedRound}`, v.asset?.total)
}
```

- Entries come in `order` (ascending by default), not in the order given, and a round listed twice comes once: match them by `round`.
- `deleted: true` without `changedRound` means the object did not exist at that round. On the account endpoints, the objects that did not exist then are left out.
- **Round 0 is the genesis round here.** Elsewhere 0 means the latest round: in the `round` option of `algorand.simulate.groups` and `algorand.query.groups`, and in the `rounds` of `algorand.query.run`. `algorand.simulate.rounds` and `algorand.query.rounds` take only past rounds and throw a `RangeError` on 0.
- Not with `minRound` / `maxRound` (an `Error` before sending). `limit` counts rounds.
- A page (`get…Versions`) sends the rounds as given in one request, at most 10,000. The iterators sort and dedupe them and send them in requests of `min(limit, maxRoundsPerRequest)` rounds (`limit` defaults to 100, `maxRoundsPerRequest` to 500, about 4.5 KB of URL), each paged to its end before the next: a request carries only the rounds its page can return, and stays under proxies' URL limits. An empty list yields nothing and sends nothing.
- `changedRound` is on every version type: `BoxVersion`, `BoxChange` (each box of the boxes feed lists every box of the app at that round), `AppVersion`, `AssetVersion`, `AccountVersion.base` and each item of the account lists.
- On builds before go-algorand `1cdd99803`, an empty box value reads as `value: undefined` in rounds mode.

### Changed keys

`includeKeys` on `get/iterateAppVersions`, `get/iterateAccountVersions` and `get/iterateAccountAppVersions` adds `changedKeys`: the global or local state keys added, removed or given a new value in that round (net over the round), sorted, as bytes. It is on `AppVersion`, `AccountVersion.appsLocalState[]` and `.createdApps[]`. `[]` means only other params changed (a program update); `undefined` means a deletion, `exclude: ['created-apps-params']`, or not asked for. `limit` is at most 1,000 with `includeValues` or `includeKeys`.

```typescript
const { versions } = await algorand.dt.getAppVersions(appId, { order: 'desc', limit: 10, includeKeys: true })
versions.map((v) => v.changedKeys?.map((k) => Buffer.from(k).toString()))
```

### Key and prefix filters

`key` on `get/iterateAppVersions` (a global state key) and `get/iterateAccountAppVersions` (a local state key) lists only the versions at which that key changed, each with `keyValue`, the key's decoded value after it (as in `AppState`; undefined when it was removed). `prefix` on `get/iterateBoxesVersions` lists only the changes of the boxes whose names start with it, such as one ARC-56 box map. Strings are UTF-8; both are at most 64 bytes.

```typescript
for await (const v of algorand.dt.iterateAppVersions(poolAppId, { key: 'algodVer', minRound, maxRound })) {
  console.log(v.round, v.keyValue?.value)
}
for await (const { round, boxes } of algorand.dt.iterateBoxesVersions(registryAppId, { prefix: 'sps' })) {
  // only the sps… boxes
}
```

- An empty `key` is a valid key. An empty `prefix` means no filter (ARC-56 maps with `prefix: ""`): nothing is sent or filtered.
- `key` can't go with `rounds` (an `Error` before sending); `prefix` can. With `rounds`, every round has an entry, possibly with no boxes.
- With `key` on the account endpoint, entries hold only the local state, never the created app's params.
- Pages can be short or empty and still have a `nextToken`: the node examines a bounded number of versions (key) or box index entries (prefix) per page. Keep paging until `nextToken` is absent; the iterators do.

`key` and `prefix` go to the node as its `key` / `prefix` parameters, like any other versions parameter: there is no probe and no client-side emulation.

Recommended follow-up: ARC-56 state history helpers on `AppClient.state.*` (a global or local key's versions, a box map's changes, decoded with the app spec), built on these `key` / `prefix` listings.

## Box listings

`algorand.app.getBoxes(appId, { prefix, includeValues, limit, round, signal })` (and `appClient.getBoxes(options)`, which follows the client's pinned round) lists an app's boxes from the node's paged box listing (`GET /v2/applications/{id}/boxes?prefix=&include=values`): only the boxes under `prefix` (a string is UTF-8; empty means every box), with their values in the same request, one request per page (up to the node's `MaxAPIBoxPerApplication`, or about 1 MB of values).

- With `round`, every page is read at that round (dtalgod), one consistent snapshot. Without it, later pages follow `next` at the latest round, as stock clients do, so a long listing can straddle rounds: pass `round` for a snapshot on dtalgod.
- On algosdk before 3.6 (no paged builder) or a node that ignores the paging parameters (its answer has no `round`), the names are filtered here and the values read 8 at a time.

`appClient.state.box.getMap(mapName)` now uses it: one listing of the map's prefix with values instead of a listing of every box and one read per box. The result holds the same entries, now in box name order (the paged listing's order) rather than the unpaged listing's. Like upstream, it decodes every box under the map's prefix, including boxes of another map whose prefix starts with it, or with an empty prefix every box; a map with a prefix of its own avoids that.

Recommended, not done: `getBoxValues` / `getBoxValuesFromABIType` still read all their boxes at once (unbounded `Promise.all`), and `getBoxNames` at the latest round still uses the unpaged listing, which fails beyond `MaxAPIBoxPerApplication`; `getBoxes` covers both when the names share a prefix.

## Asset holders

`algorand.dt.getAssetHolders(assetId, options)` returns a page of the accounts that hold an asset at a round (the latest by default, or `round`), in address order, each with `address`, `amount` and `frozen`; accounts opted in with a zero balance are listed. `iterateAssetHolders(assetId, options)` follows the pages, all at the first page's round.

```typescript
let held = 0n
for await (const h of algorand.dt.iterateAssetHolders(assetId, { round: 50_000_000n })) held += h.amount

const first = await algorand.dt.getAssetHolders(assetId, { limit: 100 })
const next = await algorand.dt.getAssetHolders(assetId, { round: first.round, next: first.nextToken, limit: 100 })
```

- `limit`: default 1,000, at most 10,000. Pages can be short or empty and still have a `nextToken`.
- A page with `next` must pass the first page's `round` too (an `Error` otherwise), so every page lists the same round.
- `signal` aborts, as for the versions iterators.
- Needs dtalgod with time travel and the holders index (`TimeTravelHoldersIndex`). Stock algod and a dtalgod with time travel off throw `DTUnsupportedError` before sending; a dtalgod without the index rejects the request, also thrown as `DTUnsupportedError`. An asset that doesn't exist at the round is the node's 404; an index still being built is a 503 thrown at once.
- There is no indexer fallback: an indexer can't list balances at a past round.

## Extended simulate

`algorand.simulate` simulates without signatures, for reads and dry runs:

```typescript
// Several groups in one request, one after the other in one block; or each on its own, in a request of its own, with `parallel`
const [funded, spent] = await algorand.simulate.groups([fundComposer, spendComposer], { allowUnnamedResources: true })

// The same groups at many rounds: a request per round, with the transactions built valid at it
const composer = algorand.newGroup().addAppCallMethodCall(await appClient.params.call({ method: 'get_price' }))
for (const {
  round,
  groups: [g],
} of await algorand.simulate.rounds(composer, rounds, { allowUnnamedResources: true })) {
  if (g.ok) console.log(round, g.result.returns?.[0]?.returnValue)
  else console.log(round, g.error.kind, g.error.message)
}
```

Each outcome is `{ ok: true, result }`, with the same result shape as `composer.simulate()`, or `{ ok: false, error }` (`kind` `group`, `not-simulated` or `missing`). A round the node can't simulate throws. For read-only app calls, [queries](#queries) are faster: many calls at many rounds per request, and under a later protocol if asked.

### Node limits

`simulate.groups` and `simulate.rounds` keep to the node's simulate limits, which dtalgod reports in the `simulate` part of its capabilities (`GET /v2/capabilities`) and `algorand.simulate.limits()` returns (`maxTxnGroups`, `maxExtraOpcodeBudget`). They are asked for once per algod client. Requests hold at most `maxTxnGroups` groups, and an `extraOpcodeBudget` above `maxExtraOpcodeBudget` throws, as does `execTraceConfig` when the node reports the developer API off. Readonly `AppClient` calls use the node's full `maxExtraOpcodeBudget` (stock algod's 320,000 on stock algod).

Stock algod has no capabilities endpoint: `algorand.client.capabilities()` then returns stock algod's values with `reported: false` (and `algorand.simulate.limits()` stock algod's limits), and `simulate.groups` and `simulate.rounds` throw a `DTUnsupportedError` before sending anything. `maxGroups` can lower the node's limit for sequential groups; above it, the node rejects the request.

`simulate.groups` and `simulate.rounds` send at most `concurrency` requests at once (default 4), across the rounds of `rounds` and the requests of parallel groups; after a request fails, the ones not yet sent aren't. Parallel groups at the latest round, in several requests, all run at the round looked up first. `algorand.query.groups` / `rounds` pass their `concurrency` to the simulate fallback too.

Recommended, not done: a simulate request that runs over the node's time limit (504) is thrown (`AlgoHttpClientWithRetry` doesn't retry it).

## Queries

dtalgod's `POST /v2/query` runs read-only TEAL calls: one program (each call creates an app running it) or one deployed app (each call is a NoOp call of it), many calls with their own args and references, at many rounds. Each call is an app call alone in its group, in the block after the round, on the state that round left: no signatures, fees or minimum balances, every resource available without references (they only matter to programs before v9), and its writes dropped. A failed call doesn't affect the others. Only the called app's logs and the cost come back; inner transactions run but aren't echoed. `algorand.query` (`QueryManager`) wraps it.

### Raw queries: `run`

```typescript
const program = (await algorand.app.compileTeal('#pragma version 10\nglobal Round\nitob\nlog\ntxn ApplicationArgs 0\nlog\nint 1'))
  .compiledBase64ToBytes
const results = await algorand.query.run({
  program,
  rounds: [0, 50_000_000n], // 0 = the latest round
  protocol: 'round', // the chain's own rules; the node's default is 'latest'
  calls: [{ args: [new TextEncoder().encode('hi')] }, {}],
})
for (const { round, calls } of results) {
  for (const c of calls) console.log(round, c.callIndex, c.ok ? c.logs : `${c.error.kind}: ${c.error.failureMessage}`)
}
// 66351672n 0 [ <round + 1>, 'hi' ]
// 66351672n 1 call: logic eval error: invalid ApplicationArgs index 0. Details: ...
// 50000000n 0 [ <round + 1>, 'hi' ]
// ...

// A deployed app, at the latest round
const [{ calls }] = await algorand.query.run({ appId: 760937186n, calls: [{ args: [selector] }] })
```

`run` returns one result per entry of `rounds` (the latest round resolved to its number), each with one outcome per call: `{ ok: true, logs, cost }` or `{ ok: false, error }`, where `error` is a `QueryCallError` with `kind: 'round'` (the whole round failed) or `'call'`, the node's `failureMessage`, and the call's partial `logs` and `cost`. `sender` (default: the fee sink), `budget` (per call, inner calls included; default and at most `maxCallBudget`), the created app's `clearProgram`, `globalSchema` and `localSchema`, and `protocol` (the protocol of the block after each round, as if an upgrade to it took effect right after the round: `v24` to `v43`, `latest`, the default, `round` for the chain's own, `future` on a node with the developer API, or a version string; with anything but `round` each result has a `protocolOverride`, whose note hits give the call index as `group`) are sent as given. `run` has no simulate fallback: it throws a `DTUnsupportedError` on a node without queries.

### Composed app calls: `groups` and `rounds`

`algorand.query.groups(composers, options)` and `algorand.query.rounds(composers, rounds, options)` take the same composers and options as `algorand.simulate.groups`/`rounds`, plus `protocol` and (for `rounds`) `maxRounds` per query request, and return the same kind of outcomes, so a caller can swap one for the other. Each built app call becomes a query call: calls to the same program (with the same clear program and schemas) or app from the same sender share requests, others get their own.

```typescript
const composer = algorand.newGroup().addAppCreateMethodCall({ sender, method, args, approvalProgram, clearStateProgram, schema })
for (const {
  round,
  groups: [g],
} of await algorand.query.rounds(composer, [45_000_000n, 46_000_000n])) {
  if (g.ok) console.log(round, g.via, g.returns[0]?.returnValue, g.txns[0].logs)
  else console.log(round, g.error.kind, g.error.message)
}
```

Each outcome is `{ ok: true, txns, returns }` (each transaction's `logs` and `cost`, and the method calls' ABI returns as in `composer.send()`) or `{ ok: false, error }` with a `QueryGroupError` (`kind`, `failureMessage`, `failedAt`, `txns`), plus `via: 'query' | 'simulate'`. A failed call's logic error is worded as simulate's (`transaction <TXID>: logic eval error: ...`, with the transaction built as `simulate.groups` builds it; `query.rounds` builds each group once, at the latest round, so its transaction IDs differ from those of the per-round simulate fallback), so `LogicError` and other parsers of simulate's messages keep working. On the query path `cost` is the query's cost; on the simulate path it is simulate's `appBudgetConsumed`.

**The contract**: with query, every app call runs alone, against the round's state: the calls of one group don't see each other (no shared budget pool, `global GroupSize` 1, no `gtxn`), and the composers' fees, validity, notes and leases are ignored. With the simulate fallback, the groups run as composed, each on its own (`parallel: true`, a request per group). So use these for independent read-only calls, such as ghost calls.

`via` picks the path: `auto` (the default) queries when it can and simulates otherwise; `query` throws when it can't (a `DTUnsupportedError` for a node with queries disabled, an `Error` naming the reason otherwise); `simulate` always simulates. Both paths need dt-algosdk and dtalgod: without them they throw a `DTNotAvailableError` or a `DTUnsupportedError` before sending anything. Query is used when the node reports query limits, `execTraceConfig` is off, `allowMoreLogging` is off or the node's `maxCallLogBytes` is at least simulate's 65,536, an `extraOpcodeBudget` plus 700 per transaction fits the node's `maxCallBudget` for every group, and every transaction is a NoOp app call that creates an app (with an approval program) or calls one (without programs), without an access list or `rejectVersion`, and no method call has transaction arguments. The options are checked the same way on both paths. A node with queries disabled met mid-way (a load balancer mixing nodes with different settings) falls back to simulate with `auto`.

|                                  | Query path                                                                                                     | Simulate path                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Protocol                         | `round` by default; another one with `protocol`                                                                | The round's own only: with another `protocol`, groups that can't be queried and `via: 'simulate'` throw |
| Budget                           | The node's `maxCallBudget` per call (not used if an `extraOpcodeBudget` + 700·n exceeds it)                    | 700·n + `extraOpcodeBudget` per group                                                                   |
| Logs                             | The called app's only, up to `maxCallLogBytes`                                                                 | The top-level app's only, within `allowMoreLogging`'s limits                                            |
| Fees, minimum balances, validity | Not checked / ignored                                                                                          | Checked as composed (signatures skipped)                                                                |
| Unnamed resources                | Always allowed                                                                                                 | With `allowUnnamedResources`                                                                            |
| Calls of one group               | Each alone                                                                                                     | Together, in order                                                                                      |
| Error text                       | `transaction <TXID>: logic eval error: ...` for logic errors (the prefix added by utils, with the ID as built) | The node's `failureMessage`                                                                             |
| Inner transactions               | Run, not echoed                                                                                                | Run, in `confirmations` but not in `txns`                                                               |
| A round the request can't run at | `kind: 'round'` outcomes                                                                                       | Throws                                                                                                  |

### Limits, splitting and retries

`algorand.query.limits()` returns the node's query limits (`maxCalls`, `maxRounds`, `maxTotalCalls`, `maxCallBudget`, `maxCallLogBytes`, `maxCallStateBytes`, `maxResponseBytes`), or `undefined` on a node without queries (stock algod, or dtalgod with queries disabled); `algorand.query.supported()` says whether queries can be used. They come with the node's capabilities, asked for once per algod client (`algorand.client.capabilities().query`).

Requests hold at most `maxCalls` calls, `maxRounds` rounds and `maxTotalCalls` calls times rounds (lower them with the `maxCalls` / `maxRounds` options of `run`, or `maxRounds` of `rounds`), and are split so their body stays under the node's 1,000,000 bytes. Within those limits, the rounds are split into the chunks that need the fewest requests in all, each request taking as many calls as fit at its rounds; of those splits, the one with the fewest chunks, spread evenly when that needs no more requests. They are sent `concurrency` at a time (default 4). Duplicate rounds are queried once. When the latest round (0) is queried in more than one request, it is looked up first so every call sees the same block. A request whose results are over `maxResponseBytes`, or that runs over the node's time limit (504), is split in halves (rounds first, then calls) and sent again; a call that is still too large or too slow alone fails on its own (`kind: 'call'` with `run`, `kind: 'group'` with `groups`/`rounds`). Any other error cancels the requests in flight (and the node's work on them) and is thrown; a round after the latest one fails the whole request.

A busy node (503) or a rate limit (429) is retried by the HTTP client, not by `QueryManager` (see [Retries](#retries)); a 504 from `POST /v2/query` is not retried, since `QueryManager` splits the request instead.

## Retries

The algod and indexer clients that algokit-utils makes (`AlgorandClient.fromConfig` / `fromEnvironment` / `mainNet()` etc., `ClientManager.getAlgodClient` / `getIndexerClient`) are `AlgoHttpClientWithRetry`s. With dt-algosdk (its `retry-policy` feature), they retry by dt-algosdk's retry policy (dt-algosdk's DTALGOSDK.md, "Retries"):

- Up to 5 tries, the first included.
- Retried: 408, 429, 500, 502, 503 and 504, and network errors (also those whose code is on Node fetch's `cause`, and a browser's failed fetch). A 413 is not retried.
- Not retried: a 503 for history the node can't serve (an incomplete box or holders index, or a time-travel history that isn't served), and a 504 from a request under the node's time limit (`POST /v2/query`, `POST /v2/transactions/simulate`, `GET /v2/deltas/{round}`, and `GET` of a `/v2/…/versions` or `/v2/…/holders` listing, not algod's own `GET /versions`), where a retry would repeat the whole work: split the request or narrow the range instead. Other requests still retry a 504.
- A transaction submit (`POST /v2/transactions` and `/async`) is retried only when the node surely didn't take it: a 429, a busy 503, or a connection refused or never made. After a lost answer, check for the transaction instead.
- The wait is the longest of the backoff (0, then 2, 4, 8 s, at most 10 s), the `Retry-After` of a 429 or 503 (giving up at once when it is above 30 s), and 1 s for a 429 or busy 503 without one, a refused connection, or a browser's failed fetch.

Change it with the `RetryPolicyLike` fields to change (`maxTries`, `maxBackoffMs`, `maxRetryAfterMs`, `busyMinDelayMs`, `backoffMs`, `retryStatuses`, `networkCodes`, `decide`, `onWait`, `sleep`), or `false` for no retries:

```typescript
// Every client, read on every request, so it applies to clients made before it
Config.configure({ retry: { maxTries: 3 } })

// One client: its fields win over Config's, field by field
const algorand = AlgorandClient.fromConfig({
  algodConfig: { server: 'https://mainnet-api-dt.d13.co', retry: { maxRetryAfterMs: 60_000 } },
  indexerConfig: { server: 'https://mainnet-idx.algonode.cloud', retry: false },
})
```

`false` counts as `{ maxTries: 1 }` in the merge: `retry: false` on a client turns its retries off whatever `Config.retry` says, and with `Config.retry` `false` a client retries only if its own `retry` sets `maxTries`. Kmd clients don't retry.

Each wait before a retry (a `RetryWaitLike`: `reason`, `delayMs`, `until`, `retryAfterMs`, `retry`, `maxRetries`, `method`, `path`, `status`, `error`):

- is logged with `Config.logger.warn`;
- is emitted as `EventType.RetryWait` (`'retry-wait'`) on `Config.events`, without waiting for the listeners: `Config.events.on(EventType.RetryWait, (wait) => setStatus(formatRetryWait(wait)))`, with `formatRetryWait` from dt-algosdk (`import { formatRetryWait } from 'algosdk'`);
- is passed to the policy's `onWait` (the client's, or else `Config.retry`'s);
- is in the `AlgoHttpClientWithRetry`'s `waits` while it lasts, if it waits at all (`delayMs` above 0; `waiting` is the one that waits longest): to poll them, make the client yourself (`new AlgoHttpClientWithRetry(tokenHeader, server, port, undefined, retry)`) and pass `{ algod: new algosdk.Algodv2(client, server) }` to `AlgorandClient.fromClients` (`Algodv2` still takes a server, as `ClientManager.getAlgodClient` passes it).

What `onWait` throws is ignored, and so is what a `RetryWait` listener throws, as far as the request goes; as with every `Config.events` event, the listeners run in turn, so one that throws keeps the later ones from running. The clients carry dt-algosdk's `RETRYING_CLIENT` mark, so its `withRetry` returns them as they are rather than retrying twice over.

With stock algosdk, or a dt-algosdk without `retry-policy`, the clients retry as upstream algokit-utils does (up to 5 tries, at once and then after 2, 4 and 8 s, on the statuses above and 413, ignoring `Retry-After`), and stop when the request's `signal` aborts; the `retry` options have no effect and no `RetryWait` event is emitted. An `Algodv2` or `Indexer` passed to `AlgorandClient.fromClients` retries only if its HTTP client does (for example one made with dt-algosdk's `withRetry`): a plain one doesn't retry.

## Aborting requests

`algorand.app` reads, `algorand.account.getInformation`, `algorand.asset.getById` / `getAccountInformation`, app client state and box reads, `algorand.dt` version pages and iterators, `algorand.simulate.groups`/`rounds` and `algorand.query.run`/`groups`/`rounds` take an optional `signal` (an `AbortSignal`), passed to fetch. An aborted request is never retried, and a retry backoff in progress ends as soon as the signal aborts. `composer.simulate({ signal })` checks the signal before and after the request (algosdk's composer can't pass it to fetch). Aborting a query cancels all its requests in flight, and the node stops working on them. The node's capabilities, which say whether it has time travel and queries, are cached per client and shared, so they are read without the signal.

```typescript
const controller = new AbortController()
setTimeout(() => controller.abort(), 5_000)
await algorand.app.getGlobalState(appId, { round: 45_000_000n, signal: controller.signal })
```

## Errors

| Error                                          | Meaning                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DTNotAvailableError`                          | The loaded algosdk isn't dt-algosdk (it lacks a `DTAlgodClient.features` entry algokit-utils uses)                                                  |
| `isDTUnsupportedError(e)`                      | The node doesn't support the request: stock algod, a dtalgod with the feature off, or a round it can't serve                                        |
| `QueryCallError`                               | A call of `algorand.query.run` at a round failed (`kind: 'call'`) or its round did (`kind: 'round'`); in the outcome, not thrown                    |
| `QueryGroupError`                              | A group of `algorand.query.groups`/`rounds` failed, on either path (`kind` as simulate's, or `round` on the query path); in the outcome, not thrown |
| `DTUnsupportedError` from `algorand.query.run` | The node has no queries (stock algod, or dtalgod with queries disabled)                                                                             |

`DTNotAvailableError`, `isDTUnsupportedError`, `QueryCallError` and `QueryGroupError` are exported from `@algorandfoundation/algokit-utils`. `DTUnsupportedError` itself comes from dt-algosdk: `import { DTUnsupportedError } from 'algosdk'` (with the alias in place), or test with `isDTUnsupportedError(e)`, which also works when stock algosdk is loaded.

## Tests

`src/types/dt.spec.ts` runs offline against a stub algod. `src/types/dt.live.spec.ts` runs against a MainNet dtalgod:

```sh
DT_ALGOD_SERVER=https://mainnet-api-dt.d13.co npx vitest run --dir src src/types/dt.live.spec.ts
```

The node must run the current dt-algorand release (dt5) with time travel on. The query tests branch on whether the node has queries, and the holders test is skipped on a node without the holders index, since both are optional: run them against a dtalgod with queries and one without to cover both the query path and the simulate fallback.

The repo's own build and tests use the algosdk fork as a dev dependency, `"algosdk": "npm:dt-algosdk@<version>"`, pinned to an exact version; while that version isn't on npm yet, its tarball is vendored instead (`"algosdk": "file:./vendor/dt-algosdk-<version>.tgz"`), which a release refuses.

## Building and publishing

`npm run build` builds into `dist/`, with its own `package.json` and README, and the package is published from there (`npm publish ./dist`), never from the repo root (the root `prepublishOnly` refuses). The build rewrites the README's relative links to `https://github.com/d13co/dt-algokit-utils-ts/blob/dtalgorand/`, the fork's default branch; the fork's `main` tracks upstream.

### CI and CD

GitHub Actions tests and publishes the package with one workflow, [`.github/workflows/dt-algokit-utils.yml`](../.github/workflows/dt-algokit-utils.yml), modelled on dt-algosdk's. On every push and pull request to `dtalgorand` it runs the type check, lint, an audit of the production dependencies (the full audit only warns), the build and the tests against LocalNet, on Node 22 (the oldest in `engines`) and 24, and `node scripts/ci/dt-release.mjs check`. On a `v<version>` tag it also checks the release, packs the tested `dist/`, publishes that tarball to npm with provenance, and creates a GitHub release with the tarball. The upstream workflows (semantic-release, docs publishing) are removed: they need the Algorand Foundation's bot and secrets.

### Releasing

1. Choose the version (see below) and set it with `npm version <version> --no-git-tag-version`, which updates `package.json` and `package-lock.json`.
2. Set the dt-algosdk the repo builds and tests against, pinned exactly: `npm install -D -E --min-release-age=0 algosdk@npm:dt-algosdk@<version>` (publish that `dt-algosdk` first if it's new, and replace a vendored `file:` tarball with it: `check v<version>` refuses one; `--min-release-age=0` overrides the repo's `.npmrc`, which makes npm 11 refuse versions less than 7 days old). Set the `algosdk` peer range in `package.json` to `^3.5.2 || ^<dt-algosdk version>` with the oldest dt-algosdk this release works with (a prerelease only matches a range naming the same `x.y.z`), and add the new `DTAlgodClient.features` it requires to `REQUIRED_DT_FEATURES` (not the optional ones, such as `retry-policy`, which are checked on their own: a dt-algosdk without them must still count as dt-algosdk).
3. `node scripts/ci/dt-release.mjs update` sets both versions in the install snippets of `README.md`: `@d13co/dt-algokit-utils@<version>` and `dt-algosdk@<the devDependency's version>`.
4. `npm run build`, `npm test`, then `npm pack ./dist --dry-run` to check the contents.
5. Commit and push `dtalgorand`, then tag the commit and push the tag to the fork, `github.com/d13co/dt-algokit-utils-ts` (not upstream): `git tag v<version> && git push <fork remote> v<version>`.
6. The workflow checks that the tag is on `dtalgorand` and matches the version in `package.json` and `package-lock.json`, that the docs name that version and the dt-algosdk devDependency, and that the peer range accepts that dt-algosdk (`node scripts/ci/dt-release.mjs check v<version>` runs the same check locally). It then runs the tests and, once the `npm` environment's reviewer approves, publishes with `npm publish --tag latest`: npm 11 publishes a prerelease only with an explicit tag, and `latest` makes it the version `npm install @d13co/dt-algokit-utils` gets. If the version is already on npm, the workflow does not publish it again and only creates the GitHub release, with npm's tarball.

#### One-time setup

- **Default branch.** `dtalgorand` (Settings → General), so the repository page shows this branch's README. The fork's `main` tracks upstream.
- **GitHub environment.** The publish job runs in the environment `npm`, which requires a reviewer (`d13co`) to approve each release and lets only `v*-dt.*` tags deploy to it (Settings → Environments). The trusted publisher names it.
- **First version, by hand.** The workflow publishes only through npm trusted publishing, which is set up on a package that already exists. Publish the first version from a checkout: steps 1 to 4, then `npm publish ./dist --tag latest`, then push the tag (step 5). The workflow sees that the version is on npm, skips publishing, and creates the GitHub release.
- **Trusted publisher.** Right after the first publish, add one for the workflow, either in the package's settings on npmjs.com (Trusted publishing → GitHub Actions: owner `d13co`, repository `dt-algokit-utils-ts`, workflow `dt-algokit-utils.yml`, environment `npm`, publishing allowed) or with npm 11.5.1 or later: `npm trust github @d13co/dt-algokit-utils --file dt-algokit-utils.yml --repo d13co/dt-algokit-utils-ts --env npm --allow-publish`. Publishing is not allowed unless it is turned on. Trusted publishing adds provenance to each version and needs no token: the repository has no `NPM_TOKEN` secret.

Versions follow the same scheme as `dt-algosdk`: `<upstream base>-dt.<dt-algorand N>.<x>.<y>.<z>`, e.g. `9.2.3-dt.5.2.0.0`, built on algokit-utils 9.2.3, covering dt-algorand dt5, and this package's release 2.0.0.

- `9.2.3`: the upstream algokit-utils version the code is built on (`v9.2.3-beta.2`). Bump it when merging a new upstream release.
- `dt.5`: the dt-algorand release whose API this covers (tag `v5.0.5-dt5`). Older dt-algorand releases are not supported; only the features that are optional on that release are detected at runtime (see [Compatibility](#compatibility)). Keep it a separate identifier (`dt.5`, not `dt5`) so npm compares the number numerically.
- `2.0.0`: this package's own release, `x.y.z`: bump `x` for a breaking change to the fork's API, `y` for features and `z` for fixes. It never starts again: when the upstream base or the dt number changes, it keeps counting from the last release (bumped as the change calls for), as `dt-algosdk`'s does.

These are prereleases, so `^` ranges don't match them; consumers pin exact versions in their overrides. `publishConfig.tag` is `latest`, so each publish becomes the default install.
