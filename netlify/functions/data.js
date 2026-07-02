// ============================================================
// Netlify Function: /.netlify/functions/data
// Proxy seguro para electricidad y Claude API
// ============================================================

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const FETCH_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (compatible; AI-Cycle-Monitor/2.0)',
};

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  const { type, country } = event.queryStringParameters || {};

  // ── ACCIONES — Yahoo Finance directo desde servidor ──────
  if (type === 'stocks') {
    const tickers = (event.queryStringParameters?.tickers || '').trim();
    if (!tickers) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Faltan tickers' }) };
    }

    const urls = [
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickers}&fields=regularMarketPrice,regularMarketChangePercent,currency`,
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${tickers}&fields=regularMarketPrice,regularMarketChangePercent,currency`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) { console.log(`Yahoo ${url} → ${res.status}`); continue; }
        const data = await res.json();
        const quotes = data?.quoteResponse?.result;
        if (quotes?.length) {
          return { statusCode: 200, headers: cors, body: JSON.stringify({ quotes, source: 'Yahoo Finance' }) };
        }
      } catch (e) {
        console.error(`Yahoo fetch failed ${url}: ${e.message}`);
      }
    }

    // Fallback: Stooq (CSV, sin API key) para tickers US
    try {
      const symbols = tickers.split(',').map(t => t.trim().toLowerCase() + '.us').join(',');
      const res = await fetch(`https://stooq.com/q/l/?s=${symbols}&f=sd2t2ohlcv&h&e=csv`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const csv = await res.text();
        const lines = csv.trim().split('\n');
        const header = lines[0].split(',');
        const iSym = header.indexOf('Symbol');
        const iClose = header.indexOf('Close');
        const iOpen = header.indexOf('Open');
        const quotes = lines.slice(1).map(line => {
          const cols = line.split(',');
          const close = parseFloat(cols[iClose]);
          const open = parseFloat(cols[iOpen]);
          const sym = (cols[iSym] || '').replace(/\.US$/i, '').toUpperCase();
          if (isNaN(close)) return null;
          const changePct = open ? ((close - open) / open * 100) : 0;
          return { symbol: sym, regularMarketPrice: close, regularMarketChangePercent: changePct, currency: 'USD' };
        }).filter(Boolean);
        if (quotes.length) {
          return { statusCode: 200, headers: cors, body: JSON.stringify({ quotes, source: 'Stooq' }) };
        }
      }
    } catch (e) {
      console.error('Stooq fallback failed:', e.message);
    }

    return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'Sin datos de acciones' }) };
  }

  // ── ELECTRICIDAD ──────────────────────────────────────────
  if (type === 'electricity') {
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // Fuentes por país en orden de preferencia
    const sources = {
      de: [
        { url: `https://api.energy-charts.info/price?bzn=de&start=${yesterday}&end=${today}`, fmt: 'energy-charts' },
        { url: `https://api.energy-charts.info/price?bzn=DE-LU&start=${yesterday}&end=${today}`, fmt: 'energy-charts' },
      ],
      fr: [
        { url: `https://api.energy-charts.info/price?bzn=fr&start=${yesterday}&end=${today}`, fmt: 'energy-charts' },
        { url: `https://api.energy-charts.info/price?bzn=FR&start=${yesterday}&end=${today}`, fmt: 'energy-charts' },
      ],
      es: [
        { url: `https://api.energy-charts.info/price?bzn=es&start=${yesterday}&end=${today}`, fmt: 'energy-charts' },
        { url: `https://apidatos.ree.es/es/datos/mercados/precios-mercados-tiempo-real?start_date=${yesterday}T00:00&end_date=${today}T23:59&time_trunc=hour`, fmt: 'ree' },
      ],
      nl: [
        { url: `https://api.energy-charts.info/price?bzn=nl&start=${yesterday}&end=${today}`, fmt: 'energy-charts' },
        { url: `https://api.energy-charts.info/price?bzn=NL&start=${yesterday}&end=${today}`, fmt: 'energy-charts' },
      ],
    };

    const attempts = sources[country] || sources.de;

    for (const attempt of attempts) {
      try {
        const res = await fetch(attempt.url, {
          headers: FETCH_HEADERS,
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          console.log(`${attempt.url} → HTTP ${res.status}`);
          continue;
        }

        const data = await res.json();

        // Energy-Charts format: { price: [...], unix_seconds: [...] }
        if (attempt.fmt === 'energy-charts' && Array.isArray(data?.price) && data.price.length > 0) {
          return {
            statusCode: 200, headers: cors,
            body: JSON.stringify({
              prices: data.price,
              source: 'Energy-Charts · Fraunhofer ISE',
            }),
          };
        }

        // REE format: { included: [{ attributes: { values: [...] } }] }
        if (attempt.fmt === 'ree') {
          const vals = data?.included?.[0]?.attributes?.values;
          if (vals?.length) {
            return {
              statusCode: 200, headers: cors,
              body: JSON.stringify({
                prices: vals.map(v => v.value),
                source: 'Red Eléctrica de España · REE',
              }),
            };
          }
        }

      } catch (e) {
        console.error(`Electricity fetch failed [${country}] ${attempt.url}: ${e.message}`);
      }
    }

    return {
      statusCode: 503, headers: cors,
      body: JSON.stringify({ error: `Sin datos para ${country}` }),
    };
  }

  // ── CLAUDE API — GPU / DATA CENTER / PJM ─────────────────
  if (type === 'ai') {
    if (!ANTHROPIC_KEY) {
      return {
        statusCode: 500, headers: cors,
        body: JSON.stringify({ error: 'ANTHROPIC_API_KEY no configurada en Netlify → Site configuration → Environment variables' }),
      };
    }

    const today = new Date().toLocaleDateString('es-ES', {
      day: '2-digit', month: 'long', year: 'numeric',
    });

    const prompt = `Hoy es ${today}. Busca datos actualizados y devuelve SOLO un objeto JSON válido, sin texto adicional, sin markdown, sin bloques de código:

{"gpu":{"b200":{"price":null,"trend":""},"h200":{"price":null,"trend":""},"h100":{"price":null,"trend":""},"a100":{"price":null,"trend":""},"source":"","date":""},"datacenter":{"vacancy_nova":"","under_construction_mw":null,"absorption_q":"","source":"","date":""},"pjm":{"dom_capacity_price":"","available_capacity_gw":null,"new_capacity_eta":"","load_forecast_gw":null,"source":"","date":""}}

Rellena todos los campos buscando en: spheron.network (GPU $/hora spot), cbre.com o datacentermap.com (data centers Northern Virginia), pjm.com (capacidad eléctrica zona DOM). Si un valor es desconocido usa null o "N/D". Devuelve SOLO el JSON.`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(55000),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();

      // Extraer todos los bloques de texto
      const fullText = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      // Buscar el JSON en la respuesta — puede venir con o sin bloques ```
      const cleaned = fullText
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Claude no devolvió JSON válido');

      const parsed = JSON.parse(jsonMatch[0]);
      return { statusCode: 200, headers: cors, body: JSON.stringify(parsed) };

    } catch (e) {
      console.error('Claude API error:', e.message);
      return {
        statusCode: 500, headers: cors,
        body: JSON.stringify({ error: e.message }),
      };
    }
  }

  return {
    statusCode: 400, headers: cors,
    body: JSON.stringify({ error: 'Parámetro type inválido. Usa: electricity o ai' }),
  };
};
