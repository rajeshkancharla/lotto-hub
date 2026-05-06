// Saturday Lotto Hub — Cloudflare Worker
// Routes:
//   /all          → full Lotterywest CSV (all draws, official govt API)
//   /year/YYYY    → scrape one year from australia.national-lottery.com
//   /results      → latest 10 draws (au.lottonumbers.com)
//   /results/NNNN → specific draw number

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Full Lotterywest CSV (official govt API, most reliable) ──
      if (path === '/all') {
        const csv = await fetchLotterywestCSV();
        const draws = parseCSV(csv);
        return jsonResponse({ draws, success: true, source: 'lotterywest', count: draws.length });
      }

      // ── Single year from australia.national-lottery.com ──
      if (path.startsWith('/year/')) {
        const year = parseInt(path.split('/').pop());
        if (isNaN(year) || year < 1986 || year > 2030) {
          return jsonResponse({ error: 'Invalid year', success: false }, 400);
        }
        const draws = await fetchYear(year);
        return jsonResponse({ draws, success: true, year, count: draws.length });
      }

      // ── Latest results ──
      if (path === '/results') {
        const draws = await fetchLatest();
        return jsonResponse({ draws, success: true });
      }

      // ── Specific draw ──
      if (path.startsWith('/results/')) {
        const drawNum = path.split('/').pop();
        const draw = await fetchDraw(drawNum);
        return jsonResponse({ draws: draw ? [draw] : [], success: !!draw });
      }

      return jsonResponse({ error: 'Unknown route. Use /all, /year/YYYY, /results, /results/NNNN', success: false }, 404);

    } catch (err) {
      return jsonResponse({ error: err.message, success: false }, 500);
    }
  }
};

