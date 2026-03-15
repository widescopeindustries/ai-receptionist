#!/usr/bin/env node
/**
 * Prospect Finder v2 — Uses direct website scraping from known directories
 * Targets: HomeAdvisor, BBB, local directory pages that list businesses with phone numbers
 * 
 * Usage: node scripts/prospect-finder-web.js
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

/**
 * Scrape phone numbers from a business website
 */
async function scrapePhone(url) {
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 8000, maxRedirects: 3 });
    const $ = cheerio.load(data);
    
    // Business name
    const name = $('meta[property="og:site_name"]').attr('content') 
      || $('title').text().split(/[|\-–—]/)[0].trim()
      || '';
    
    // Phone from tel: links (most reliable)
    const phones = new Set();
    $('a[href^="tel:"]').each((i, el) => {
      const num = ($(el).attr('href') || '').replace(/\D/g, '').slice(-10);
      if (num.length === 10 && !num.startsWith('000') && !num.startsWith('555')) {
        phones.add(num);
      }
    });
    
    // Phone from text patterns
    const textPhones = data.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g) || [];
    for (const p of textPhones) {
      const num = p.replace(/\D/g, '').slice(-10);
      if (num.length === 10 && !num.startsWith('000') && !num.startsWith('555') && !num.startsWith('123')) {
        phones.add(num);
      }
    }
    
    return { name: name.substring(0, 80), phones: [...phones] };
  } catch {
    return { name: '', phones: [] };
  }
}

/**
 * Process a list of URLs, extract business info + phones
 */
async function processUrls(urls, category, city) {
  const results = [];
  const seenPhones = new Set();
  
  for (const url of urls) {
    await sleep(1500);
    const { name, phones } = await scrapePhone(url);
    const phone = phones[0];
    
    if (phone && !seenPhones.has(phone)) {
      seenPhones.add(phone);
      results.push({
        phone: `+1${phone}`,
        businessName: name || url.replace(/https?:\/\/(www\.)?/, '').split('/')[0],
        category,
        city,
        website: url,
        source: 'web-scrape'
      });
      console.log(`  ✅ ${name || 'Unknown'}: +1${phone}`);
    }
  }
  
  return results;
}

async function main() {
  console.log('🎯 DFW Prospect Finder v2 — Direct Website Scraping\n');
  
  // Hardcoded URL lists from search results — reliable, no API needed
  // Each entry: { category, city, urls: [...websites to scrape] }
  const searches = [
    // We'll populate this from web_search results
  ];
  
  // Read URLs from stdin or file
  const inputFile = process.argv[2] || 'data/prospect-urls.json';
  
  if (!fs.existsSync(path.resolve(__dirname, '..', inputFile))) {
    console.log(`No input file at ${inputFile}. Create it with format:`);
    console.log(`[{"category":"HVAC","city":"Fort Worth TX","urls":["https://..."]}]`);
    process.exit(1);
  }
  
  const urlSets = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', inputFile), 'utf8'));
  
  const allProspects = [];
  const globalSeenPhones = new Set();
  
  for (const { category, city, urls } of urlSets) {
    console.log(`\n🔍 ${category} in ${city} (${urls.length} URLs)...`);
    const results = await processUrls(urls, category, city);
    
    for (const r of results) {
      const phoneKey = r.phone.slice(-10);
      if (!globalSeenPhones.has(phoneKey)) {
        globalSeenPhones.add(phoneKey);
        allProspects.push(r);
      }
    }
  }
  
  // Save
  const outputPath = path.resolve(__dirname, '..', 'data/dfw-prospects.json');
  fs.writeFileSync(outputPath, JSON.stringify(allProspects, null, 2));
  
  const batchPath = path.resolve(__dirname, '..', 'data/dfw-prospects-batch.json');
  const batch = allProspects.map(p => ({ phone: p.phone, businessName: p.businessName }));
  fs.writeFileSync(batchPath, JSON.stringify(batch, null, 2));
  
  console.log(`\n✅ ${allProspects.length} unique prospects found`);
  console.log(`📁 Full data: ${outputPath}`);
  console.log(`📞 Batch-ready: ${batchPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
