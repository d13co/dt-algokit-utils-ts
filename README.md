# dt-algokit-utils

> `@d13co/dt-algokit-utils` is a fork of [`@algorandfoundation/algokit-utils`](https://github.com/algorandfoundation/algokit-utils-ts) that adds support for [dtalgod](https://github.com/d13co/dt-algorand), an algod with time travel and extended simulate. The upstream README follows below.

It is a drop-in replacement: existing APIs, types and generated typed clients work unchanged, and on stock `algosdk` or a stock algod everything behaves as upstream while the new features throw.

## Main changes

- **Reads at a past round**: `{ round }` on account, asset, app, global/local state and box reads returns the state as of the end of that round.
- **App clients pinned to a round**: `appClient.atRound(round)` reads state and simulates readonly ABI calls at that round, for generated typed clients too.
- **Versions**: `algorand.dt` lists the rounds at which a box, an app's boxes, an app, an asset or an account changed, with the values if asked, by page or as an async iterator; as of a list of `rounds`, with the changed state keys, or only the changes of one state `key` or box name `prefix`.
- **Asset holders**: `algorand.dt.getAssetHolders` / `iterateAssetHolders` list an asset's holders at a round.
- **Box listings**: `algorand.app.getBoxes` lists boxes under a prefix with their values in one paged listing; `state.box.getMap` uses it.
- **Extended simulate**: `algorand.simulate.groups` simulates several groups in one request, and `algorand.simulate.rounds` simulates groups at many rounds, packed into as few requests as the node's limits allow, optionally with validity windows rewritten or skipped and under a later consensus protocol.
- **Node limits**: simulate follows the limits dtalgod reports, and readonly app calls get the node's full extra opcode budget.
- **Queries**: `algorand.query.run` runs read-only TEAL calls of a program or app at many rounds (`POST /v2/query`), split within the node's limits; `algorand.query.groups`/`rounds` query composed app calls, with simulate as the fallback.
- **Abort signals**: `signal` on app reads, version pages, simulate and queries cancels the request and its retries.

See **[the full list of differences](./docs/dt-fork.md)** for every changed method, examples and caveats.

## Installing the fork

The new features also need `dt-algosdk`, the matching fork of algosdk, and a node on the current dt-algorand release (dt4, `v5.0.5-dt4`); older dtalgod releases are not supported. Install both under their upstream names and override them across your whole dependency tree, so your code, generated typed clients and other libraries (e.g. algokit-subscriber) all load the same copy. Imports stay `@algorandfoundation/algokit-utils` and `algosdk`.

npm (`package.json`; each override must equal the dependency spec):

```json
{
  "dependencies": {
    "@algorandfoundation/algokit-utils": "npm:@d13co/dt-algokit-utils@9.2.3-dt.4.1.0.0",
    "algosdk": "npm:dt-algosdk@3.9.0-dt.4.1.0.0"
  },
  "overrides": {
    "@algorandfoundation/algokit-utils": "npm:@d13co/dt-algokit-utils@9.2.3-dt.4.1.0.0",
    "algosdk": "npm:dt-algosdk@3.9.0-dt.4.1.0.0"
  }
}
```

pnpm (`pnpm-workspace.yaml`, or `pnpm.overrides` in `package.json`), with the same `dependencies` as above:

```yaml
overrides:
  '@algorandfoundation/algokit-utils': npm:@d13co/dt-algokit-utils@9.2.3-dt.4.1.0.0
  algosdk: npm:dt-algosdk@3.9.0-dt.4.1.0.0
```

yarn: the same entries under `resolutions` in `package.json` (yarn ignores `overrides`). Yarn 4 refuses versions published less than a day ago (`npmMinimalAgeGate`); to install a new release right away, add `npmPreapprovedPackages: ["@d13co/dt-algokit-utils", "dt-algosdk"]` to `.yarnrc.yml`. bun: the same entries under `overrides`.

Fork versions are prereleases (`-dt.…`), which `^` ranges don't match, so pin the exact versions as above. With the overrides in place, other packages' `algosdk` and algokit-utils peer ranges are satisfied. Don't reach for `--legacy-peer-deps` or `--force` if npm reports a peer conflict: it means an override is missing, and those flags install a second, stock copy.

Then check that only the forks are installed: `npm ls algosdk @algorandfoundation/algokit-utils` or `pnpm why algosdk`.

---

# AlgoKit TypeScript Utilities

A set of core Algorand utilities written in TypeScript and released via npm that make it easier to build solutions on Algorand. This project is part of [AlgoKit](https://github.com/algorandfoundation/algokit-cli).

The goal of this library is to provide intuitive, productive utility functions that make it easier, quicker and safer to build applications on Algorand. Largely these functions wrap the underlying Algorand SDK, but provide a higher level interface with sensible defaults and capabilities for common tasks.

Note: If you prefer Python there's an equivalent [Python utility library](https://github.com/algorandfoundation/algokit-utils-py).

[Install](#install) | [Documentation](./docs/README.md)

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
