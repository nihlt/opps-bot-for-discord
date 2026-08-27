import { chromium } from 'playwright';
import { normalizeOpportunity, loadKeywordRules } from '../lib/normalize.js';

const DEFAULT_URL = 'https://university.kse.ua/university-news';

async function scrapeKseNews(page) {
  return page.evaluate(() => {
    const absolutize = (href) => {
      try {
        return new URL(href, document.location.href).href;
      } catch {
        return href;
      }
    };

    const seen = new Set();
    const events = [];

    for (const node of document.querySelectorAll('article.article_3aa, article')) {
      const text = node.innerText?.trim();
      if (!text || text.length < 40) continue;

      // querySelector on a comma-list returns the first DOM-order match across
      // ALL alternatives, not the first alternative that matches — so a bare
      // `a[href*="/university-news/"]` picks up the card's image-wrapper link
      // (empty innerText) before it ever reaches the real title anchor lower
      // in the markup. Filter to the anchor that actually has visible text.
      const newsAnchors = [...node.querySelectorAll('a[href*="/university-news/"]')];
      const titleLink = newsAnchors.find((a) => a.innerText?.trim()) || newsAnchors[0];
      const title =
        titleLink?.innerText?.trim() ||
        node.querySelector('h1, h2, h3, .article__title_kCs')?.innerText?.trim();
      const href = titleLink?.getAttribute('href');
      const link = href ? absolutize(href) : null;
      const date =
        node.querySelector('time')?.getAttribute('datetime') ||
        node.querySelector('time, .article__date_2SL, [class*="date"]')?.innerText?.trim() ||
        text.split('\n').map((line) => line.trim()).find((line) => /^\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}$/.test(line)) ||
        '';

      if (!title || !link || !link.includes('/university-news/')) continue;
      const key = `${title}|${link}`;
      if (seen.has(key)) continue;
      seen.add(key);

      events.push({
        title,
        link,
        date,
        description: node.querySelector('.article__description_1Pk, p')?.innerText?.trim() || null,
      });
    }

    return events;
  });
}

/** @type {import('./index.js').SourceModule['fetchOpportunities']} */
export async function fetchOpportunities(sourceConfig) {
  await loadKeywordRules();
  const url = sourceConfig.url || DEFAULT_URL;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // The news grid is populated client-side after domcontentloaded fires,
    // so evaluating immediately reads an empty/skeleton DOM.
    await page
      .locator('a[href*="/university-news/"]')
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .catch(() => {});
    const rawEvents = await scrapeKseNews(page);
    const scrapedAt = new Date().toISOString();
    return rawEvents.map((raw) =>
      normalizeOpportunity(
        {
          sourceId: sourceConfig.id,
          kind: 'event',
          title: raw.title,
          link: raw.link,
          date: raw.date,
          description: raw.description,
          tags: ['KSE', 'news'],
        },
        { scrapedAt },
      ),
    );
  } finally {
    await browser.close();
  }
}
