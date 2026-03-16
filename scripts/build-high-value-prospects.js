#!/usr/bin/env node
/**
 * Build high-value prospect list — plumbers, garage door, septic
 * Uses Google Places-style scraping from multiple directory sources
 * Target: 300 new DFW-area businesses
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.5',
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Load existing phone numbers to avoid duplicates
function loadExistingPhones() {
  const phones = new Set();
  for (let i = 1; i <= 20; i++) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', `dfw-batch-${i}.json`)));
      data.forEach(d => phones.add(d.phone.replace(/[^\d]/g, '')));
    } catch (e) {}
  }
  return phones;
}

// Normalize phone number
function normalizePhone(phone) {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

// Extract phone numbers from text
function extractPhones(text) {
  const patterns = [
    /\((\d{3})\)\s*(\d{3})[-.]\s*(\d{4})/g,
    /(\d{3})[-.]\s*(\d{3})[-.]\s*(\d{4})/g,
  ];
  const phones = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const digits = match[0].replace(/[^\d]/g, '');
      if (digits.length === 10) {
        // DFW area codes
        const areaCode = digits.substring(0, 3);
        if (['817', '682', '972', '469', '214', '940', '254', '903'].includes(areaCode)) {
          phones.add('+1' + digits);
        }
      }
    }
  }
  return [...phones];
}

// Scrape Yellow Pages for a query + location
async function scrapeYellowPages(query, location) {
  const results = [];
  for (let page = 1; page <= 5; page++) {
    try {
      const url = `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(query)}&geo_location_terms=${encodeURIComponent(location)}&page=${page}`;
      console.log(`  Scraping YP: ${query} in ${location} (page ${page})`);
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const $ = cheerio.load(data);

      $('.result').each((i, el) => {
        const name = $(el).find('.business-name span').text().trim() ||
                     $(el).find('.n a').text().trim() ||
                     $(el).find('a.business-name').text().trim();
        const phone = $(el).find('.phones').text().trim() ||
                      $(el).find('.phone').text().trim();

        if (name && phone) {
          const normalized = normalizePhone(phone);
          if (normalized) {
            results.push({ phone: normalized, businessName: `${name} ${location.split(',')[0]}`.trim() });
          }
        }
      });

      await sleep(2000 + Math.random() * 2000);
    } catch (err) {
      console.log(`  YP error (page ${page}): ${err.message}`);
      break;
    }
  }
  return results;
}

// Scrape Yelp search results
async function scrapeYelp(query, location) {
  const results = [];
  try {
    const url = `https://www.yelp.com/search?find_desc=${encodeURIComponent(query)}&find_loc=${encodeURIComponent(location)}`;
    console.log(`  Scraping Yelp: ${query} in ${location}`);
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);

    // Extract phone numbers from the page
    const phones = extractPhones(data);
    // Try to pair with business names from the page
    const names = [];
    $('a[href*="/biz/"]').each((i, el) => {
      const name = $(el).text().trim();
      if (name && name.length > 3 && name.length < 80 && !name.includes('Yelp')) {
        names.push(name);
      }
    });

    // Pair phones with names where possible
    phones.forEach((phone, idx) => {
      const name = names[idx] || `${query} ${location.split(',')[0]}`;
      results.push({ phone, businessName: name });
    });

    await sleep(3000 + Math.random() * 2000);
  } catch (err) {
    console.log(`  Yelp error: ${err.message}`);
  }
  return results;
}

// Scrape BBB directory
async function scrapeBBB(query, location) {
  const results = [];
  try {
    const url = `https://www.bbb.org/search?find_country=US&find_latlng=32.7555%2C-97.3308&find_loc=${encodeURIComponent(location)}&find_text=${encodeURIComponent(query)}&find_type=Category&page=1&sort=Relevance`;
    console.log(`  Scraping BBB: ${query} in ${location}`);
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });

    const phones = extractPhones(data);
    const $ = cheerio.load(data);

    $('a.text-blue-medium').each((i, el) => {
      const name = $(el).text().trim();
      if (name && phones[i]) {
        results.push({ phone: phones[i], businessName: name });
      }
    });

    await sleep(2000 + Math.random() * 2000);
  } catch (err) {
    console.log(`  BBB error: ${err.message}`);
  }
  return results;
}

async function main() {
  const existingPhones = loadExistingPhones();
  console.log(`📋 ${existingPhones.size} existing phone numbers loaded (will skip duplicates)\n`);

  const allProspects = [];
  const seenPhones = new Set(existingPhones);

  // High-value verticals
  const queries = [
    'plumber', 'plumbing', 'plumbing company', 'emergency plumber',
    'garage door repair', 'garage door company', 'garage door installation',
    'septic tank', 'septic service', 'septic pumping', 'septic repair',
    'drain cleaning', 'water heater repair', 'sewer repair',
  ];

  // DFW cities + surrounding
  const locations = [
    'Fort Worth, TX', 'Arlington, TX', 'Dallas, TX', 'Irving, TX',
    'Plano, TX', 'McKinney, TX', 'Frisco, TX', 'Denton, TX',
    'Weatherford, TX', 'Granbury, TX', 'Cleburne, TX', 'Burleson, TX',
    'Mansfield, TX', 'Keller, TX', 'Southlake, TX', 'Grapevine, TX',
    'Hurst, TX', 'Bedford, TX', 'Euless, TX', 'North Richland Hills, TX',
    'Haltom City, TX', 'Colleyville, TX', 'Trophy Club, TX', 'Roanoke, TX',
    'Crowley, TX', 'Benbrook, TX', 'Lake Worth, TX', 'Azle, TX',
    'Stephenville, TX', 'Mineral Wells, TX', 'Decatur, TX', 'Bridgeport, TX',
    'Waxahachie, TX', 'Midlothian, TX', 'Cedar Hill, TX', 'Duncanville, TX',
    'Grand Prairie, TX', 'Lewisville, TX', 'Flower Mound, TX', 'Carrollton, TX',
  ];

  for (const query of queries) {
    for (const location of locations) {
      if (allProspects.length >= 350) break;

      // Try Yellow Pages
      const ypResults = await scrapeYellowPages(query, location);
      for (const prospect of ypResults) {
        const digits = prospect.phone.replace(/[^\d]/g, '');
        if (!seenPhones.has(digits)) {
          seenPhones.add(digits);
          allProspects.push(prospect);
        }
      }

      // Every 5 combos, save progress
      if (allProspects.length > 0 && allProspects.length % 20 === 0) {
        console.log(`\n📊 Progress: ${allProspects.length} unique prospects found\n`);
      }

      if (allProspects.length >= 350) break;
    }
    if (allProspects.length >= 350) break;
  }

  // If we haven't hit 300 yet, try Yelp for the top queries
  if (allProspects.length < 300) {
    console.log(`\n📊 Only ${allProspects.length} from YP, trying Yelp...\n`);
    for (const query of ['plumber', 'garage door repair', 'septic service']) {
      for (const location of locations.slice(0, 15)) {
        const yelpResults = await scrapeYelp(query, location);
        for (const prospect of yelpResults) {
          const digits = prospect.phone.replace(/[^\d]/g, '');
          if (!seenPhones.has(digits)) {
            seenPhones.add(digits);
            allProspects.push(prospect);
          }
        }
        if (allProspects.length >= 350) break;
      }
      if (allProspects.length >= 350) break;
    }
  }

  // Save results
  const outputPath = path.join(__dirname, '..', 'data', 'dfw-batch-8-high-value.json');
  fs.writeFileSync(outputPath, JSON.stringify(allProspects, null, 2));
  console.log(`\n✅ Saved ${allProspects.length} prospects to ${outputPath}`);

  // Industry breakdown
  const industries = { plumber: 0, garage_door: 0, septic: 0, other: 0 };
  allProspects.forEach(p => {
    const name = p.businessName.toLowerCase();
    if (/plumb|drain|sewer|water heater/.test(name)) industries.plumber++;
    else if (/garage/.test(name)) industries.garage_door++;
    else if (/septic/.test(name)) industries.septic++;
    else industries.other++;
  });
  console.log('Industry breakdown:', JSON.stringify(industries, null, 2));
}

main().catch(err => console.error('Fatal:', err));
