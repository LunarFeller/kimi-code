/**
 * /provider manual add — the third add-source alongside the models.dev catalog
 * and the custom registry, for self-hosted gateways and relay endpoints that
 * appear in neither. A sequential wizard (id → protocol → base URL → API key
 * → model → context size → thinking metadata) writes one provider + one model
 * alias through the same harness.setConfig path as the catalog import, so the
 * entry is indistinguishable from a hand-written config.toml block — including
 * the thinking metadata (on_effort / support_efforts) the web manual form
 * cannot express.
 */

import type { ModelAlias, ProviderType, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';

import { formatErrorMessage } from '../utils/event-payload';
import type { ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';
import { promptApiKey, promptChoice, promptTextField } from './prompts';

export type ManualThinkingSpec =
  | { readonly kind: 'none' }
  | { readonly kind: 'toggle'; readonly onEffort?: string }
  | { readonly kind: 'efforts'; readonly efforts: readonly string[]; readonly defaultEffort: string };

const PROVIDER_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u;

export function validateProviderId(value: string, existingIds: readonly string[]): string | undefined {
  if (!PROVIDER_ID_PATTERN.test(value)) {
    return 'Use letters, digits, "-", "_", or spaces, starting with a letter or digit.';
  }
  if (existingIds.includes(value)) {
    return `Provider "${value}" already exists — remove it first or pick another name.`;
  }
  return undefined;
}

export function validateBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Base URL must use http:// or https://.';
    }
    return undefined;
  } catch {
    return 'Not a valid URL — e.g. https://your-gateway.example.com/v1.';
  }
}

export function validateContextSize(value: string): string | undefined {
  if (!/^\d+$/.test(value) || Number.parseInt(value, 10) <= 0) {
    return 'Context size must be a positive integer, e.g. 131072.';
  }
  return undefined;
}

/** Parses a comma-separated effort list; undefined when nothing usable remains. */
export function parseEffortList(value: string): readonly string[] | undefined {
  const efforts = [...new Set(value.split(',').map((part) => part.trim()).filter((part) => part.length > 0))];
  return efforts.length > 0 ? efforts : undefined;
}

const PROTOCOL_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'openai',
    label: 'openai',
    description: 'OpenAI-compatible chat completions — most gateways and self-hosted endpoints.',
  },
  { value: 'openai_responses', label: 'openai_responses', description: 'OpenAI Responses API.' },
  { value: 'anthropic', label: 'anthropic', description: 'Anthropic Messages API.' },
  { value: 'kimi', label: 'kimi', description: 'Kimi API.' },
  { value: 'google-genai', label: 'google-genai', description: 'Google Gemini API.' },
  { value: 'vertexai', label: 'vertexai', description: 'Google Vertex AI.' },
];

const THINKING_OPTIONS: readonly ChoiceOption[] = [
  { value: 'none', label: 'Not supported', description: 'The model has no thinking mode.' },
  {
    value: 'on',
    label: 'On (endpoint decides)',
    description: 'A thinking on/off switch; On sends no reasoning parameter.',
  },
  { value: 'low', label: 'On — low', description: 'Thinking on; sends reasoning_effort: "low".' },
  {
    value: 'medium',
    label: 'On — medium',
    description: 'Thinking on; sends reasoning_effort: "medium".',
  },
  { value: 'high', label: 'On — high', description: 'Thinking on; sends reasoning_effort: "high".' },
  { value: 'max', label: 'On — max', description: 'Thinking on; sends reasoning_effort: "max".' },
  {
    value: 'custom',
    label: 'Custom levels…',
    description: 'The model accepts its own strength levels, e.g. low,middle,high.',
  },
];

export function buildManualModelEntry(
  providerId: string,
  modelId: string,
  maxContextSize: number,
  thinking: ManualThinkingSpec,
): ModelAlias {
  return {
    provider: providerId,
    model: modelId,
    maxContextSize,
    capabilities: thinking.kind === 'none' ? ['tool_use'] : ['tool_use', 'thinking'],
    supportEfforts: thinking.kind === 'efforts' ? [...thinking.efforts] : undefined,
    defaultEffort: thinking.kind === 'efforts' ? thinking.defaultEffort : undefined,
    onEffort: thinking.kind === 'toggle' ? thinking.onEffort : undefined,
  } as unknown as ModelAlias;
}

/**
 * One question decides capability + level + default state: picking any
 * thinking option means the user wants thinking ON by default (at that
 * level), 'Not supported' means off. Only 'Custom levels…' asks follow-ups.
 */
