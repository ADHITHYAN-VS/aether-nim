import { describe, expect, it } from 'vitest';
import { Twin, type WebSearchHook } from '../engine/store.js';
import type { AIResult, AIAdapter } from '../engine/ai.js';
import type { AIPrompt } from '../engine/types.js';
import type { NetworkWorld } from '../engine/graph.js';
import type { WebEvidenceItem } from '../engine/types.js';

/** Minimal AI adapter capture: records the prompt, returns a fixed result. */
class CapturingAdapter implements AIAdapter {
  lastPrompt: AIPrompt | null = null;
  constructor(private result: AIResult) {}
  enabled(): boolean { return true; }
  modelId(): string { return 'test-model'; }
  async complete(prompt: AIPrompt, _world: NetworkWorld): Promise<AIResult> {
    this.lastPrompt = prompt;
    return this.result;
  }
}

const okResult: AIResult = { mode: 'real', model: 'test-model' };

describe('Tavily web-grounding hook', () => {
  it('injects Tavily evidence into the AI prompt and logs the web_evidence stage', async () => {
    const evidence: WebEvidenceItem[] = [
      { title: 'Regional fiber cut report', url: 'https://example.com/cut', snippet: 'backhoe damage caused a fiber cut' },
    ];
    const hook: WebSearchHook = async () => evidence;
    const ai = new CapturingAdapter(okResult);
    const twin = new Twin('bridge-failure', ai, hook);
    twin.applyDamagePreset('bridge-failure');

    await twin.diagnose();

    expect(ai.lastPrompt).not.toBeNull();
    expect(ai.lastPrompt?.web_evidence).toEqual(evidence);
    expect(twin.lastWeb?.used).toBe(true);
    expect(twin.lastWeb?.count).toBe(1);
    expect(twin.lastWeb?.sources?.[0].url).toBe('https://example.com/cut');
    const stages = twin.timelineList().map((e) => e.stage);
    expect(stages).toContain('web_evidence');
  });

  it('degrades gracefully when the web hook fails — diagnosis still completes', async () => {
    const hook: WebSearchHook = async () => { throw new Error('tavily down'); };
    const ai = new CapturingAdapter(okResult);
    const twin = new Twin('bridge-failure', ai, hook);
    twin.applyDamagePreset('bridge-failure');

    const { incident, ai: aiRes } = await twin.diagnose();

    expect(incident).not.toBeNull();
    expect(aiRes?.mode).toBe('real');
    expect(ai.lastPrompt?.web_evidence).toBeUndefined();
    expect(twin.lastWeb).toEqual({ used: false, count: 0 });
    expect(twin.timelineList().map((e) => e.stage)).toContain('web_failed');
  });

  it('skips the web call entirely when the AI stage is disabled', async () => {
    let called = 0;
    const hook: WebSearchHook = async () => { called++; return null; };
    const disabled: AIAdapter = {
      enabled: () => false, modelId: () => 'test-model',
      complete: async () => ({ mode: 'fallback' as const, model: 'test-model' }),
    };
    const twin = new Twin('bridge-failure', disabled, hook);
    twin.applyDamagePreset('bridge-failure');
    await twin.diagnose();
    expect(called).toBe(0);
  });
});
