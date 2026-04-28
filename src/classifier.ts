/**
 * STUB — classifier.ts is being written by a parallel agent.
 * This file exists only to satisfy TypeScript compilation.
 * It will be replaced by the real implementation before merge.
 *
 * Exports match the spec'd API:
 *   createClassifier(apiKey: string, model: string): ClassifierClient
 *   classify(client, enriched: EnrichedTrack, taxonomy: TaxonomyConfig): Promise<ClassificationResult>
 */

import type { EnrichedTrack, TaxonomyConfig, ClassificationResult } from './types.js';

export interface ClassifierClient {
  readonly apiKey: string;
  readonly model: string;
}

export function createClassifier(apiKey: string, model: string): ClassifierClient {
  return { apiKey, model };
}

export async function classify(
  _client: ClassifierClient,
  _enriched: EnrichedTrack,
  _taxonomy: TaxonomyConfig,
): Promise<ClassificationResult> {
  throw new Error('classifier.ts stub — real implementation not yet present');
}
