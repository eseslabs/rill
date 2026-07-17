import { expect, test } from 'bun:test';
import type { FlowGraph } from './compiler.service';
import type { ManifestCall } from './manifest';
import { previewService } from './preview.service';

const PKG = `0x${'cd'.repeat(32)}`;

const flow: FlowGraph = {
  nodes: [{ id: 'swap-1', type: 'cetus_swap', config: { amount_in: '999999' } }],
  edges: [],
} as unknown as FlowGraph;

const manifest: ManifestCall[] = [
  { index: 0, target: `${PKG}::router::swap`, typeArguments: ['0x2::sui::SUI'], u64Args: ['42'] },
];

test('the preview reports the amount from the compiled bytes, not the flow config', () => {
  const preview = previewService.buildPreview(flow, manifest, []);
  expect(preview).toContain('42');
  expect(preview).not.toContain('999999');
});

test('the preview names the exact on-chain target from the bytes', () => {
  expect(previewService.buildPreview(flow, manifest, [])).toContain(`${PKG}::router::swap`);
});

test('a flow with action nodes that compiled to no move calls is rejected', () => {
  expect(() => previewService.buildPreview(flow, [], [])).toThrow(/compiled to no on-chain calls/);
});

test('warnings still surface', () => {
  expect(previewService.buildPreview(flow, manifest, ['guardrail dropped'])).toContain(
    'guardrail dropped',
  );
});
