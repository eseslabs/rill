# @rill/sdk

Typed HTTP client for the Rill backend API.

## Install (monorepo)

```json
{ "dependencies": { "@rill/sdk": "workspace:*" } }
```

## Usage

```ts
import { RillClient } from '@rill/sdk';

const rill = new RillClient({ baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:3002/api' });

const envelope = await rill.callSkill('skill_deepbook', {
  sender: '0x...',
  agentWallet: {
    packageId: '0x...',
    walletId: '0x...',
    capId: '0x...',
  },
  params: {
    poolKey: 'SUI_DBUSDC',
    balanceManagerId: '0x...',
    tradeCapId: '0x...',
    price: 1,
    quantity: 0.005,
    isBid: false,
    payWithDeep: false,
    clientOrderId: '71601',
    depositSui: 0.006,
  },
});
```

`callSkill` invokes the remote `build_action` tool and returns an unsigned `ExecutionEnvelope`.
MCP tool rejections throw `RillApiError`; the SDK preserves the server's structured rejection code and message.

## Build

```sh
bun run build:sdk
```
