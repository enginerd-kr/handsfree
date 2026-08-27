import { describe, expect, it } from 'vitest';
import { stripAnsi } from './clipboard.js';

const ESC = '';

describe('stripAnsi', () => {
  it('takes the colours off and leaves the words', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m and ${ESC}[1;4mloud${ESC}[22;24m`)).toBe(
      'red and loud',
    );
  });

  it('drops a whole BEL-terminated string, hyperlinks included', () => {
    expect(stripAnsi(`${ESC}]8;;https://example.comtext${ESC}]8;;`)).toBe('text');
  });

  it('leaves plain text alone, Korean and all', () => {
    expect(stripAnsi('드래그로 복사')).toBe('드래그로 복사');
  });
});
