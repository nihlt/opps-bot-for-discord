import { chromium } from 'playwright';
import { cleanText, loadKeywordRules, normalizeOpportunity, tagsFromKeywords, uniqueStrings } from '../lib/normalize.js';

async function getAinSearchArticles(page) {
  return page.evaluate(() => {
    const seen = new Set();
    const articles = [];
    for (const link of document.querySelectorAll('a[href]')) {
      const text = link.innerText.trim().replace(/\s+/g, ' ');
      const href = link.href;
      if (!text.toLowerCase().includes('можливості тижня')) continue;
      if (!href.startsWith('https://ain.ua/20')) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      articles.push({ title: text, url: href });
    }
    return articles;
  });
}

async function scrapeAinArticle(browser, article) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 2000 } });
  try {
    await page.goto(article.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    return await page.evaluate((sourceArticle) => {
      const clean = (value) =>
        String(value ?? '')
          .replace(/ /g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      const absolutize = (href) => {
        try {
          return new URL(href, document.location.href).href;
        } catch {
          return href;
        }
      };
      const isArticleInternalLink = (href) =>
        href.includes('/author/') ||
        href.includes('/tag/') ||
        href.includes('/business/') ||
        href.includes('/technology/') ||
        href.includes('/startups/') ||
        href.includes('facebook.com/sharer') ||
        href.includes('twitter.com/intent');
      const isDetailLink = (link) => {
        const linkText = link.innerText.trim().toLowerCase();
        const parentText = link.parentElement?.innerText?.trim().toLowerCase() || '';
        return /посилан/.test(linkText) || /детал(і|ьніше).*посилан/.test(parentText);
      };

      const articleRoot =
        document.querySelector('.post-content') ||
        document.querySelector('.article-content__wrapper') ||
        document.querySelector('.article-main') ||
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body;
      const articleTitle =
        document.querySelector('article h1, h1')?.innerText?.trim() || sourceArticle.title || document.title;

      const events = [];
      const headings = [...articleRoot.querySelectorAll('h2')];

      for (const heading of headings) {
        const title = clean(heading.innerText);
        if (!title || title.endsWith(':')) continue;

        const nodes = [];
        let current = heading.nextElementSibling;
        while (current) {
          if (current.tagName === 'H2' && !current.innerText.trim().endsWith(':')) break;
          nodes.push(current);
          current = current.nextElementSibling;
        }

        const sectionText = clean(nodes.map((node) => node.innerText).filter(Boolean).join('\n\n'));
        if (sectionText.length < 50) continue;

        const detailLinkElement =
          nodes.flatMap((node) => [...node.querySelectorAll('a[href]')]).find(isDetailLink) ||
          nodes.flatMap((node) => [...node.querySelectorAll('a[href]')]).find((link) => {
            const href = absolutize(link.getAttribute('href'));
            return href && !href.includes('ain.ua') && !isArticleInternalLink(href);
          });
        const detailHref = detailLinkElement?.getAttribute('href');
        const detailLink = detailHref ? absolutize(detailHref) : sourceArticle.url;

        const description = clean(
          sectionText
            .replace(/Детал(і|ьніше)( про програму та як на неї податися)?\s+—\s+за посиланням\.?/gi, '')
            .replace(/Деталі\s+—\s+за посиланням\.?/gi, '')
            .replace(/Детальніше\s+—\s+за посиланням\.?/gi, ''),
        )
          .split(/\n+Читайте також:/i)[0]
          .trim();

        events.push({
          title,
          link: detailLink,
          description,
          sourceArticleTitle: articleTitle,
          sourceArticleUrl: sourceArticle.url,
        });
      }

      return { articleTitle, events };
    }, article);
  } finally {
    await page.close();
  }
}

async function scrapeAinOpportunities(browser, searchPage) {
  const articles = await getAinSearchArticles(searchPage);
  const articleResults = [];
  for (const article of articles) {
    articleResults.push(await scrapeAinArticle(browser, article));
  }
  return articleResults.flatMap((article) => article.events);
}

/** @type {import('./index.js').SourceModule['fetchOpportunities']} */
export async function fetchOpportunities(sourceConfig) {
  await loadKeywordRules();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 2000 } });
    await page.goto(sourceConfig.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    const rawEvents = await scrapeAinOpportunities(browser, page);
    return rawEvents.map((raw) =>
      normalizeOpportunity({
        sourceId: sourceConfig.id,
        kind: 'event',
        title: raw.title,
        link: raw.link,
        description: raw.description,
        tags: uniqueStrings(['news', ...tagsFromKeywords(`${raw.title}\n${raw.description}`)]),
      }),
    );
  } finally {
    await browser.close();
  }
}
