/**
 * Scenario: /provider manual add — the third add-source for self-hosted
 * gateways and relay endpoints that appear in neither the models.dev catalog
 * nor a custom registry.
 * Wiring: validators and buildManualModelEntry are pure; the wizard itself is
 * driven through the mounted dialogs (text fields typed char by char, choice
 * pickers moved with arrows) against a stubbed harness/authFlow boundary.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/provider-manual.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';
import {
  buildManualModelEntry,
  handleManualProviderAdd,
  parseEffortList,
  validateBaseUrl,
  validateContextSize,
  validateProviderId,
} from '#/tui/commands/provider-manual';

const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;
const BACKSPACE = '\u007F';

function typeText(dialog: ApiKeyInputDialogComponent, text: string): void {
  for (const ch of text) dialog.handleInput(ch);
}

describe('manual-add validators', () => {
  it('accepts a plain provider id and rejects bad charset / duplicates', () => {
    expect(validateProviderId('my-gateway', [])).toBeUndefined();
    expect(validateProviderId('my gateway', [])).toBeUndefined();
    expect(validateProviderId('-bad', [])).toBeDefined();
    expect(validateProviderId('has/slash', [])).toBeDefined();
    expect(validateProviderId('gw', ['gw'])).toBeDefined();
  });

  it('accepts http(s) base URLs only', () => {
    expect(validateBaseUrl('http://127.0.0.1:8899')).toBeUndefined();
    expect(validateBaseUrl('https://gateway.example.com/v1')).toBeUndefined();
    expect(validateBaseUrl('not-a-url')).toBeDefined();
    expect(validateBaseUrl('ftp://example.com')).toBeDefined();
  });

  it('accepts positive integer context sizes only', () => {
    expect(validateContextSize('131072')).toBeUndefined();
    expect(validateContextSize('0')).toBeDefined();
    expect(validateContextSize('128k')).toBeDefined();
  });

  it('parses comma-separated effort lists with trimming and dedupe', () => {
    expect(parseEffortList('low, medium ,high')).toEqual(['low', 'medium', 'high']);
    expect(parseEffortList('low,low')).toEqual(['low']);
    expect(parseEffortList(' , ')).toBeUndefined();
  });
});

describe('buildManualModelEntry', () => {
  it('builds a tool_use-only entry when thinking is unsupported', () => {
    expect(buildManualModelEntry('gw', 'm1', 1000, { kind: 'none' })).toEqual({
      provider: 'gw',
      model: 'm1',
      maxContextSize: 1000,
      capabilities: ['tool_use'],
      supportEfforts: undefined,
      defaultEffort: undefined,
      onEffort: undefined,
    });
  });

  it('builds a boolean-thinking entry with on_effort', () => {
    expect(
      buildManualModelEntry('gw', 'm1', 1000, { kind: 'toggle', onEffort: 'medium' }),
    ).toEqual({
      provider: 'gw',
      model: 'm1',
      maxContextSize: 1000,
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: undefined,
      defaultEffort: undefined,
      onEffort: 'medium',
    });
  });

  it('builds an effort-level entry with support_efforts and default_effort', () => {
    expect(
      buildManualModelEntry('gw', 'm1', 1000, {
        kind: 'efforts',
        efforts: ['low', 'high'],
        defaultEffort: 'high',
      }),
    ).toEqual({
      provider: 'gw',
      model: 'm1',
      maxContextSize: 1000,
      capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
      onEffort: undefined,
    });
  });
});

function makeHost() {
  const mounted: unknown[] = [];
  const setDefault = vi.fn(async () => {});
  const host = {
    harness: {
      getConfig: vi.fn(async () => ({ providers: {}, models: {} })),
      setConfig: vi.fn(async () => ({})),
    },
    authFlow: { refreshConfigAfterLogin: vi.fn(async () => {}) },
    mountEditorReplacement: vi.fn((component: unknown) => {
      mounted.push(component);
    }),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: { setConfig: ReturnType<typeof vi.fn> };
    authFlow: { refreshConfigAfterLogin: ReturnType<typeof vi.fn> };
  };

  let cursor = 0;
  const nextDialog = async <T>(): Promise<T> => {
    const index = cursor;
    cursor += 1;
    await vi.waitFor(() => {
      expect(mounted.length).toBeGreaterThan(index);
    });
    return mounted[index] as T;
  };
  return { host, nextDialog, setDefault };
}

/** Drives the wizard's six endpoint-field dialogs, stopping at the thinking pickers. */
async function driveEndpointFields(nextDialog: <T>() => Promise<T>): Promise<void> {
  const name = await nextDialog<ApiKeyInputDialogComponent>();
  typeText(name, 'gw');
  name.handleInput('\r');

  const protocol = await nextDialog<ChoicePickerComponent>();
  protocol.handleInput('\r'); // openai, preselected

  const baseUrl = await nextDialog<ApiKeyInputDialogComponent>();
  typeText(baseUrl, 'http://127.0.0.1:8899');
  baseUrl.handleInput('\r');

  const apiKey = await nextDialog<ApiKeyInputDialogComponent>();
  typeText(apiKey, 'sk-e2e');
  apiKey.handleInput('\r');

  const model = await nextDialog<ApiKeyInputDialogComponent>();
  typeText(model, 'deepseek-v4-flash');
  model.handleInput('\r');

  const contextSize = await nextDialog<ApiKeyInputDialogComponent>();
  typeText(contextSize, '131072');
  contextSize.handleInput('\r');
}

