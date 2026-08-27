import cron from 'node-cron';
import { runPipeline } from './pipeline.js';

/**
 * Wraps runPipeline() in a node-cron schedule with an in-memory overlap
 * guard — if a tick fires while the previous run is still going, it's
 * skipped rather than started concurrently.
 */
export function startScheduler(client, { schedule = process.env.CRON_SCHEDULE } = {}) {
  if (!schedule) throw new Error('CRON_SCHEDULE is not set');

  let running = false;

  return cron.schedule(schedule, async () => {
    if (running) {
      console.warn('[scheduler] previous pipeline run still in progress, skipping this tick');
      return;
    }
    running = true;
    try {
      await runPipeline(client);
    } catch (error) {
      console.error('[scheduler] pipeline run failed:', error);
    } finally {
      running = false;
    }
  });
}