// ── Lotterywest official CSV API ──────────────────────────────
async function fetchLotterywestCSV() {
  const res = await fetch('https://www.lotterywest.wa.gov.au/api/games/5127/results-csv', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/csv,*/*',
      'Referer': 'https://www.lotterywest.wa.gov.au/results/saturday-lotto'
    }
  });
  if (!res.ok) throw new Error(`Lotterywest API: ${res.status}`);
  return await res.text();
}

function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  const draws = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 10) continue;
    try {
      const drawNum = parseInt(parts[0]);
      const dp = parts[1].split('/');
      const dateStr = `${dp[2]}-${dp[1]}-${dp[0]}`;
      const balls = [2,3,4,5,6,7].map(j => parseInt(parts[j])).sort((a,b)=>a-b);
      const supps = [8,9].map(j => parseInt(parts[j])).sort((a,b)=>a-b);
      const div1 = parts.length > 12 ? Math.round(parseFloat(parts[12])) : 0;
      if (balls.length === 6 && balls.every(b => b >= 1 && b <= 45)) {
        draws.push({ draw: drawNum, date: dateStr, balls, supps, div1 });
      }
    } catch(e) {}
  }
  return draws.sort((a,b) => b.draw - a.draw);
}

// ── Year scraper from australia.national-lottery.com ─────────
async function fetchYear(year) {
  const url = `https://australia.national-lottery.com/saturday-lotto/results-archive-${year}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-AU,en;q=0.9',
      'Referer': 'https://australia.national-lottery.com/saturday-lotto/past-results'
    }
  });
  if (!res.ok) throw new Error(`Year ${year}: HTTP ${res.status}`);
  const html = await res.text();
  return parseYearHTML(html, year);
}

function parseYearHTML(html, year) {
  const draws = [];
  const seen = new Set();

  // Pattern: table rows with draw number, date, and 8 balls
  // australia.national-lottery.com uses <tr> with draw data
  const monthMap = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
    jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    january:1,february:2,march:3,april:4,june:6,
    july:7,august:8,september:9,october:10,november:11,december:12
  };

  // Match draw blocks — look for draw numbers and associated ball sets
  // The site renders: draw number | date | 6 main balls | 2 supp balls
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];

    // Extract draw number
    const drawMatch = row.match(/\b(3\d{3}|4\d{3})\b/);
    if (!drawMatch) continue;
    const drawNum = parseInt(drawMatch[1]);
    if (seen.has(drawNum)) continue;

    // Extract date
    const dateMatch = row.match(/(\d{1,2})[\/\s-](Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[\/\s-](\d{4})/i)
      || row.match(/(\d{4})-(\d{2})-(\d{2})/);

    let dateStr = `${year}-01-01`;
    if (dateMatch) {
      if (dateMatch[0].includes('-') && dateMatch[1].length === 4) {
        dateStr = dateMatch[0]; // ISO format
      } else {
        const day = dateMatch[1].padStart(2,'0');
        const mon = (monthMap[dateMatch[2].toLowerCase().slice(0,3)] || 1).toString().padStart(2,'0');
        const yr = dateMatch[3];
        dateStr = `${yr}-${mon}-${day}`;
      }
    }

    // Extract all numbers 1-45 from the row
    const numMatches = [...row.matchAll(/\b([1-9]|[1-3][0-9]|4[0-5])\b/g)]
      .map(m => parseInt(m[1]))
      .filter(n => n >= 1 && n <= 45);

    if (numMatches.length < 6) continue;

    // Deduplicate while preserving order
    const unique = [...new Set(numMatches)];
    if (unique.length < 6) continue;

    const balls = unique.slice(0, 6).sort((a,b) => a-b);
    const supps = unique.slice(6, 8).sort((a,b) => a-b);

    seen.add(drawNum);
    draws.push({ draw: drawNum, date: dateStr, balls, supps: supps.length >= 2 ? supps : [], div1: 0 });
  }

  // Fallback: broader regex if table parsing got nothing
  if (draws.length === 0) {
    const blockRegex = /Draw\s*(?:No\.?\s*)?#?\s*(3\d{3}|4\d{3})[\s\S]{0,200}?(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})([\s\S]{0,500}?)(?=Draw|$)/gi;
    let m;
    while ((m = blockRegex.exec(html)) !== null) {
      const drawNum = parseInt(m[1]);
      if (seen.has(drawNum)) continue;
      const day = m[2].padStart(2,'0');
      const mon = (monthMap[m[3].toLowerCase().slice(0,3)] || 1).toString().padStart(2,'0');
      const yr = m[4];
      const block = m[5];
      const nums = [...block.matchAll(/\b([1-9]|[1-3][0-9]|4[0-5])\b/g)]
        .map(x => parseInt(x[1])).filter(n => n >= 1 && n <= 45);
      const unique = [...new Set(nums)];
      if (unique.length < 6) continue;
      seen.add(drawNum);
      draws.push({
        draw: drawNum,
        date: `${yr}-${mon}-${day}`,
        balls: unique.slice(0,6).sort((a,b)=>a-b),
        supps: unique.slice(6,8).sort((a,b)=>a-b),
        div1: 0
      });
    }
  }

  return draws.sort((a,b) => b.draw - a.draw);
}

// ── Latest results from au.lottonumbers.com ──────────────────
async function fetchLatest() {
  const res = await fetch('https://au.lottonumbers.com/saturday-lotto/results', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-AU,en;q=0.9',
    }
  });
  const html = await res.text();
  return parseDrawsFromHTML(html);
}

async function fetchDraw(drawNum) {
  const res = await fetch(`https://au.lottonumbers.com/saturday-lotto/results/${drawNum}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    }
  });
  const html = await res.text();
  const draws = parseDrawsFromHTML(html);
  return draws[0] || null;
}

function parseDrawsFromHTML(html) {
  const draws = [];
  const monthMap = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const blockRegex = /Draw\s+([\d,]+)[\s\S]*?(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})([\s\S]*?)(?=Draw\s+[\d,]+|$)/gi;
  let match;
  while ((match = blockRegex.exec(html)) !== null) {
    const drawNum = parseInt(match[1].replace(/,/g, ''));
    const day = match[2], month = match[3], year = match[4], block = match[5];
    const ballMatches = [...block.matchAll(/>(\d{1,2})</g)].map(m => parseInt(m[1])).filter(n => n >= 1 && n <= 45);
    if (ballMatches.length >= 6) {
      const balls = ballMatches.slice(0, 6).sort((a,b) => a-b);
      const supps = ballMatches.slice(6, 8).sort((a,b) => a-b);
      const mKey = month.toLowerCase().slice(0,3);
      const date = new Date(parseInt(year), monthMap[mKey] || 0, parseInt(day));
      draws.push({ draw: drawNum, date: date.toISOString().slice(0,10), balls, supps: supps.length >= 2 ? supps : [], div1: 0 });
    }
  }
  return draws.sort((a,b) => b.draw - a.draw);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-cache'
    }
  });
}
