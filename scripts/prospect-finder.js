#!/usr/bin/env node
/**
 * Prospect Finder — Scrapes business phone numbers from the web
 * for the AI Always Answer outbound calling pipeline.
 * 
 * Usage: node scripts/prospect-finder.js [--city "Fort Worth TX"] [--category "HVAC"] [--output prospects.json]
 * 
 * Categories: HVAC, plumber, electrician, roofing, pest control, lawn care, 
 *             fence, garage door, foundation repair, painting, remodeling,
 *             pool service, locksmith, appliance repair, tree service,
 *             carpet cleaning, pressure washing, handyman, concrete,
 *             septic, water damage, glass repair, flooring
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// All home service categories
const HOME_SERVICE_CATEGORIES = [
  'HVAC', 'plumber', 'electrician', 'roofing contractor', 'pest control',
  'lawn care', 'fence company', 'garage door repair', 'foundation repair',
  'house painter', 'remodeling contractor', 'pool service', 'locksmith',
  'appliance repair', 'tree service', 'carpet cleaning', 'pressure washing',
  'handyman', 'concrete contractor', 'septic service', 'water damage restoration',
  'glass repair', 'flooring installer', 'gutter installation', 'insulation contractor',
  'chimney sweep', 'maid service', 'junk removal', 'moving company', 'window cleaning'
];

// DFW cities to search
const DFW_CITIES = [
  'Fort Worth TX', 'Arlington TX', 'Weatherford TX', 'Burleson TX',
  'Mansfield TX', 'Keller TX', 'Southlake TX', 'Grapevine TX',
  'Hurst TX', 'Bedford TX', 'Euless TX', 'North Richland Hills TX',
  'Haltom City TX', 'Benbrook TX', 'Azle TX', 'Crowley TX',
  'White Settlement TX', 'Saginaw TX', 'Lake Worth TX', 'Granbury TX'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

/**
 * Extract phone numbers from a webpage
 */
function extractPhones(html) {
  const phones = new Set();
  
  // tel: links
  const telMatches = html.match(/href=["']tel:\+?1?(\d{10})["']/g) || [];
  for (const m of telMatches) {
    const num = m.replace(/\D/g, '').slice(-10);
    if (num.length === 10) phones.add(num);
  }
  
  // Phone patterns in text
  const textPatterns = html.match(/[\(]?\d{3}[\)]?[\s.\-]?\d{3}[\s.\-]?\d{4}/g) || [];
  for (const p of textPatterns) {
    const num = p.replace(/\D/g, '').slice(-10);
    if (num.length === 10 && !num.startsWith('000') && !num.startsWith('123') && !num.startsWith('555')) {
      phones.add(num);
    }
  }
  
  return [...phones];
}

/**
 * Extract business name from a webpage
 */
function extractBusinessName(html, url) {
  const $ = cheerio.load(html);
  
  // Try og:site_name first
  const ogName = $('meta[property="og:site_name"]').attr('content');
  if (ogName && ogName.length < 60) return ogName.trim();
  
  // Try title tag
  const title = $('title').text().split(/[|\-–—]/)[0].trim();
  if (title && title.length < 60) return title;
  
  // Try h1
  const h1 = $('h1').first().text().trim();
  if (h1 && h1.length < 60) return h1;
  
  // Fallback to domain
  try {
    return new URL(url).hostname.replace('www.', '').split('.')[0];
  } catch {
    return 'Unknown Business';
  }
}

/**
 * Search Yelp for businesses (no API key needed for basic search)
 */
async function searchYelp(category, city) {
  const results = [];
  const query = encodeURIComponent(`${category} ${city}`);
  
  try {
    const { data: html } = await axios.get(
      `https://www.yelp.com/search?find_desc=${encodeURIComponent(category)}&find_loc=${encodeURIComponent(city)}`,
      { headers: HEADERS, timeout: 10000 }
    );
    
    const $ = cheerio.load(html);
    
    // Extract business links from Yelp results
    $('a[href*="/biz/"]').each((i, el) => {
      const href = $(el).attr('href');
      const name = $(el).text().trim();
      if (href && name && name.length > 2 && name.length < 80 && !href.includes('ad_business')) {
        const bizSlug = href.split('/biz/')[1]?.split('?')[0];
        if (bizSlug) {
          results.push({ name, yelpUrl: `https://www.yelp.com/biz/${bizSlug}` });
        }
      }
    });
    
    // Deduplicate by yelp URL
    const seen = new Set();
    return results.filter(r => {
      if (seen.has(r.yelpUrl)) return false;
      seen.add(r.yelpUrl);
      return true;
    }).slice(0, 15);
  } catch (err) {
    console.error(`  ⚠️  Yelp search failed for "${category} ${city}": ${err.message}`);
    return [];
  }
}

/**
 * Get phone number from a Yelp business page
 */
async function getYelpPhone(yelpUrl) {
  try {
    const { data: html } = await axios.get(yelpUrl, { headers: HEADERS, timeout: 8000 });
    const phones = extractPhones(html);
    
    // Also try to get the business website
    const $ = cheerio.load(html);
    let website = null;
    $('a[href*="biz_redir"]').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('url=')) {
        try {
          const url = new URL(href, 'https://www.yelp.com');
          website = url.searchParams.get('url');
        } catch {}
      }
    });
    
    return { phones, website };
  } catch {
    return { phones: [], website: null };
  }
}

