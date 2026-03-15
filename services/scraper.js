const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Scraper Service - Fetches and extracts business data from prospect websites
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Fetch a single page and return cheerio-parsed HTML
 */
async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': USER_AGENT },
    maxRedirects: 3,
    validateStatus: (s) => s < 400
  });
  return cheerio.load(response.data);
}

/**
 * Extract phone numbers from text
 */
function extractPhones(text) {
  const pattern = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const matches = text.match(pattern) || [];
  return [...new Set(matches)];
}

/**
 * Extract hours-like text
 */
function extractHours(text) {
  const patterns = [
    /(?:hours|open|schedule)[:\s]*([^\n]{10,80})/i,
    /(mon(?:day)?[\s\-–]+(?:fri|sat|sun)[^\n]{5,60})/i,
    /(\d{1,2}\s*(?:am|pm)\s*[-–]\s*\d{1,2}\s*(?:am|pm)[^\n]{0,40})/i,
    /(24\s*\/?\s*7[^\n]{0,40})/i
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().substring(0, 120);
  }
  return null;
}

/**
 * Check for emergency service mentions
 */
function hasEmergencyService(text) {
  const keywords = ['24/7', '24 hours', 'emergency', 'after hours', 'after-hours', 'urgent', 'same day', 'same-day'];
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

/**
 * Find internal nav links for /contact, /services, /about pages
 */
function findNavLinks($, baseUrl) {
  const links = [];
  const patterns = [/contact/i, /services/i, /about/i];
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    for (const pattern of patterns) {
      const text = $(el).text().trim();
      if (pattern.test(href) || pattern.test(text)) {
        try {
          const resolved = new URL(href, baseUrl).href;
          const host = new URL(baseUrl).host;
          if (new URL(resolved).host === host && !seen.has(resolved)) {
            seen.add(resolved);
            links.push(resolved);
          }
        } catch (e) { /* invalid URL */ }
      }
    }
  });

  return links.slice(0, 3);
}

/**
 * Extract structured data from a cheerio-loaded page
 */
function extractPageData($, url) {
  const title = $('title').first().text().trim();
  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const ogSiteName = $('meta[property="og:site_name"]').attr('content') || '';
  const ogImage = $('meta[property="og:image"]').attr('content') || '';

  const headings = [];
  $('h1, h2').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length < 200) headings.push(t);
  });

  // Get nav items
  const navItems = [];
  $('nav a, header a').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length < 60 && t.length > 1) navItems.push(t);
  });

  // Get body text (limited)
  $('script, style, noscript, iframe').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 8000);

  // Phone from tel: links
  const telPhones = [];
  $('a[href^="tel:"]').each((_, el) => {
    telPhones.push($(el).attr('href').replace('tel:', '').trim());
  });

  // Footer text for address/hours
  const footerText = $('footer').text().replace(/\s+/g, ' ').trim().substring(0, 1500);

  // FAQs from structured sections
  const faqs = [];
  $('details, [class*="faq"], [class*="accordion"], [id*="faq"]').each((_, el) => {
    const q = $(el).find('summary, [class*="question"], h3, h4').first().text().trim();
    const a = $(el).find('p, [class*="answer"], div').first().text().trim();
    if (q && a && q.length < 200 && a.length < 500) {
      faqs.push({ q, a });
    }
  });

  // Try to find logo
  let logoUrl = '';
  const logoImg = $('header img, [class*="logo"] img, a[class*="logo"] img').first();
  if (logoImg.length) {
    try {
      logoUrl = new URL(logoImg.attr('src'), url).href;
    } catch (e) { /* ignore */ }
  }

  // Try to extract brand color from inline styles or CSS
  let brandColor = '';
  const styleText = $('style').text();
  const colorMatch = styleText.match(/(?:--primary|--brand|--main)[^:]*:\s*(#[0-9a-fA-F]{3,8})/);
  if (colorMatch) brandColor = colorMatch[1];

  return {
    url,
    title,
    metaDesc,
    ogSiteName,
    ogImage,
    headings,
    navItems,
    bodyText,
    footerText,
    telPhones,
    textPhones: extractPhones(bodyText + ' ' + footerText),
    hours: extractHours(bodyText + ' ' + footerText),
    hasEmergency: hasEmergencyService(bodyText),
    faqs,
    logoUrl,
    brandColor
  };
}

/**
 * Main scrape function — fetches homepage + up to 2 subpages
 */
async function scrapeSite(url) {
  // Normalize URL
  if (!url.startsWith('http')) url = 'https://' + url;

  console.log(`🔍 Scraping: ${url}`);

  const pages = [];

  // 1. Fetch homepage
  try {
    const $ = await fetchPage(url);
    const homeData = extractPageData($, url);
    pages.push(homeData);

    // 2. Find and fetch subpages
    const subLinks = findNavLinks($, url);
    for (const link of subLinks) {
      try {
        await new Promise(r => setTimeout(r, 1000)); // 1s delay between requests
        const sub$ = await fetchPage(link);
        pages.push(extractPageData(sub$, link));
      } catch (err) {
        console.log(`⚠️ Could not fetch ${link}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`❌ Failed to scrape ${url}: ${err.message}`);
    throw new Error(`Could not fetch website: ${err.message}`);
  }

  // 3. Merge all page data into a single object
  const merged = {
    url,
    pages: pages.length,
    title: pages[0].title,
    metaDesc: pages[0].metaDesc,
    ogSiteName: pages[0].ogSiteName,
    ogImage: pages[0].ogImage,
    logoUrl: pages.find(p => p.logoUrl)?.logoUrl || '',
    brandColor: pages.find(p => p.brandColor)?.brandColor || '',
    headings: [...new Set(pages.flatMap(p => p.headings))],
    navItems: [...new Set(pages.flatMap(p => p.navItems))],
    phones: [...new Set([...pages.flatMap(p => p.telPhones), ...pages.flatMap(p => p.textPhones)])],
    hours: pages.find(p => p.hours)?.hours || null,
    hasEmergency: pages.some(p => p.hasEmergency),
    faqs: pages.flatMap(p => p.faqs).slice(0, 10),
    // Combined text for AI extraction (truncated)
    combinedText: pages.map(p => `--- ${p.url} ---\nTitle: ${p.title}\n${p.metaDesc}\nHeadings: ${p.headings.join(' | ')}\n${p.bodyText.substring(0, 3000)}`).join('\n\n').substring(0, 8000)
  };

  console.log(`✅ Scraped ${merged.pages} page(s) from ${url} — ${merged.headings.length} headings, ${merged.phones.length} phones`);
  return merged;
}

module.exports = { scrapeSite };
