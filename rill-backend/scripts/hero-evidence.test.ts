import { expect, test } from 'bun:test';
import { extractHeroEvents } from './hero-evidence';

test('extracts matching Spent and OrderPlaced events', () => {
  const result = extractHeroEvents([
    { eventType: '0x1::agent_wallet::Spent', json: { wallet: '0xa', amount: '5', remaining: '95' } },
    { eventType: '0x2::order_info::OrderPlaced', json: { balance_manager_id: '0xb', client_order_id: '71601', order_id: '99' } },
  ], { walletId: '0xa', balanceManagerId: '0xb', clientOrderId: '71601' });
  expect(result.spent.json?.amount).toBe('5');
  expect(result.orderPlaced.json?.order_id).toBe('99');
});

test('fails when event identities do not reconcile', () => {
  expect(() => extractHeroEvents([], { walletId: '0xa', balanceManagerId: '0xb', clientOrderId: '71601' }))
    .toThrow('matching Spent and OrderPlaced');
});
