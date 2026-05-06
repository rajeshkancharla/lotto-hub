// Saturday Lotto Historical Data Fetcher
// Scrapes directly from australia.national-lottery.com
// Run: node fetch-lotto-history.js

const fs = require('fs');
const https = require('https');

const BASE_URL = 'https://australia.national-lottery.com';
const START_YEAR = 1986;
const END_YEAR = new Date().getFullYear();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-AU,en;q=0.9',
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

const MONTH_MAP = {
  january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12
};

function parseYearPage(html, year) {
  const draws = [];
  const seen = new Set();

  // Match table rows
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];

    // Must contain "Draw NNNN"
    const drawMatch = row.match(/Draw\s+(\d{3,4})/i);
    if (!drawMatch) continue;
    const drawNum = parseInt(drawMatch[1]);
    if (seen.has(drawNum) || drawNum < 100) continue;

    // Extract date from URL pattern /results/DD-MM-YYYY
    let dateStr = `${year}-01-01`;
    const urlDate = row.match(/results\/(\d{2})-(\d{2})-(\d{4})/);
    const textDate = row.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})/i);

    if (urlDate) {
      dateStr = `${urlDate[3]}-${urlDate[2]}-${urlDate[1]}`;
    } else if (textDate) {
      const day = textDate[1].padStart(2, '0');
      const mon = (MONTH_MAP[textDate[2].toLowerCase()] || 1).toString().padStart(2, '0');
      dateStr = `${textDate[3]}-${mon}-${day}`;
    }

    // Extract balls from <li> elements
    const liMatches = [...row.matchAll(/<li[^>]*>\s*(\d{1,2})\s*<\/li>/g)]
      .map(m => parseInt(m[1]))
      .filter(n => n >= 1 && n <= 45);

    if (liMatches.length < 6) continue;

    const balls = liMatches.slice(0, 6).sort((a, b) => a - b);
    const supps = liMatches.slice(6, 8).sort((a, b) => a - b);

    seen.add(drawNum);
    draws.push({
      draw: drawNum,
      date: dateStr,
      balls,
      supps: supps.length >= 2 ? supps : [],
      div1: 0
    });
  }

  return draws.sort((a, b) => b.draw - a.draw);
}

async function fetchYear(year) {
  const url = `${BASE_URL}/saturday-lotto/results-archive-${year}`;
  try {
    const { status, body } = await fetchPage(url);
    if (status !== 200) {
      console.log(` HTTP ${status}`);
      return [];
    }
    const draws = parseYearPage(body, year);
    console.log(` ✓ ${draws.length} draws`);
    return draws;
  } catch (e) {
    console.log(` ✗ Error: ${e.message}`);
    return [];
  }
}

async function main() {
  console.log('Saturday Lotto Historical Data Fetcher');
  console.log('Source: australia.national-lottery.com');
  console.log('======================================\n');

  const allDraws = new Map();
  let emptyYears = 0;

  for (let year = END_YEAR; year >= START_YEAR; year--) {
    process.stdout.write(`Fetching ${year}...`);
    const draws = await fetchYear(year);

    if (draws.length === 0) {
      emptyYears++;
      if (emptyYears >= 3) {
        console.log(`\n3 consecutive empty years — stopping at ${year + 3}`);
        break;
      }
    } else {
      emptyYears = 0;
      draws.forEach(d => allDraws.set(d.draw, d));
    }

    await sleep(600); // polite delay between requests
  }

  const sorted = Array.from(allDraws.values())
    .sort((a, b) => b.draw - a.draw);

  console.log('\n======================================');
  console.log(`Total real draws: ${sorted.length}`);

  if (sorted.length > 0) {
    console.log(`Newest: Draw ${sorted[0].draw} (${sorted[0].date})`);
    console.log(`Oldest: Draw ${sorted[sorted.length - 1].draw} (${sorted[sorted.length - 1].date})`);
    
    // Verify draw count per year
    const byYear = {};
    sorted.forEach(d => {
      const yr = d.date.slice(0, 4);
      byYear[yr] = (byYear[yr] || 0) + 1;
    });
    console.log('\nDraws per year:');
    Object.entries(byYear).sort().reverse().forEach(([yr, count]) => {
      const expected = yr === String(END_YEAR) ? '?' : '52';
      const ok = count >= 48 ? '✓' : '⚠';
      console.log(`  ${yr}: ${count} draws ${ok}`);
    });
  }

  // Save files
  fs.writeFileSync('lotto_history.json', JSON.stringify(sorted, null, 2));
  fs.writeFileSync('lotto_history_compact.json', JSON.stringify(sorted));

  const fullSize = fs.statSync('lotto_history.json').size;
  const compactSize = fs.statSync('lotto_history_compact.json').size;

  console.log(`\n✓ lotto_history.json        ${(fullSize / 1024).toFixed(0)} KB (readable)`);
  console.log(`✓ lotto_history_compact.json ${(compactSize / 1024).toFixed(0)} KB (for embedding)`);
  console.log('\nNext step: send lotto_history_compact.json to Claude to embed into index.html');
}

main().catch(console.error);