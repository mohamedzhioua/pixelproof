/**
 * v1 prompt folding: restate the spec to the generator in prose.
 *
 * A provider cannot read a spec, so anything the verifier will later check has
 * to be said in the prompt as well. Only what v1 folded is folded here — the
 * requirements are deliberately phrased the way the verifier measures them
 * (including the corner tolerance) so the model is told the target it will
 * actually be judged against, not a stricter one it cannot hit.
 */

import { mechanicalBlock, semanticAssertions } from '../spec/load-v1.mjs';

/** Matches the verifier's default corner tolerance. */
const DEFAULT_CORNER_TOLERANCE = 3;

export function foldSpecIntoPrompt(prompt, spec, dimensions) {
  const mechanical = mechanicalBlock(spec);
  const additions = [
    '',
    'Pixelproof spec constraints:',
    `- Output dimensions: exactly ${dimensions.width}x${dimensions.height} pixels.`,
  ];

  if (mechanical.aspect) additions.push(`- Aspect ratio: ${mechanical.aspect}.`);
  if (mechanical.corners?.expect) {
    const tolerance = mechanical.corners.tolerance ?? DEFAULT_CORNER_TOLERANCE;
    additions.push(
      `- Background and all four corner pixels: ${mechanical.corners.expect} `
        + `(the verifier allows ±${tolerance} per RGB channel).`,
    );
  }
  if (mechanical.alpha === 'opaque') additions.push('- The image must be fully opaque.');
  if (mechanical.alpha === 'transparent') {
    additions.push('- The image must contain genuine transparency where the background is absent.');
  }
  if (mechanical.maxBytes) additions.push(`- Keep the PNG at or below ${mechanical.maxBytes} bytes.`);

  const semantic = semanticAssertions(spec);
  if (semantic.length) {
    additions.push('- Semantic requirements:');
    for (const criterion of semantic) additions.push(`  - ${criterion}`);
  }

  return `${prompt.trim()}\n${additions.join('\n')}`;
}
