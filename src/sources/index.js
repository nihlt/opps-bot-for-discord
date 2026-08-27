import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const sourcesConfigPath = path.join(repoRoot, 'config', 'sources.json');

/** Reads config/sources.json — every registered source, enabled or not. */
export async function loadSourceConfigs() {
  return JSON.parse(await readFile(sourcesConfigPath, 'utf8'));
}

export async function loadEnabledSources() {
  const configs = await loadSourceConfigs();
  return configs.filter((config) => config.enabled);
}

/** Dispatches one source config to its module's fetchOpportunities(sourceConfig). */
export async function fetchFromSource(sourceConfig) {
  const module = await import(`./${sourceConfig.module}`);
  return module.fetchOpportunities(sourceConfig);
}
