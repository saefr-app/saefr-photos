import { describe, expect, it } from 'vitest';

import { safeErrorCode } from './safe-error-code.js';

describe('safeErrorCode', () => {
  it('reports only known filesystem and PostgreSQL codes', () => {
    expect(
      safeErrorCode({ code: 'ENOSPC', message: '/private/image.jpg' }),
    ).toBe('ENOSPC');
    expect(
      safeErrorCode({ code: '28P01', message: 'password=private-value' }),
    ).toBe('PostgreSQL authentication failure');
  });

  it('does not echo unknown codes or exception messages', () => {
    const secret = 'password=private-value /private/image.jpg';

    expect(safeErrorCode({ code: secret, message: secret })).toBe(
      'unclassified',
    );
    expect(safeErrorCode(new Error(secret))).toBe('unclassified');
    expect(
      safeErrorCode({
        get code() {
          throw new Error(secret);
        },
      }),
    ).toBe('unclassified');
  });

  it('identifies common programming error types without their messages', () => {
    expect(safeErrorCode(new TypeError('private photo data'))).toBe(
      'TypeError',
    );
  });
});