async function promptThinkingSpec(host: SlashCommandHost): Promise<ManualThinkingSpec | undefined> {
  const choice = await promptChoice(
    host,
    'Add provider — thinking',
    THINKING_OPTIONS,
    undefined,
    "Not sure? Check the model's documentation — this can be changed later in config.toml.",
  );
  if (choice === undefined) return undefined;

  if (choice === 'custom') {
    const raw = await promptTextField(host, {
      title: 'Add provider — thinking levels',
      subtitleLines: ['Comma-separated, weakest to strongest, e.g. "low,medium,high".'],
      validate: (value) =>
        parseEffortList(value) === undefined
          ? 'Enter at least one level, comma-separated.'
          : undefined,
    });
    if (raw === undefined) return undefined;
    const efforts = parseEffortList(raw)!;
    const defaultEffort = await promptChoice(
      host,
      'Add provider — default thinking level',
      efforts.map((effort) => ({ value: effort, label: effort })),
      efforts[Math.floor(efforts.length / 2)],
    );
    if (defaultEffort === undefined) return undefined;
    return { kind: 'efforts', efforts, defaultEffort };
  }

  if (choice === 'none') return { kind: 'none' };
  if (choice === 'on') return { kind: 'toggle' };
  return { kind: 'toggle', onEffort: choice };
}

/**
 * The wizard's final step: the manual flow adds exactly one model, so the
 * generic model selector would be overkill — confirm the default directly.
 * The thinking state is already implied by the thinking answer (a level means
 * on, 'Not supported' means off), so this step only asks about the default.
 * Returns the effort to set, 'skip' to leave the current default alone, or
 * undefined on Esc.
 */
async function promptDefaultConfirm(
  host: SlashCommandHost,
  alias: string,
  thinking: ManualThinkingSpec,
): Promise<ThinkingEffort | 'skip' | undefined> {
  const effort: ThinkingEffort =
    thinking.kind === 'none'
      ? 'off'
      : thinking.kind === 'toggle'
        ? 'on'
        : thinking.defaultEffort;
  const thinkingLabel =
    thinking.kind === 'none'
      ? ''
      : thinking.kind === 'toggle'
        ? (thinking.onEffort === undefined ? ' (thinking: on)' : ` (thinking: ${thinking.onEffort})`)
        : ` (thinking: ${thinking.defaultEffort})`;

  const choice = await promptChoice(host, `Add provider — set ${alias} as default?`, [
    { value: 'default', label: `Set as default${thinkingLabel}` },
    { value: 'keep', label: 'Keep the current default' },
  ]);
  if (choice === undefined || choice === 'keep') return choice === undefined ? undefined : 'skip';
  return effort;
}

/**
 * Runs the manual-add wizard: collects the endpoint, persists provider +
 * model, then confirms the default model in one final step. `setDefault` is
 * injected by the caller (provider.ts) to avoid an import cycle. Returns true
 * once the provider was persisted — including when the user keeps the current
 * default or cancels at the confirm step.
 */
export async function handleManualProviderAdd(
  host: SlashCommandHost,
  setDefault: (alias: string, effort: ThinkingEffort) => Promise<void>,
): Promise<boolean> {
  const config = await host.harness.getConfig();

  const providerId = await promptTextField(host, {
    title: 'Add provider — name',
    subtitleLines: ['A short id for this provider, e.g. "my-gateway".'],
    emptyHint: 'Provider name cannot be empty.',
    validate: (value) => validateProviderId(value, Object.keys(config.providers ?? {})),
  });
  if (providerId === undefined) return false;

  const wire = await promptChoice(host, 'Add provider — protocol', PROTOCOL_OPTIONS, 'openai');
  if (wire === undefined) return false;

  const baseUrl = await promptTextField(host, {
    title: `Add provider — base URL for ${providerId}`,
    subtitleLines: ['e.g. http://127.0.0.1:8899 or https://your-gateway.example.com/v1'],
    emptyHint: 'Base URL cannot be empty.',
    validate: validateBaseUrl,
  });
  if (baseUrl === undefined) return false;

  const apiKey = await promptApiKey(host, providerId);
  if (apiKey === undefined) return false;

  const modelId = await promptTextField(host, {
    title: `Add provider — model ID for ${providerId}`,
    subtitleLines: ['The exact model name sent to the endpoint, e.g. "deepseek-v4-flash".'],
    emptyHint: 'Model ID cannot be empty.',
  });
  if (modelId === undefined) return false;

  const contextSizeRaw = await promptTextField(host, {
    title: `Add provider — context size for ${modelId}`,
    subtitleLines: ['Max context tokens of the model, e.g. 131072.'],
    emptyHint: 'Context size cannot be empty.',
    validate: validateContextSize,
  });
  if (contextSizeRaw === undefined) return false;

  const thinking = await promptThinkingSpec(host);
  if (thinking === undefined) return false;

  const alias = `${providerId}/${modelId}`;
  try {
    const latest = await host.harness.getConfig({ reload: true });
    await host.harness.setConfig({
      providers: {
        ...latest.providers,
        [providerId]: { type: wire as ProviderType, baseUrl, apiKey },
      },
      models: {
        ...latest.models,
        [alias]: buildManualModelEntry(providerId, modelId, Number.parseInt(contextSizeRaw, 10), thinking),
      },
    });
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(`Failed to add provider: ${formatErrorMessage(error)}`);
    return false;
  }

  host.track('connect', { provider: providerId, method: 'manual' });
  host.showStatus(`Provider added: ${providerId}`);

  const decision = await promptDefaultConfirm(host, alias, thinking);
  if (decision !== undefined && decision !== 'skip') {
    await setDefault(alias, decision);
  }
  return true;
}
