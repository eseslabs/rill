import { expect, test } from 'bun:test';
import {
  buildMintTradeCapTransaction,
  buildSetupTransaction,
  createdId,
} from './setup.service';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const targets = (tx: ReturnType<typeof buildSetupTransaction>) =>
  tx.getData().commands.flatMap((command) =>
    command.$kind === 'MoveCall'
      ? [`${command.MoveCall.module}::${command.MoveCall.function}`]
      : [],
  );

test('setup transaction creates funded wallet and shared BalanceManager', () => {
  expect(
    targets(
      buildSetupTransaction({
        walletPackageId: id(1),
        deepbookPackageId: id(2),
        agent: id(3),
        budgetMist: 100n,
        perTxMist: 10n,
        expiresAtMs: 999n,
      }),
    ),
  ).toEqual(['agent_wallet::create_wallet', 'balance_manager::new', 'transfer::public_share_object']);
});

test('trade-cap mint transaction covers the required target', () => {
  expect(targets(buildMintTradeCapTransaction(id(2), id(4), id(3)))).toEqual([
    'balance_manager::mint_trade_cap',
  ]);
});

test('createdId finds the matching created object', () => {
  const result = {
    effects: {
      changedObjects: [
        { objectId: id(1), idOperation: 'Created' },
        { objectId: id(2), idOperation: 'Created' },
      ],
    },
    objectTypes: {
      [id(1)]: '0x1::agent_wallet::AgentWallet',
      [id(2)]: '0x2::balance_manager::BalanceManager',
    },
  };
  expect(createdId(result, '::agent_wallet::AgentWallet')).toBe(id(1));
  expect(createdId(result, '::balance_manager::BalanceManager')).toBe(id(2));
});

test('createdId throws when no matching created object is found', () => {
  const result = {
    effects: { changedObjects: [{ objectId: id(1), idOperation: 'Created' }] },
    objectTypes: { [id(1)]: '0x1::other::Other' },
  };
  expect(() => createdId(result, '::agent_wallet::AgentWallet')).toThrow(
    'Created ::agent_wallet::AgentWallet object not found.',
  );
});
