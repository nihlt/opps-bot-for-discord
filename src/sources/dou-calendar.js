import { chromium } from 'playwright';
import { cleanText, loadKeywordRules, normalizeOpportunity, tagsFromKeywords, uniqueStrings } from '../lib/normalize.js';

const MAX_PAGES = 50;

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch {
    return cleanText(value);
  }
}

function douEventKey(event) {
  return canonicalUrl(event.link) || [event.title, event.link].map(cleanText).join('|');
}

function mergeDouEvents(events) {
  const byKey = new Map();
  for (const event of events) {
    const key = douEventKey(event);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, event);
      continue;
    }
    byKey.set(key, {
      ...existing,
      description: existing.description || event.description,
      location: existing.location || event.location,
      payment: existing.payment || event.payment,
      tags: uniqueStrings([...(existing.tags || []), ...(event.tags || [])]),
    });
  }
  return [...byKey.values()];
}

async function scrapeDouCalendarList(page) {
  return page.evaluate(() => {
    const absolutize = (href) => {
      try {
        return new URL(href, document.location.href).href;
      } catch {
        return href;
      }
    };

    const parseWhenAndWhere = (node) => {
      const block = node.querySelector('.when-and-where');
      if (!block) return { date: '', location: '', payment: '' };
      const date = block.querySelector('.date')?.innerText?.trim() || '';
      const payment = [...block.querySelectorAll('span')]
        .filter((span) => !span.classList.contains('date'))
        .map((span) => span.innerText.trim())
        .filter(Boolean)
        .join(' ');
      const location = [...block.childNodes]
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent.trim())
        .filter(Boolean)
        .join(' ');
      return { date, location, payment };
    };

    const seen = new Set();
    const events = [];

    for (const node of document.querySelectorAll('article.b-postcard')) {
      const text = node.innerText?.trim();
      if (!text || text.length < 40) continue;

      const eventLink = node.querySelector('h1 a, h2 a, h3 a, h4 a, .title a, a[href*="/calendar/"]');
      const title = eventLink?.innerText?.trim();
      const href = eventLink?.getAttribute('href');
      const link = href ? absolutize(href) : null;
      if (!title || !link) continue;

      const key = `${title}|${link}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const whenAndWhere = parseWhenAndWhere(node);
      events.push({
        title,
        link,
        date: whenAndWhere.date,
        description: node.querySelector('.b-typo, .descr, .description, p')?.innerText?.trim() || '',
        location: whenAndWhere.location,
        payment: whenAndWhere.payment,
        tags: [...node.querySelectorAll('a[href*="/calendar/tags/"], .tag')]
          .map((tag) => tag.innerText.trim())
          .filter(Boolean),
      });
    }

    return events;
  });
}

async function discoverDouCalendarPageUrls(page, sourceUrl) {
  return page.evaluate(({ sourceUrl }) => {
    const cleanUrl = (value) => {
      const url = new URL(value, document.location.href);
      url.hash = '';
      url.search = '';
      return url;
    };
    const source = cleanUrl(sourceUrl);
    const tagMatch = source.pathname.match(/^\/calendar\/tags\/[^/]+\/(?:\d+\/)?$/);
    const tagBasePath = tagMatch ? source.pathname.replace(/(?:\d+\/)?$/, '') : null;

    const pageNumber = (pathname) => {
      if (tagBasePath) {
        if (pathname === tagBasePath) return 1;
        const match = pathname.match(new RegExp(`^${tagBasePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)/$`));
        return match ? Number(match[1]) : null;
      }
      if (pathname === '/calendar/') return 1;
      const match = pathname.match(/^\/calendar\/page-(\d+)\/$/);
      return match ? Number(match[1]) : null;
    };

    const isSameCalendarSection = (url) => {
      if (url.origin !== source.origin) return false;
      if (tagBasePath) {
        return url.pathname === tagBasePath || new RegExp(`^${tagBasePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+/$`).test(url.pathname);
      }
      return url.pathname === '/calendar/' || /^\/calendar\/page-\d+\/$/.test(url.pathname);
    };

    return [document.location.href, ...[...document.querySelectorAll('a[href]')].map((link) => link.href)]
      .map(cleanUrl)
      .filter(isSameCalendarSection)
      .map((url) => ({ url: url.href, pageNumber: pageNumber(url.pathname) }))
      .filter((item) => Number.isInteger(item.pageNumber) && item.pageNumber > 0);
  }, { sourceUrl });
}

async function scrapeDouEventDetails(browser, event) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1800 } });
  try {
    await page.goto(event.link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    return await page.evaluate(() => {
      const clean = (value) =>
        String(value ?? '')
          .replace(/ /g, ' ')
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

      const parseWhenAndWhere = () => {
        const block = document.querySelector('.when-and-where');
        if (!block) return { date: '', location: '', payment: '' };
        const date = block.querySelector('.date')?.innerText?.trim() || '';
        const payment = [...block.querySelectorAll('span')]
          .filter((span) => !span.classList.contains('date'))
          .map((span) => span.innerText.trim())
          .filter(Boolean)
          .join(' ');
        const location = [...block.childNodes]
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.textContent.trim())
          .filter(Boolean)
          .join(' ');
        return { date, location, payment };
      };

      const calendarLink = [...document.querySelectorAll('a.b-plus-calendar.__google[href], a[href]')]
        .map((link) => ({ text: clean(link.innerText), href: absolutize(link.getAttribute('href')) }))
        .find((link) =>
          link.href.includes('google.com/calendar/event?action=TEMPLATE') ||
          /google calendar/i.test(link.text) ||
          link.href.includes('google.com/calendar/event') ||
          link.href.includes('calendar.google.com/calendar/render'),
        )?.href || '';

      const tags = [...document.querySelectorAll('a[href*="/calendar/tags/"], .tag')]
        .map((tag) => clean(tag.innerText))
        .filter(Boolean);
      const description =
        clean(document.querySelector('.b-typo')?.innerText) ||
        clean(document.querySelector('meta[property="og:description"]')?.getAttribute('content')) ||
        clean([...document.querySelectorAll('article p, main p, p')]
          .map((node) => node.innerText)
          .filter(Boolean)
          .slice(0, 4)
          .join('\n\n'));
      const whenAndWhere = parseWhenAndWhere();

      return { calendar: calendarLink, tags, description, date: whenAndWhere.date, location: whenAndWhere.location, payment: whenAndWhere.payment };
    });
  } finally {
    await page.close();
  }
}

async function scrapeDouCalendar(browser, page, sourceUrl) {
  const queuedUrls = new Set([canonicalUrl(page.url())]);
  const visitedUrls = new Set();
  const queue = [page.url()];
  const allListEvents = [];

  while (queue.length && visitedUrls.size < MAX_PAGES) {
    const url = queue.shift();
    const canonicalPageUrl = canonicalUrl(url);
    if (visitedUrls.has(canonicalPageUrl)) continue;

    const currentPage = visitedUrls.size === 0 ? page : await browser.newPage({ viewport: { width: 1440, height: 1400 } });
    if (visitedUrls.size > 0) {
      await currentPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await currentPage.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    }
    visitedUrls.add(canonicalPageUrl);

    const [listEvents, discoveredPages] = await Promise.all([
      scrapeDouCalendarList(currentPage),
      discoverDouCalendarPageUrls(currentPage, sourceUrl),
    ]);
    allListEvents.push(...listEvents);

    for (const discovered of discoveredPages.sort((a, b) => a.pageNumber - b.pageNumber)) {
      const canonicalDiscoveredUrl = canonicalUrl(discovered.url);
      if (queuedUrls.has(canonicalDiscoveredUrl) || visitedUrls.has(canonicalDiscoveredUrl)) continue;
      queuedUrls.add(canonicalDiscoveredUrl);
      queue.push(discovered.url);
    }

    if (currentPage !== page) await currentPage.close();
  }

  const listEvents = mergeDouEvents(allListEvents);
  const enrichedEvents = [];
  for (const event of listEvents) {
    const detail = await scrapeDouEventDetails(browser, event);
    enrichedEvents.push({
      ...event,
      date: cleanText(detail.date) || event.date,
      description: cleanText(detail.description) || event.description,
      location: cleanText(detail.location) || event.location,
      payment: cleanText(detail.payment) || event.payment,
      calendar: cleanText(detail.calendar) || null,
      tags: uniqueStrings([...(event.tags || []), ...(detail.tags || [])]),
    });
  }

  return enrichedEvents;
}

/** @type {import('./index.js').SourceModule['fetchOpportunities']} */
export async function fetchOpportunities(sourceConfig) {
  await loadKeywordRules();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
    await page.goto(sourceConfig.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

    const rawEvents = await scrapeDouCalendar(browser, page, sourceConfig.url);
    return rawEvents.map((raw) =>
      normalizeOpportunity({
        sourceId: sourceConfig.id,
        kind: 'event',
        title: raw.title,
        link: raw.link,
        date: raw.date,
        description: raw.description,
        location: raw.location,
        payment: raw.payment,
        calendar: raw.calendar,
        tags: uniqueStrings([sourceConfig.tag, ...(raw.tags || []), ...tagsFromKeywords(raw.title)]),
      }),
    );
  } finally {
    await browser.close();
  }
}