/**
 * Get phone from a business website directly
 */
async function getWebsitePhone(url) {
  try {
    const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 8000, maxRedirects: 3 });
    const phones = extractPhones(html);
    const name = extractBusinessName(html, url);
    return { phones, name };
  } catch {
    return { phones: [], name: null };
  }
}

/**
 * Main prospect finder — searches multiple sources for businesses
 */
async function findProspects(categories, cities, maxPerCategory = 10) {
  const allProspects = [];
  const seenPhones = new Set();
  
  for (const city of cities) {
    for (const category of categories) {
      console.log(`\n🔍 Searching: ${category} in ${city}...`);
      
      // Search Yelp
      const yelpResults = await searchYelp(category, city);
      console.log(`  📋 Found ${yelpResults.length} Yelp results`);
      
      let added = 0;
      for (const biz of yelpResults) {
        if (added >= maxPerCategory) break;
        
        // Small delay between requests
        await sleep(1500);
        
        const { phones, website } = await getYelpPhone(biz.yelpUrl);
        
        // Try website for phone if Yelp didn't have one
        let finalPhone = phones[0];
        let businessName = biz.name;
        
        if (!finalPhone && website) {
          await sleep(1000);
          const siteData = await getWebsitePhone(website);
          finalPhone = siteData.phones[0];
          if (siteData.name) businessName = siteData.name;
        }
        
        if (finalPhone && !seenPhones.has(finalPhone)) {
          seenPhones.add(finalPhone);
          const formatted = `+1${finalPhone}`;
          allProspects.push({
            phone: formatted,
            businessName: businessName,
            category: category,
            city: city,
            website: website,
            yelpUrl: biz.yelpUrl,
            source: 'yelp'
          });
          added++;
          console.log(`  ✅ ${businessName}: ${formatted}`);
        }
      }
      
      // Rate limit between categories
      await sleep(2000);
    }
  }
  
  return allProspects;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  let cities = ['Fort Worth TX'];
  let categories = HOME_SERVICE_CATEGORIES.slice(0, 10); // Default: first 10 categories
  let output = 'data/dfw-prospects.json';
  let maxPerCategory = 8;
  
  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--city' && args[i + 1]) {
      cities = [args[++i]];
    } else if (args[i] === '--all-dfw') {
      cities = DFW_CITIES;
    } else if (args[i] === '--category' && args[i + 1]) {
      categories = [args[++i]];
    } else if (args[i] === '--all-categories') {
      categories = HOME_SERVICE_CATEGORIES;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === '--max' && args[i + 1]) {
      maxPerCategory = parseInt(args[++i]);
    }
  }
  
  console.log(`🎯 Prospect Finder`);
  console.log(`   Cities: ${cities.length}`);
  console.log(`   Categories: ${categories.length}`);
  console.log(`   Max per category per city: ${maxPerCategory}`);
  console.log(`   Estimated max prospects: ${cities.length * categories.length * maxPerCategory}`);
  console.log(`   Output: ${output}\n`);
  
  const prospects = await findProspects(categories, cities, maxPerCategory);
  
  // Save results
  const outputPath = path.resolve(__dirname, '..', output);
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  fs.writeFileSync(outputPath, JSON.stringify(prospects, null, 2));
  
  console.log(`\n✅ Found ${prospects.length} unique prospects`);
  console.log(`📁 Saved to ${outputPath}`);
  
  // Also output a batch-ready version
  const batchReady = prospects.map(p => ({
    phone: p.phone,
    businessName: p.businessName
  }));
  const batchPath = outputPath.replace('.json', '-batch.json');
  fs.writeFileSync(batchPath, JSON.stringify(batchReady, null, 2));
  console.log(`📞 Batch-ready file: ${batchPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
