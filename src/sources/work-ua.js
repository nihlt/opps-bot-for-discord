import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { normalizeOpportunity, loadKeywordRules } from '../lib/normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const jobKeywordsPath = path.join(repoRoot, 'data', 'job-keywords.json');
const workUaMaxPages = 20;

const DEFAULT_URL = 'https://www.work.ua/jobs-it-ai+engineer/?notitle=1&category=1&days=125';

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

async function scrapeWorkUaList(page) {
  return page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

    return [...document.querySelectorAll('div.job-link')]
      .map((card) => {
        const titleLink = card.querySelector('h2 a[href]');
        const title = clean(titleLink?.textContent);
        const href = titleLink?.getAttribute('href');
        const link = href ? new URL(href, document.location.href).href : null;

        const container = card.querySelector('.text-indent');
        const rawCompany = clean(container?.querySelector('.strong-600')?.textContent);
        const looksLikeSalary = /\d/.test(rawCompany);
        const company = rawCompany && !looksLikeSalary ? rawCompany : null;

        let location = null;
        if (container) {
          const clone = container.cloneNode(true);
          clone.querySelectorAll('.strong-600, ul, .glyphicon, .distance-block').forEach((el) => el.remove());
          location = clean(clone.textContent).replace(/^,\s*/, '').replace(/,\s*$/, '') || null;
          if (location && /^(вища|неповна вища|середня|базова)/i.test(location)) location = null;
        }

        const description = clean(card.querySelector('p.ellipsis')?.textContent) || null;
        const datetimeAttr = card.querySelector('time')?.getAttribute('datetime') || null;
        const date = datetimeAttr ? datetimeAttr.split(' ')[0] : null;

        return { title, link, company, location, description, date };
      })
      .filter((job) => job.title && job.link);
  });
}

async function discoverTotalPages(page) {
  return page.evaluate(() => {
    const numbers = [...document.querySelectorAll('.pagination a[title]')]
      .map((link) => Number((link.getAttribute('title') || '').match(/\d+/)?.[0]))
      .filter((value) => Number.isInteger(value));
    return numbers.length ? Math.max(...numbers) : 1;
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
  let allJobs;
  try {
    const baseUrl = new URL(url);
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    const firstPageJobs = await scrapeWorkUaList(page);
    const totalPages = Math.min(await discoverTotalPages(page), workUaMaxPages);
    allJobs = [...firstPageJobs];

    for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
      const pageUrl = new URL(baseUrl);
      pageUrl.searchParams.set('page', String(pageNumber));

      const currentPage = await browser.newPage();
      try {
        await currentPage.goto(pageUrl.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await currentPage.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
        allJobs.push(...(await scrapeWorkUaList(currentPage)));
      } finally {
        await currentPage.close();
      }
    }
  } finally {
    await browser.close();
  }

  const seen = new Set();
  const results = [];
  let droppedBad = 0;
  let droppedUncertain = 0;

  for (const job of allJobs) {
    if (seen.has(job.link)) continue;
    seen.add(job.link);

    const verdict = classifyJobTitle(job.title, jobKeywords);
    if (verdict === 'bad') {
      droppedBad += 1;
      continue;
    }
    if (verdict === 'uncertain') {
      droppedUncertain += 1;
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
        date: job.date,
        tags: ['job'],
      }),
    );
  }

  console.log(
    `[work-ua] listed=${seen.size} kept=${results.length} droppedBad=${droppedBad} droppedUncertain=${droppedUncertain}`,
  );

  return results;
}
