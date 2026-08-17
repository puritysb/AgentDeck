// Type surface of generate-model-provider.mjs for the vitest drift gate.
import type { ModelProvider } from '../shared/src/model-provider.js';

export interface ModelProviderRuleSet {
  providers: string[];
  labels: Readonly<Record<string, string>>;
  markers: Array<[ModelProvider, string[]]>;
  vendorPrefixes: Readonly<Record<string, ModelProvider>>;
  harnessNative: Readonly<Record<string, ModelProvider>>;
}

export declare function emitSwift(rules: ModelProviderRuleSet): string;
export declare function emitKotlin(rules: ModelProviderRuleSet): string;
export declare function loadRules(): Promise<ModelProviderRuleSet>;
export declare const OUTPUTS: ReadonlyArray<
  readonly [string, (rules: ModelProviderRuleSet) => string]
>;
