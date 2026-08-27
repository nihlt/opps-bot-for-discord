import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { normalizeOpportunity, loadKeywordRules } from '../lib/normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const jobKeywordsPath = path.join(repoRoot, 'data', 'job-keywords.json');

const DEFAULT_URL =
  'https://djinni.co/jobs/?all_keywords=ai%20engineer&search_type=basic-search&exp_level=no_exp&exp_level=1y';

async function loadJobKeywords() {
  const keywords = JSON.parse(await readFile(jobKeywordsPath, 'utf8'));
  return {
    good: (keywords.good || []).map((word) => word.toLowerCase()),
    bad: (keywords.bad || []).map((word) => word.toLowerCase()),
  };
}

function classifyJobTitle(title, { good, bad }) {
  const lower = title.toLowerCase();
  if (bad.some((word) => lower.includes(word))) return 'bad';
  if (good.some((word) => lower.includes(word))) return 'good';
  return 'uncertain';
}

async function scrapeDjinniList(page) {
  return page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

    return [...document.querySelectorAll('.job-item')]
      .map((card) => {
        const titleLink = card.querySelector('a.job_item__header-link[href]');
        const title = clean(card.querySelector('.job-item__position')?.textContent);
        const href = titleLink?.getAttribute('href');
        const link = href ? new URL(href, document.location.href).href : null;

        const company =
          clean(card.querySelector('.job-item__position')?.parentElement?.querySelector('span')?.textContent) ||
          null;

        const infoSpans = [...card.querySelectorAll('.fw-medium.d-flex.flex-wrap > span.text-nowrap')];
        const location = infoSpans.map((el) => clean(el.textContent)).filter(Boolean).join(', ') || null;

        const description = clean(card.querySelector('.js-truncated-text')?.textContent) || null;

        return { title, link, company, location, description };
      })
      .filter((job) => job.title && job.link);
  });
}

/**
 * @param {{id: string, url?: string}} sourceConfig
 * @returns {Promise<import('../lib/normalize.js').Opportunity[]>}
 */
export async function fetchOpportunities(sourceConfig) {
  const url = sourceConfig.url || DEFAULT_URL;
  const jobKeywords = await loadJobKeywords();
  await loadKeywordRules();

  const browser = await chromium.launch();
  let jobs;
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    jobs = await scrapeDjinniList(page);
  } finally {
    await browser.close();
  }

  const seen = new Set();
  const results = [];
  let droppedBad = 0;
  let droppedUncertain = 0;
  const droppedExamples = [];

  for (const job of jobs) {
    if (seen.has(job.link)) continue;
    seen.add(job.link);

    const verdict = classifyJobTitle(job.title, jobKeywords);
    if (verdict === 'bad') {
      droppedBad += 1;
      if (droppedExamples.length < 3) droppedExamples.push({ title: job.title, verdict });
      continue;
    }
    if (verdict === 'uncertain') {
      droppedUncertain += 1;
      if (droppedExamples.length < 3) droppedExamples.push({ title: job.title, verdict });
      continue;
    }

    results.push(
      normalizeOpportunity({
        sourceId: sourceConfig.id,
        kind: 'job',
        title: job.title,
        link: job.link,
        company: job.company,
        location: job.location,
        description: job.description,
        tags: ['job'],
      }),
    );
  }

  console.log(
    `[djinni] listed=${seen.size} kept=${results.length} droppedBad=${droppedBad} droppedUncertain=${droppedUncertain}`,
  );
  if (droppedExamples.length) console.log('[djinni] dropped examples:', droppedExamples);

  return results;
}
