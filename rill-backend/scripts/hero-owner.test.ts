import { expect, test } from 'bun:test';
import { buildMintTradeCapTransaction, buildSetupTransaction } from '../src/features/setup/setup.service';
import { buildRevokeTransaction } from './hero-owner';

const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const targets = (tx: ReturnType<typeof buildSetupTransaction>) => tx.getData().commands.flatMap((command) =>
  command.$kind === 'MoveCall' ? [`${command.MoveCall.module}::${command.MoveCall.function}`] : [],
);

test('owner setup creates funded wallet and shared BalanceManager', () => {
  expect(targets(buildSetupTransaction({ walletPackageId: id(1), deepbookPackageId: id(2), agent: id(3), budgetMist: 100n, perTxMist: 10n, expiresAtMs: 999n })))
    .toEqual(['agent_wallet::create_wallet', 'balance_manager::new', 'transfer::public_share_object']);
});

test('owner capability and revoke transactions cover TradeCap and AgentWallet', () => {
  expect(targets(buildMintTradeCapTransaction(id(2), id(4), id(3))))
    .toEqual(['balance_manager::mint_trade_cap']);
  expect(targets(buildRevokeTransaction({ walletPackageId: id(1), deepbookPackageId: id(2), walletId: id(5), balanceManagerId: id(4), tradeCapId: id(6), owner: id(7) })))
    .toEqual(['agent_wallet::revoke', 'balance_manager::revoke_trade_cap']);
});
