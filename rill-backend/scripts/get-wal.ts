/**
 * Exchange testnet SUI for WAL via official Walrus exchange (1:1).
 * Usage: bun run scripts/get-wal.ts [amountMist]
 */
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import dotenv from 'dotenv';

dotenv.config();

const WAL_EXCHANGE_PACKAGE =
  '0x82593828ed3fcb8c6a235eac9abd0adbe9c5f9bbffa9b1e7a45cdd884481ef9f';
const EXCHANGE_OBJECTS = [
  '0xf4d164ea2def5fe07dc573992a029e010dba09b1a8dcbc44c5c2e79567f39073',
  '0x19825121c52080bb1073662231cfea5c0e4d905fd13e95f21e9a018f2ef41862',
  '0x83b454e524c71f30803f4d6c302a86fb6a39e96cdfb873c2d1e93bc1c26a3bc5',
  '0x8d63209cf8589ce7aef8f262437163c67577ed09f3e636a9d8e0813843fb8bf1',
];

const amountMist = BigInt(process.argv[2] || '1000000000');

function loadKeypair() {
  const key = process.env.EXECUTOR_PRIVATE_KEY;
  if (!key) throw new Error('EXECUTOR_PRIVATE_KEY not set');
  if (key.startsWith('suiprivkey')) {
    const { secretKey } = decodeSuiPrivateKey(key);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  return Ed25519Keypair.fromSecretKey(key);
}

async function main() {
  const network = (process.env.SUI_NETWORK || 'testnet') as 'mainnet' | 'testnet';
  const client = new SuiJsonRpcClient({
    url: process.env.SUI_RPC_URL || getJsonRpcFullnodeUrl(network),
    network,
  });

  const signer = loadKeypair();
  const address = signer.getPublicKey().toSuiAddress();
  const exchangeId = EXCHANGE_OBJECTS[Math.floor(Math.random() * EXCHANGE_OBJECTS.length)]!;

  const tx = new Transaction();
  const [suiCoin] = tx.splitCoins(tx.gas, [amountMist]);
  const walCoin = tx.moveCall({
    target: `${WAL_EXCHANGE_PACKAGE}::wal_exchange::exchange_all_for_wal`,
    arguments: [tx.object(exchangeId), suiCoin],
  });
  tx.transferObjects([walCoin], address);

  tx.setSender(address);
  const bytes = await tx.build({ client });
  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: bytes,
    options: { showEffects: true, showBalanceChanges: true },
  });

  console.log(JSON.stringify({ digest: result.digest, status: result.effects?.status }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
