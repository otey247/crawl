import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { preferencesFromTags, type PreferenceTag, type RoutePreferences } from '@crawl/core';
import { config } from '../config.js';

/**
 * The LLM never computes routes. It (1) turns the organizer's free-text preferences into
 * solver weights and (2) explains the solved route in plain language. Both have
 * deterministic fallbacks so the feature works without an API key.
 */

const client = config.anthropic.enabled ? new Anthropic() : null;

async function structured<T extends z.ZodType>(system: string, user: string, schema: T): Promise<z.infer<T> | null> {
  if (!client) return null;
  try {
    const res = await client.beta.messages.parse(
      {
        model: config.anthropic.model,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { timeout: 15_000 },
    );
    if (res.stop_reason === 'refusal') return null;
    return (res.parsed_output as z.infer<T> | null) ?? null;
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.warn('[llm]', err.status, err.message);
    else console.warn('[llm]', (err as Error).message);
    return null;
  }
}

const PrefSchema = z.object({
  quieter: z.number().min(0).max(1).describe('0 = no preference, 1 = strongly avoid busy roads and crowds'),
  scenic: z.number().min(0).max(1).describe('0 = no preference, 1 = strongly prefer parks, green and pedestrian streets'),
  catchSpecials: z.number().min(0).max(1).describe('How much catching drink specials/happy hours matters'),
  maxLegMinutes: z.number().nullable().describe('Hard cap on minutes walked between two bars, or null'),
  summary: z.string().describe('One short clause restating the preferences, e.g. "quiet side streets, short hops"'),
});

const PREF_SYSTEM = `You convert a pub crawl organizer's free-text routing wishes into numeric weights for a walking-route solver.
Only express what the text asks for; leave everything else at 0 / null. Never invent constraints.`;

export async function interpretPreferences(tags: PreferenceTag[], note: string | null | undefined): Promise<RoutePreferences> {
  const base = preferencesFromTags(tags, note);
  const text = note?.trim();
  if (!text) return base;
  const parsed = await structured(PREF_SYSTEM, `Organizer wrote: """${text.slice(0, 500)}"""`, PrefSchema);
  if (parsed) {
    return {
      ...base,
      alpha: Math.max(base.alpha, +(parsed.quieter * 0.4).toFixed(2)),
      beta: Math.max(base.beta, +(parsed.scenic * 0.3).toFixed(2)),
      lambda: Math.max(base.lambda, Math.round(10 + parsed.catchSpecials * 20)),
      maxLegS: parsed.maxLegMinutes ? Math.min(base.maxLegS ?? Infinity, parsed.maxLegMinutes * 60) : base.maxLegS,
      note: parsed.summary || text,
    };
  }
  // Keyword fallback.
  const t = text.toLowerCase();
  const prefs = { ...base };
  if (/quiet|crowd|busy|calm|side street/.test(t)) prefs.alpha = Math.max(prefs.alpha, 0.4);
  if (/scenic|park|pretty|view|green|stroll/.test(t)) prefs.beta = Math.max(prefs.beta, 0.3);
  if (/special|happy hour|deal|cheap/.test(t)) prefs.lambda = Math.max(prefs.lambda, 30);
  const mins = t.match(/(\d+)\s*min/);
  if (mins && /walk|leg|between|max|under|less/.test(t)) prefs.maxLegS = Number(mins[1]) * 60;
  return prefs;
}

export interface ExplainInput {
  stops: { name: string; arrival: string; caught: string[]; missed: string[] }[];
  totalWalkMin: number;
  totalDistanceKm: number;
  totalHours: number;
  preferences: RoutePreferences;
  baseline: { totalWalkMin: number; caughtCount: number } | null;
  caughtCount: number;
  violations: number;
  /** St. Louis event crowds that padded walking times. */
  crowd?: { factor: number; event: string } | null;
  /** Rain risk the solver planned around for patio stops. */
  rain?: { outdoorStops: string[]; maxChance: number; wetFrom: string | null } | null;
}

const ExplainSchema = z.object({ explanation: z.string().describe('2–3 plain sentences, no lists, no markdown') });

const EXPLAIN_SYSTEM = `You explain a pub crawl walking route to the organizer who must approve it.
Write 2–3 short, plain sentences. Lead with the decision that matters most (usually which special a stop order catches,
or the walking saved). Use the bar names and times given. Do not invent specials, prices or facts.
Do not encourage heavy drinking.`;

export async function explainRoute(input: ExplainInput): Promise<string> {
  const llm = await structured(EXPLAIN_SYSTEM, JSON.stringify(input), ExplainSchema);
  if (llm?.explanation) return llm.explanation.trim();
  return templateExplanation(input);
}

export function templateExplanation(input: ExplainInput): string {
  const parts: string[] = [];
  const first = input.stops[0];
  const firstCatch = input.stops.find((s) => s.caught.length);
  if (firstCatch) {
    parts.push(`${firstCatch === first ? 'Starts' : 'Reaches'} at ${firstCatch.name} by ${firstCatch.arrival} to catch ${firstCatch.caught[0]}.`);
  } else if (first) {
    parts.push(`Starts at ${first.name} at ${first.arrival}.`);
  }
  parts.push(`${input.stops.length} stops, ${input.totalDistanceKm.toFixed(1)} km and about ${Math.round(input.totalWalkMin)} min of walking over ${input.totalHours.toFixed(1)} h.`);
  if (input.baseline) {
    const saved = Math.round(input.baseline.totalWalkMin - input.totalWalkMin);
    const extra = input.caughtCount - input.baseline.caughtCount;
    if (saved > 0 && extra > 0) parts.push(`That saves ${saved} min of walking and catches ${extra} more special${extra > 1 ? 's' : ''} than your order.`);
    else if (saved > 0) parts.push(`That saves ${saved} min of walking versus your order.`);
    else if (extra > 0) parts.push(`It catches ${extra} more special${extra > 1 ? 's' : ''} than your order for ${-saved} extra min on foot.`);
  }
  if (input.violations) parts.push('Some legs exceed your walking limit; consider dropping a far stop.');
  if (input.crowd) parts.push(`${input.crowd.event} crowds: walking times are padded ${Math.round((input.crowd.factor - 1) * 100)}%.`);
  if (input.rain)
    parts.push(
      `Rain chances reach ${input.rain.maxChance}%${input.rain.wetFrom ? ` from about ${input.rain.wetFrom}` : ''}, so the order keeps patio stops (${input.rain.outdoorStops.join(', ')}) out of the wettest hours where it can.`,
    );
  return parts.join(' ');
}
