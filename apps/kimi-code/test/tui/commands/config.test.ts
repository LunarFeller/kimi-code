/**
 * Scenario: committing boolean thinking "on" for a model with no declared
 * support_efforts and no on_effort — such an On reaches the wire as no
 * reasoning parameter at all, so the model pickers first offer to persist a
 * level as the model's on_effort in config.toml.
 * Wiring: real maybePromptOnEffort with the harness/authFlow/editor boundaries
 * stubbed by a small host rig; the mounted ChoicePickerComponent is driven
 * through handleInput like a real dialog.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/config.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { bareBooleanOnNeedsEffort, handleEffortCommand, maybePromptOnEffort } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';

const ESC = String.fromCodePoint(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;

const ALIAS = 'selfhosted/deepseek-v4-flash';

function booleanModel(extra?: Partial<ModelAlias>): ModelAlias {
  return {
    provider: 'selfhosted',
    model: 'deepseek-v4-flash',
    maxContextSize: 384_000,
    capabilities: ['tool_use', 'thinking'],
    ...extra,
  } as unknown as ModelAlias;
}

function makeHost(
  model: ModelAlias,
  configModels: Record<string, unknown> | undefined,
  providerType = 'openai',
) {
  let mounted: ChoicePickerComponent | undefined;
  const proceed = vi.fn();
  const host = {
    state: {
      appState: {
        availableModels: { [ALIAS]: model },
        availableProviders: { selfhosted: { type: providerType } },
      },
    },
    harness: {
      getConfig: vi.fn(async () => ({ models: configModels })),
      setConfig: vi.fn(async () => ({})),
    },
    authFlow: {
      refreshConfigAfterLogin: vi.fn(async () => {}),
    },
    mountEditorReplacement: vi.fn((component: ChoicePickerComponent) => {
      mounted = component;
    }),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
    };
    authFlow: { refreshConfigAfterLogin: ReturnType<typeof vi.fn> };
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
  };
  return { host, proceed, mounted: () => mounted };
}

describe('maybePromptOnEffort', () => {
  it('proceeds without prompting when thinking is off', () => {
    const { host, proceed, mounted } = makeHost(booleanModel(), {});

    maybePromptOnEffort(host, { [ALIAS]: booleanModel() }, { alias: ALIAS, thinking: 'off' }, proceed);

    expect(proceed).toHaveBeenCalledOnce();
    expect(mounted()).toBeUndefined();
  });

  it('prompts again with the configured level preselected; re-choosing it skips the write', () => {
    const configured = booleanModel({ onEffort: 'medium' } as Partial<ModelAlias>);
    const { host, proceed, mounted } = makeHost(configured, { [ALIAS]: configured });

    maybePromptOnEffort(host, { [ALIAS]: configured }, { alias: ALIAS, thinking: 'on' }, proceed);

    const picker = mounted();
    expect(picker).toBeInstanceOf(ChoicePickerComponent);
    expect(proceed).not.toHaveBeenCalled();

    // The cursor starts on the configured Medium; Enter re-confirms it.
    const rendered = picker!.render(120).join('\n');
    expect(rendered).toContain('Medium');
    picker!.handleInput(DOWN); // Medium is preselected at index 2; move down…
    picker!.handleInput(UP); // …and back onto it
    picker!.handleInput('\r');

    expect(proceed).toHaveBeenCalledOnce();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('overwrites on_effort when a different level is chosen', async () => {
    const configured = booleanModel({ onEffort: 'medium' } as Partial<ModelAlias>);
    const configEntry = { provider: 'selfhosted', model: 'deepseek-v4-flash', onEffort: 'medium' };
    const { host, proceed, mounted } = makeHost(configured, { [ALIAS]: configEntry });

    maybePromptOnEffort(host, { [ALIAS]: configured }, { alias: ALIAS, thinking: 'on' }, proceed);

    const picker = mounted()!;
    picker.handleInput(UP); // Medium -> Low
    picker.handleInput('\r');

    await vi.waitFor(() => {
      expect(proceed).toHaveBeenCalledOnce();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      models: { [ALIAS]: { ...configEntry, onEffort: 'low' } },
    });
  });

  it('cannot clear a configured on_effort from the picker — points to config.toml instead', async () => {
    const configured = booleanModel({ onEffort: 'medium' } as Partial<ModelAlias>);
    const { host, proceed, mounted } = makeHost(configured, { [ALIAS]: configured });

    maybePromptOnEffort(host, { [ALIAS]: configured }, { alias: ALIAS, thinking: 'on' }, proceed);

    const picker = mounted()!;
    picker.handleInput(UP); // Medium -> Low
    picker.handleInput(UP); // Low -> Default (no parameter)
    picker.handleInput('\r');

    await vi.waitFor(() => {
      expect(proceed).toHaveBeenCalledOnce();
    });
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('stays in config.toml'),
      'warning',
    );
  });

  it('proceeds without prompting for effort-capable models', () => {
    const capable = booleanModel({ supportEfforts: ['low', 'high'] } as Partial<ModelAlias>);
    const { host, proceed, mounted } = makeHost(capable, {});

    maybePromptOnEffort(host, { [ALIAS]: capable }, { alias: ALIAS, thinking: 'high' }, proceed);

    expect(proceed).toHaveBeenCalledOnce();
    expect(mounted()).toBeUndefined();
  });

  it('proceeds without prompting on protocols that encode boolean On natively', () => {
    // A kimi-protocol endpoint encodes boolean on as a thinking object, so
    // there is no missing parameter to compensate for.
    const model = booleanModel();
    const { host, proceed, mounted } = makeHost(model, { [ALIAS]: model }, 'kimi');

    maybePromptOnEffort(host, { [ALIAS]: model }, { alias: ALIAS, thinking: 'on' }, proceed);

    expect(proceed).toHaveBeenCalledOnce();
    expect(mounted()).toBeUndefined();
  });

  it('prompts for a level when boolean On has no on_effort, and Default keeps the wire unchanged', () => {
    const model = booleanModel();
    const { host, proceed, mounted } = makeHost(model, { [ALIAS]: model });

    maybePromptOnEffort(host, { [ALIAS]: model }, { alias: ALIAS, thinking: 'on' }, proceed);

    const picker = mounted();
    expect(picker).toBeInstanceOf(ChoicePickerComponent);
    expect(proceed).not.toHaveBeenCalled();
    expect(host.restoreEditor).not.toHaveBeenCalled();

    // The initial cursor sits on Default (no parameter); Enter keeps today's behavior.
    picker!.handleInput('\r');

    expect(proceed).toHaveBeenCalledOnce();
    expect(host.restoreEditor).toHaveBeenCalledOnce();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
  });

  it('persists the picked level as on_effort before proceeding', async () => {
    const model = booleanModel();
    const configEntry = { provider: 'selfhosted', model: 'deepseek-v4-flash' };
    const { host, proceed, mounted } = makeHost(model, { [ALIAS]: configEntry });

    maybePromptOnEffort(host, { [ALIAS]: model }, { alias: ALIAS, thinking: 'on' }, proceed);

    const picker = mounted()!;
    picker.handleInput(DOWN); // Low
    picker.handleInput(DOWN); // Medium
    picker.handleInput('\r');

    await vi.waitFor(() => {
      expect(proceed).toHaveBeenCalledOnce();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      models: { [ALIAS]: { ...configEntry, onEffort: 'medium' } },
    });
    expect(host.authFlow.refreshConfigAfterLogin).toHaveBeenCalledOnce();
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('on_effort = "medium"'));
  });

  it('Custom… opens a free-text input and persists the typed level', async () => {
    const model = booleanModel();
    const configEntry = { provider: 'selfhosted', model: 'deepseek-v4-flash' };
    const { host, proceed, mounted } = makeHost(model, { [ALIAS]: configEntry });

    maybePromptOnEffort(host, { [ALIAS]: model }, { alias: ALIAS, thinking: 'on' }, proceed);

    const picker = mounted()!;
    for (let i = 0; i < 6; i++) picker.handleInput(DOWN); // -> Custom… (last option)
    picker.handleInput('\r');

    // The level picker is replaced by a free-text field.
    const field = mounted()!;
    expect(field).not.toBe(picker);
    for (const ch of 'xhigh') field.handleInput(ch);
    field.handleInput('\r');

    await vi.waitFor(() => {
      expect(proceed).toHaveBeenCalledOnce();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      models: { [ALIAS]: { ...configEntry, onEffort: 'xhigh' } },
    });
  });

  it('Escape aborts the whole selection — no switch, no write', () => {
    const model = booleanModel();
    const { host, proceed, mounted } = makeHost(model, { [ALIAS]: model });

    maybePromptOnEffort(host, { [ALIAS]: model }, { alias: ALIAS, thinking: 'on' }, proceed);
    mounted()!.handleInput(ESC);

    expect(proceed).not.toHaveBeenCalled();
    expect(host.restoreEditor).toHaveBeenCalledOnce();
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(expect.stringContaining('Model unchanged'));
  });

  it('warns and still proceeds when the alias is not in config.toml', async () => {
    const model = booleanModel();
    const { host, proceed, mounted } = makeHost(model, {});

    maybePromptOnEffort(host, { [ALIAS]: model }, { alias: ALIAS, thinking: 'on' }, proceed);

    const picker = mounted()!;
    picker.handleInput(DOWN);
    picker.handleInput('\r');

    await vi.waitFor(() => {
      expect(proceed).toHaveBeenCalledOnce();
    });
    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      expect.stringContaining('not in config.toml'),
      'warning',
    );
  });
});

describe('bareBooleanOnNeedsEffort', () => {
  function rig(model: ModelAlias, providerType: string | undefined): SlashCommandHost {
    return {
      state: {
        appState: {
          availableModels: { [ALIAS]: model },
          availableProviders: providerType === undefined ? {} : { selfhosted: { type: providerType } },
        },
      },
    } as unknown as SlashCommandHost;
  }

  it('is true only for a bare boolean On on an OpenAI-compatible wire', () => {
    expect(bareBooleanOnNeedsEffort(rig(booleanModel(), 'openai'), booleanModel(), 'on')).toBe(true);
    // Already configured on_effort: On is encoded.
    const configured = booleanModel({ onEffort: 'medium' } as Partial<ModelAlias>);
    expect(bareBooleanOnNeedsEffort(rig(configured, 'openai'), configured, 'on')).toBe(false);
    // Declared efforts: concrete levels, not a bare On.
    const capable = booleanModel({ supportEfforts: ['low', 'high'] } as Partial<ModelAlias>);
    expect(bareBooleanOnNeedsEffort(rig(capable, 'openai'), capable, 'high')).toBe(false);
    // Protocols that encode boolean On natively.
    expect(bareBooleanOnNeedsEffort(rig(booleanModel(), 'kimi'), booleanModel(), 'on')).toBe(false);
    // Off never needs a level.
    expect(bareBooleanOnNeedsEffort(rig(booleanModel(), 'openai'), booleanModel(), 'off')).toBe(false);
  });
});

describe('/thinking picker routes boolean On through the effort prompt', () => {
  it('opens the level picker when selecting On for a bare boolean model', async () => {
    const model = booleanModel();
    let mounted: unknown;
    const host = {
      state: {
        appState: {
          model: ALIAS,
          availableModels: { [ALIAS]: model },
          availableProviders: { selfhosted: { type: 'openai' } },
          thinkingEffort: 'off',
        },
        transcriptEntries: [],
      },
      mountEditorReplacement: vi.fn((component: unknown) => {
        mounted = component;
      }),
      restoreEditor: vi.fn(),
      showStatus: vi.fn(),
      showError: vi.fn(),
    } as unknown as SlashCommandHost;

    await handleEffortCommand(host, '');
    expect(mounted).toBeInstanceOf(EffortSelectorComponent);

    // Segments for a boolean model are [on, off]; live is off — step left to on.
    (mounted as EffortSelectorComponent).handleInput(LEFT);
    (mounted as EffortSelectorComponent).handleInput('\r');

    expect(mounted).toBeInstanceOf(ChoicePickerComponent);
  });

  it('does not open the level picker for Off or for encoded protocols', async () => {
    const model = booleanModel();
    const mountedList: unknown[] = [];
    const makeEffortHost = (providerType: string): SlashCommandHost =>
      ({
        state: {
          appState: {
            model: ALIAS,
            availableModels: { [ALIAS]: model },
            availableProviders: { selfhosted: { type: providerType } },
            thinkingEffort: 'off',
          },
          transcriptEntries: [],
        },
        mountEditorReplacement: vi.fn((component: unknown) => {
          mountedList.push(component);
        }),
        restoreEditor: vi.fn(),
        showStatus: vi.fn(),
        showError: vi.fn(),
        // performModelSwitch runs after a non-prompted commit — stub the
        // boundaries it touches (no session, v1 login-activation path).
        session: undefined,
        engineV2: false,
        waitForLazyCreation: vi.fn(async () => {}),
        authFlow: { activateModelAfterLogin: vi.fn(async () => {}) },
        harness: { setConfig: vi.fn(async () => ({})) },
        setAppState: vi.fn(),
        showNotice: vi.fn(),
        track: vi.fn(),
      }) as unknown as SlashCommandHost;

    // Off: no prompt even on openai wire.
    const hostOff = makeEffortHost('openai');
    await handleEffortCommand(hostOff, '');
    (mountedList.at(-1) as EffortSelectorComponent).handleInput('\r'); // off, current
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mountedList.some((c) => c instanceof ChoicePickerComponent)).toBe(false);

    // kimi wire encodes boolean On natively: no prompt either.
    mountedList.length = 0;
    const hostKimi = makeEffortHost('kimi');
    await handleEffortCommand(hostKimi, '');
    const picker = mountedList.at(-1) as EffortSelectorComponent;
    picker.handleInput(LEFT); // off -> on
    picker.handleInput('\r');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mountedList.some((c) => c instanceof ChoicePickerComponent)).toBe(false);
  });
});
