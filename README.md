# AlgoKit TypeScript Utilities

A set of core Algorand utilities written in TypeScript and released via npm that make it easier to build solutions on Algorand. This project is part of [AlgoKit](https://github.com/algorandfoundation/algokit-cli).

The goal of this library is to provide intuitive, productive utility functions that make it easier, quicker and safer to build applications on Algorand. Largely these functions wrap the underlying Algorand SDK, but provide a higher level interface with sensible defaults and capabilities for common tasks.

Note: If you prefer Python there's an equivalent [Python utility library](https://github.com/algorandfoundation/algokit-utils-py).

[Install](#install) | [Documentation](./docs/README.md)

## dtalgod fork

This fork adds support for [dtalgod](https://github.com/d13co/dt-algorand), an algod with time travel (state at any past round, and the rounds at which objects changed) and extended simulate (several transaction groups and several rounds per request). It is additive: existing APIs, types and generated typed clients work unchanged, and it runs on stock algosdk, where the new features throw a `DTNotAvailableError`.

The new features need the time-travel fork of algosdk (`algosdk@3.8.0-dt.1`, with `DTAlgodClient`). algokit-utils and your code must load the same copy of algosdk, so replace `algosdk` everywhere with a package-manager override, e.g. with pnpm:

```yaml
overrides:
  algosdk: file:./vendor/algosdk-3.8.0-dt.1.tgz
```

`pnpm why algosdk` should then list only the fork.

### Reads at a past round

Pass `{ round }` to the usual reads to get the state as of the end of that round:

```typescript
const account = await algorand.account.getInformation(address, { round: 45_000_000n })
const holding = await algorand.asset.getAccountInformation(address, assetId, { round: 45_000_000n })
const globalState = await algorand.app.getGlobalState(appId, { round: 45_000_000n })
const box = await algorand.app.getBoxValue(appId, 'config', { round: 45_000_000n })
```

The same option is on `getById`, `getLocalState`, `getBoxNames`, `getBoxValues`, `getBoxValue(s)FromABIType` and the `AppClient` state methods. A node that can't serve the round throws (`isDTUnsupportedError(e)`) rather than returning the latest state.

An `AppClient` pinned to a round reads state and simulates readonly ABI calls at that round, and can't send transactions. Generated typed clients take an `AppClient`, so they can be pinned too:

```typescript
const past = appClient.atRound(45_000_000n)
await past.state.global.getAll()
await past.send.call({ method: 'get_price' })

const typedPast = new MyAppClient(myAppClient.appClient.atRound(45_000_000n))
await typedPast.state.global.counter()
```

`composer.simulate({ round })` now builds transactions that don't set their own validity so they are valid at that round.

### Versions: when objects changed

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

Also `getAssetVersions`, `getAccountVersions` (with `exclude`), `getAccountAssetVersions` and `getAccountAppVersions`. `algorand.dt.supported()` tells whether the node has time travel.

### Extended simulate

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

#### Node limits

`simulate.groups` and `simulate.rounds` keep to the node's simulate limits, which dtalgod reports (`GET /v2/transactions/simulate/limits`) and `algorand.simulate.limits()` returns. They are asked for once per algod client. Requests hold at most `maxTxnGroups` groups and `maxRounds` rounds, and an `extraOpcodeBudget` above `maxExtraOpcodeBudget` throws, as do `protocol: 'future'` and `execTraceConfig` when the node reports the developer API off (a node that doesn't report its limits checks these itself). Readonly `AppClient` calls use the node's full `maxExtraOpcodeBudget` (320,000 on a node that doesn't report it).

A node without the limits endpoint (stock algod, or a dtalgod built before it) gets stock algod's limits, with `reported: false`. Each request then holds one group (sequential groups beyond one throw; `parallel` groups get one request each), and `simulate.rounds` sends one request per round with `round` set instead of `rounds`. On an older dtalgod, pass `maxGroups` and `maxRounds` (its defaults are 16) to use its extended simulate.

#### Rounds far apart, under a later protocol

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

With `'rewrite'` the transaction IDs change, so the results' `txIds` are those as built; transactions that differ only by their validity window need distinct notes, or the later one fails as a duplicate. These options need a dtalgod with these features and `algosdk@3.8.0-dt.1` or later (the limits need a build of it with the `simulate-limits` feature; without it, the defaults of 16 groups and 16 rounds apply); an older fork throws a `DTNotAvailableError`, an older node a `DTUnsupportedError`.

### Tests

`src/types/dt.spec.ts` runs offline against a stub algod. `src/types/dt.live.spec.ts` runs against a MainNet dtalgod: `DT_ALGOD_SERVER=http://host:port npx vitest run src/types/dt.live.spec.ts`.

## Install

Before installing, you'll need to decide on the version you want to target. Version 7 and 8 have the same feature set, however v7 leverages algosdk@>=2.9.0<3.0, whereas v8 leverages algosdk@>=3.0.0. Your project and it's dependencies will help you decide which version to target.

Once you've decided on the target version, this library can be installed from NPM using your favourite npm client, e.g.:

To target algosdk@2 and use version 7 of AlgoKit Utils, run the below:

```
npm install algosdk@^2.9.0 @algorandfoundation/algokit-utils@^7.0.0
```

To target algosdk@3 and use the latest version of AlgoKit Utils, run the below:

```
npm install algosdk@^3.0.0 @algorandfoundation/algokit-utils
```

Now you can import the library:

```typescript
import { AlgorandClient, Config } from '@algorandfoundation/algokit-utils'
```

See [usage](./docs/README.md#usage) for more details.

## Migration

Whilst we aim to minimise breaking changes, there are situations where they are required.
JSDoc deprecations should guide you through most migration paths inside your IDE, however the migration guides will provide more detailed information should you need it.

If you're targeting v7, please refer to the [v7 migration guide](./docs/src/content/docs/migration/v7-migration.md).
If you're targeting v8, please refer to the [v8 migration guide](./docs/src/content/docs/migration/v8-migration.md).

## Guiding principles

This library follows the [Guiding Principles of AlgoKit](https://github.com/algorandfoundation/algokit-cli/blob/main/docs/algokit.md#guiding-principles).

## Contributing

This is an open source project managed by the Algorand Foundation. See the [AlgoKit contributing page](https://github.com/algorandfoundation/algokit-cli/blob/main/CONTRIBUTING.md) to learn about making improvements.

To successfully run the tests in this repository you need to be running LocalNet via [AlgoKit](https://github.com/algorandfoundation/algokit-cli) and also have package dependencies and `.env.template` copied to `.env` (both of which `algokit bootstrap all` can do for you):

```
algokit bootstrap all
algokit localnet start
```

To run tests you can use VS Code, or:

```
npm run test
```