describe('handleManualProviderAdd', () => {
  it('runs the full wizard: persists provider + model, then sets the default in one confirm step', async () => {
    const { host, nextDialog, setDefault } = makeHost();
    const wizard = handleManualProviderAdd(host, setDefault);

    await driveEndpointFields(nextDialog);

    // One thinking question decides capability + level + default state:
    // picking 'On — medium' means thinking on at medium, no further question.
    const thinking = await nextDialog<ChoicePickerComponent>();
    thinking.handleInput(DOWN); // Not supported -> On (endpoint decides)
    thinking.handleInput(DOWN); // -> On — low
    thinking.handleInput(DOWN); // -> On — medium
    thinking.handleInput('\r');

    // The final step only asks about the default — the thinking state is
    // already implied by the level just picked.
    const confirm = await nextDialog<ChoicePickerComponent>();
    confirm.handleInput('\r'); // Set as default (thinking: medium)

    await expect(wizard).resolves.toBe(true);
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      providers: {
        gw: { type: 'openai', baseUrl: 'http://127.0.0.1:8899', apiKey: 'sk-e2e' },
      },
      models: {
        'gw/deepseek-v4-flash': {
          provider: 'gw',
          model: 'deepseek-v4-flash',
          maxContextSize: 131072,
          capabilities: ['tool_use', 'thinking'],
          supportEfforts: undefined,
          defaultEffort: undefined,
          onEffort: 'medium',
        },
      },
    });
    expect(host.authFlow.refreshConfigAfterLogin).toHaveBeenCalledOnce();
    expect(setDefault).toHaveBeenCalledWith('gw/deepseek-v4-flash', 'on');
  });

  it('supports custom thinking levels with a picked default', async () => {
    const { host, nextDialog, setDefault } = makeHost();
    const wizard = handleManualProviderAdd(host, setDefault);

    await driveEndpointFields(nextDialog);

    const thinking = await nextDialog<ChoicePickerComponent>();
    for (let i = 0; i < 6; i++) thinking.handleInput(DOWN); // -> Custom levels…
    thinking.handleInput('\r');

    const levels = await nextDialog<ApiKeyInputDialogComponent>();
    typeText(levels, 'low,high');
    levels.handleInput('\r');

    const defaultLevel = await nextDialog<ChoicePickerComponent>();
    defaultLevel.handleInput('\r'); // 'high' preselected (middle of the list)

    const confirm = await nextDialog<ChoicePickerComponent>();
    confirm.handleInput('\r'); // Set as default (thinking: high)

    await expect(wizard).resolves.toBe(true);
    expect(host.harness.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        models: {
          'gw/deepseek-v4-flash': {
            provider: 'gw',
            model: 'deepseek-v4-flash',
            maxContextSize: 131072,
            capabilities: ['tool_use', 'thinking'],
            supportEfforts: ['low', 'high'],
            defaultEffort: 'high',
            onEffort: undefined,
          },
        },
      }),
    );
    expect(setDefault).toHaveBeenCalledWith('gw/deepseek-v4-flash', 'high');
  });

  it('keeps the current default when the confirm step says so', async () => {
    const { host, nextDialog, setDefault } = makeHost();
    const wizard = handleManualProviderAdd(host, setDefault);

    await driveEndpointFields(nextDialog);

    const thinking = await nextDialog<ChoicePickerComponent>();
    thinking.handleInput('\r'); // Not supported

    const confirm = await nextDialog<ChoicePickerComponent>();
    confirm.handleInput(DOWN); // Set as default -> Keep the current default
    confirm.handleInput('\r');

    await expect(wizard).resolves.toBe(true);
    expect(host.harness.setConfig).toHaveBeenCalledOnce();
    expect(setDefault).not.toHaveBeenCalled();
  });

  it('blocks submission on an invalid field until corrected', async () => {
    const { host, nextDialog, setDefault } = makeHost();
    const wizard = handleManualProviderAdd(host, setDefault);

    const name = await nextDialog<ApiKeyInputDialogComponent>();
    typeText(name, 'has/slash');
    name.handleInput('\r'); // rejected: invalid charset, dialog stays mounted
    await sleep(100);
    expect(host.restoreEditor).not.toHaveBeenCalled();

    for (let i = 0; i < 'has/slash'.length; i++) name.handleInput(BACKSPACE);
    typeText(name, 'gw');
    name.handleInput('\r');

    const protocol = await nextDialog<ChoicePickerComponent>();
    protocol.handleInput(ESC); // cancel here — the name field passed validation

    await expect(wizard).resolves.toBe(false);
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('returns false without writing when cancelled mid-wizard', async () => {
    const { host, nextDialog, setDefault } = makeHost();
    const wizard = handleManualProviderAdd(host, setDefault);

    const name = await nextDialog<ApiKeyInputDialogComponent>();
    typeText(name, 'gw');
    name.handleInput('\r');

    const protocol = await nextDialog<ChoicePickerComponent>();
    protocol.handleInput(ESC);

    await expect(wizard).resolves.toBe(false);
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
