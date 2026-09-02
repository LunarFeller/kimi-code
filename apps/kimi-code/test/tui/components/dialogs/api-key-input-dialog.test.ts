import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';

describe('ApiKeyInputDialogComponent', () => {
  it('keeps every line within narrow widths', () => {
    const dialog = new ApiKeyInputDialogComponent(
      'Kimi Code',
      ['Paste your API key below.', 'It will be stored locally.'],
      () => {},
    );
    dialog.focused = true;

    for (const width of [39, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('blocks submission while validate reports an error, showing it as the hint', () => {
    const results: string[] = [];
    const dialog = new ApiKeyInputDialogComponent(
      '',
      [],
      (result) => {
        if (result.kind === 'ok') results.push(result.value);
      },
      {
        title: 'Field',
        mask: false,
        validate: (value) => (value.startsWith('ok-') ? undefined : 'Must start with "ok-".'),
      },
    );
    dialog.focused = true;

    for (const ch of 'bad') dialog.handleInput(ch);
    dialog.handleInput('\r');
    expect(results).toEqual([]);
    expect(dialog.render(80).join('\n')).toContain('Must start with "ok-".');

    for (let i = 0; i < 3; i++) dialog.handleInput('\u007F');
    for (const ch of 'ok-1') dialog.handleInput(ch);
    dialog.handleInput('\r');
    expect(results).toEqual(['ok-1']);
  });
});
