/**
 * Codeastra Private Browser Service
 * ====================================
 * Fetches PUBLIC web pages for AI agents.
 * Tokenizes results before returning to AI.
 * NEVER receives user data — only search queries and URLs.
 * Sessions wiped on close — no history, no cookies, no trace.
 */
'use strict';

const express    = require('express');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const { chromium } = require('playwright');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ── Sessions ──────────────────────────────────────────────────────────────────
const SESSIONS = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of SESSIONS) {
    if (now - s.last_active > 30*60*1000) wipe(id).catch(()=>{});
  }
}, 5*60*1000);

// ── Tokenizer (for search results — public data only) ─────────────────────────
const PATS = {
  EMAIL: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  PHONE: /(?:\+?1[\-.\s]?)?(?:\(?\d{3}\)?[\-.\s]?)\d{3}[\-.\s]?\d{4}\b/g,
  SSN:   /\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g,
  AMT:   /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?\b|\$\d{4,}(?:\.\d{2})?\b/g,
};

function mkToken(type, value) {
  let h=0; const s=type+':'+value;
  for(let i=0;i<s.length;i++){h=((h<<5)-h)+s.charCodeAt(i);h|=0;}
  return `[CVT:${type}:${Math.abs(h).toString(16).padStart(8,'0').toUpperCase()}]`;
}

function tokenize(text) {
  if (!text) return text;
  let result = text;
  for (const [type, re] of Object.entries(PATS)) {
    re.lastIndex=0;
    for (const m of [...new Set(text.match(re)||[])]) {
      result = result.replaceAll(m, mkToken(type, m));
    }
  }
  return result;
}

// ── Session management ────────────────────────────────────────────────────────
async function create(id) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--no-first-run','--single-process','--disable-gpu','--incognito'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    viewport:  { width:1280, height:720 },
    locale:    'en-US',
    extraHTTPHeaders: { 'DNT':'1' },
  });
  // Block trackers
  await context.route('**', route => {
    const url = route.request().url();
    if (['google-analytics','doubleclick','facebook.com/tr','hotjar','segment.io'].some(d=>url.includes(d))) return route.abort();
    route.continue();
  });
  const page = await context.newPage();
  const session = { id, browser, context, page, created_at:Date.now(), last_active:Date.now() };
  SESSIONS.set(id, session);
  return session;
}

async function wipe(id) {
  const s = SESSIONS.get(id);
  if (!s) return;
  try {
    await s.context.clearCookies();
    for (const p of s.context.pages()) await p.close().catch(()=>{});
    await s.context.close().catch(()=>{});
    await s.browser.close().catch(()=>{});
  } catch(_) {}
  SESSIONS.delete(id);
  console.log(`[Astra Browser] Session ${id} wiped`);
}

function touch(s) { s.last_active=Date.now(); }

function requireSession(req,res,next) {
  const s=SESSIONS.get(req.params.id);
  if (!s) return res.status(404).json({error:'Session not found'});
  touch(s); req.session=s; next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (req,res) => res.json({status:'ok',sessions:SESSIONS.size,version:'2.0.0'}));

app.post('/session/create', async (req,res) => {
  try {
    const id = req.body.session_id || uuidv4();
    await create(id);
    console.log(`[Astra Browser] Session created: ${id}`);
    res.json({session_id:id,status:'ready'});
  } catch(err) { res.status(500).json({error:err.message}); }
});

// Search — fetches public web, tokenizes results
app.post('/session/:id/search', requireSession, async (req,res) => {
  const {session:s} = req;
  const {query, engine='duckduckgo'} = req.body;
  if (!query) return res.status(400).json({error:'query required'});

  const ENGINES = {
    duckduckgo: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
    google:     `https://www.google.com/search?q=${encodeURIComponent(query)}&num=5`,
    bing:       `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  };

  try {
    await s.page.goto(ENGINES[engine]||ENGINES.duckduckgo, {waitUntil:'domcontentloaded',timeout:15000});

    const results = await s.page.evaluate(() => {
      const items=[];
      // DuckDuckGo
      document.querySelectorAll('[data-result="snippet"],.result,.result__body').forEach(el=>{
        const a       = el.querySelector('a[data-testid="result-title-a"],a.result__a,h2 a');
        const snippet = el.querySelector('.result__snippet,[data-result="snippet"],p');
        if (a?.innerText) items.push({title:a.innerText,link:a.href||'',snippet:snippet?.innerText||''});
      });
      // Google fallback
      if (!items.length) {
        document.querySelectorAll('div.g').forEach(el=>{
          const h=el.querySelector('h3'); const a=el.querySelector('a'); const s=el.querySelector('.VwiC3b');
          if (h) items.push({title:h.innerText,link:a?.href||'',snippet:s?.innerText||''});
        });
      }
      // Generic fallback
      if (!items.length) {
        document.querySelectorAll('article,li.b_algo').forEach(el=>{
          const h=el.querySelector('h2,h3'); const a=el.querySelector('a'); const p=el.querySelector('p');
          if (h) items.push({title:h.innerText,link:a?.href||'',snippet:p?.innerText||''});
        });
      }
      return items.slice(0,5);
    });

    // Tokenize results — in case they contain sensitive data
    const tokenized = results.map(r=>({
      title:   tokenize(r.title),
      link:    r.link,
      snippet: tokenize(r.snippet),
    }));

    res.json({success:true, results:tokenized, count:results.length});
  } catch(err) { res.status(500).json({success:false,error:err.message}); }
});

// Navigate to public URL
app.post('/session/:id/navigate', requireSession, async (req,res) => {
  const {session:s} = req;
  const {url} = req.body;
  if (!url) return res.status(400).json({error:'url required'});

  try {
    await s.page.goto(url, {waitUntil:'domcontentloaded',timeout:15000});
    const content = await s.page.evaluate(() => {
      const main = document.querySelector('main,article,[role="main"]');
      if (main) return (main.innerText||'').slice(0,4000);
      const body = document.body.cloneNode(true);
      ['nav','footer','header','script','style'].forEach(t=>body.querySelectorAll(t).forEach(e=>e.remove()));
      return (body.innerText||'').slice(0,4000);
    });
    res.json({success:true, content:tokenize(content), url:s.page.url(), title:await s.page.title().catch(()=>'')});
  } catch(err) { res.status(500).json({success:false,error:err.message}); }
});

// Session status
app.get('/session/:id/status', requireSession, (req,res) => {
  const {session:s}=req;
  res.json({session_id:s.id,status:'active',created_at:s.created_at,url:s.page.url()});
});

// Wipe session
app.delete('/session/:id', async (req,res) => {
  await wipe(req.params.id);
  res.json({wiped:true,message:'session wiped — no trace'});
});

app.listen(PORT, () => {
  console.log(`[Astra Browser] Port ${PORT} — public web only, sessions ephemeral`);
});
