import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { normalizeOpportunity, loadKeywordRules } from '../lib/normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const jobKeywordsPath = path.join(repoRoot, 'data', 'job-keywords.json');
const robotaUaMaxPages = 20;

const DEFAULT_URL = 'https://robota.ua/zapros/ai-engineer/ukraine/params;agency=false';

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

function buildPageUrl(baseUrl, pageNumber) {
  const url = new URL(baseUrl);
  const basePathname = url.pathname.replace(/;page=\d+/, '');
  url.pathname = pageNumber > 1 ? `${basePathname};page=${pageNumber}` : basePathname;
  return url.href;
}

async function scrapeRobotaUaList(page) {
  return page.evaluate(() => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const marker = [...document.querySelectorAll('span')].find(
      (el) => el.textContent.trim() === 'Рекомендовані вакансії',
    );

    return [...document.querySelectorAll('a.card.new-design-card')]
      .filter((card) => {
        if (!marker) return true;
        const position = card.compareDocumentPosition(marker);
        return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
      })
      .map((card) => {
        const title = clean(card.querySelector('h2')?.textContent);
        const href = card.getAttribute('href');
        const link = href ? new URL(href, document.location.href).href : null;

        const infoBlock = card.querySelector('h2')?.parentElement;
        const divs = [...(infoBlock?.children || [])].filter((el) => el.tagName === 'DIV');
        const salaryDiv = divs.find((div) => !div.className.includes('santa-items-center'));
        const companyLocationDiv = divs.find((div) => div.className.includes('santa-items-center'));

        const payment = clean(salaryDiv?.textContent) || null;
        const spans = companyLocationDiv
          ? [...companyLocationDiv.querySelectorAll('span')].filter((span) => span.textContent.trim())
          : [];
        const company = spans[0] ? clean(spans[0].textContent) || null : null;
        const location = spans[1] ? clean(spans[1].textContent) || null : null;
        const description = clean(card.querySelector('p.santa-typo-additional')?.textContent) || null;

        return { title, link, company, location, payment, description };
      })
      .filter((job) => job.title && job.link);
  });
}

async function discoverTotalPages(page) {
  return page.evaluate(() => {
    const numbers = [...document.querySelectorAll('a')]
      .filter((link) => /^[0-9]+$/.test(link.textContent.trim()))
      .map((link) => Number(link.textContent.trim()));
    return numbers.length ? Math.max(...numbers) : 1;
  });
}

/**
 * @param {{id: string, url?: string}} sourceConfig
 * @returns {Promise<import('../lib/normalize.js').Opportunity[]>}
 *
 * Known to be blocked by Cloudflare for headless/automated access — kept
 * `enabled: false` in config/sources.json. Ported for completeness; not
 * expected to return results while that block is in place.
 */
export async function fetchOpportunities(sourceConfig) {
  const url = sourceConfig.url || DEFAULT_URL;
  const jobKeywords = await loadJobKeywords();
  await loadKeywordRules();

  const browser = await chromium.launch();
  let allJobs;
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    const firstPageJobs = await scrapeRobotaUaList(page);
    const totalPages = Math.min(await discoverTotalPages(page), robotaUaMaxPages);
    allJobs = [...firstPageJobs];

    for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
      const pageUrl = buildPageUrl(url, pageNumber);

      const currentPage = await browser.newPage();
      try {
        await currentPage.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await currentPage.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
        allJobs.push(...(await scrapeRobotaUaList(currentPage)));
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
        payment: job.payment,
        description: job.description,
        tags: ['job'],
      }),
    );
  }

  console.log(
    `[robota-ua] listed=${seen.size} kept=${results.length} droppedBad=${droppedBad} droppedUncertain=${droppedUncertain}`,
  );

  return results;
}
