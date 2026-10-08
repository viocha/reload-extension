import { describe, expect, test } from 'bun:test';
import { findExtension, parseExtensions } from '../src/lib/extensions.js';

const output = JSON.stringify({ extensions: [
  { id: 'dfbdlidakbmfedfidhpbnelkkjoombhj', name: 'Bookmark Pro', version: '1.9.2', enabled: true },
  { id: 'ncekidoiekbflbbpoldpfldjnbccfmmm', name: 'Web Toolkit', version: '1.9.5', enabled: true },
] });

describe('extensions', () => {
  test('解析结构化扩展列表', () => {
    expect(parseExtensions(output)).toEqual([
      {
        id: 'dfbdlidakbmfedfidhpbnelkkjoombhj',
        name: 'Bookmark Pro',
        version: '1.9.2',
        enabled: true,
      },
      {
        id: 'ncekidoiekbflbbpoldpfldjnbccfmmm',
        name: 'Web Toolkit',
        version: '1.9.5',
        enabled: true,
      },
    ]);
  });

  test('findExtension prefers exact name and supports unique partial name', () => {
    const extensions = parseExtensions(output);
    expect(findExtension(extensions, 'Web Toolkit').id).toBe(
      'ncekidoiekbflbbpoldpfldjnbccfmmm',
    );
    expect(findExtension(extensions, 'Toolkit').id).toBe(
      'ncekidoiekbflbbpoldpfldjnbccfmmm',
    );
  });
});
