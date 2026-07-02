// ============================================================
// Netlify Function: /.netlify/functions/data
// Proxy seguro para electricidad y Claude API
// ============================================================

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FMP_KEY = process.env.FMP_API_KEY;

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

  // ── ACCIONES — Financial Modeling Prep (una llamada por símbolo, plan free) ──
  if (type === 'stocks') {
    const tickers = (event.queryStringParameters?.tickers || '').trim();
    if (!tickers) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Faltan tickers' }) };
    }
    if (!FMP_KEY) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'FMP_API_KEY no configurada en Netlify → Environment variables' }) };
    }

    const symbols = tickers.split(',').map(t => t.trim()).filter(Boolean);

    // El plan free de FMP solo admite 1 símbolo por llamada → llamadas en paralelo
    const results = await Promise.allSettled(
      symbols.map(sym =>
        fetch(`https://financialmodelingprep.com/stable/quote?symbol=${sym}&apikey=${FMP_KEY}`, {
          headers: FETCH_HEADERS, signal: AbortSignal.timeout(9000),
        })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(arr => Array.isArray(arr) && arr[0] ? arr[0] : null)
      )
    );

    const quotes = [];
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        const q = r.value;
        quotes.push({
          symbol: q.symbol,
          regularMarketPrice: q.price,
          regularMarketChangePercent: q.changePercentage != null ? q.changePercentage : 0,
          currency: 'USD',
        });
      }
    });

    if (!quotes.length) {
      return { statusCode: 503, headers: cors, body: JSON.stringify({ error: 'Sin datos de acciones' }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ quotes, source: 'Financial Modeling Prep' }) };
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

{"gpu":{"b200":{"price":null,"trend":""},"h200":{"price":null,"trend":""},"h100":{"price":null,"trend":""},"a100":{"price":null,"trend":""},"source":"","date":""},"datacenter":{"vacancy_nova":"","under_construction_mw":null,"absorption_q":"","trend_mom":"","source":"","date":""},"pjm":{"dom_capacity_price":"","available_capacity_gw":null,"new_capacity_eta":"","load_forecast_gw":null,"source":"","date":""},"cycle":{"energy_score":null,"energy_reason":"","compute_score":null,"compute_reason":"","demand_score":null,"demand_reason":""}}

Rellena buscando en: spheron.network (GPU $/hora spot), cbre.com o datacentermap.com (data centers Northern Virginia), pjm.com (capacidad eléctrica zona DOM).

En el campo "trend" de cada GPU, indica la dirección del precio respecto al mes anterior (ej. "↓ -12% MoM", "↑ +5% MoM", "→ estable"). En "datacenter.trend_mom" indica cómo evoluciona la vacancia/absorción respecto al mes anterior.

Para el objeto "cycle", evalúa el ciclo de inversión en infraestructura de IA con tres scores de 0 a 100, donde 100 = máxima ESCASEZ (alcista, la demanda supera la oferta) y 0 = máximo EXCESO (bajista, sobra capacidad):
- energy_score: ¿La energía para data centers está escasa y cara (alto) o sobra y barata (bajo)? Basa esto en el precio de capacidad de PJM Virginia y los precios spot. energy_reason: frase corta.
- compute_score: evalúa sobre todo la TENDENCIA del precio de GPUs respecto al mes anterior. Precios subiendo o estables con listas de espera = escasez (alto). Precios BAJANDO de forma sostenida = primeras señales de exceso de oferta = score más bajo. En compute_reason indica explícitamente la tendencia mensual, ej. "H100 -15% MoM, primeras señales de exceso".
- demand_score: evalúa la TENDENCIA de la demanda de infraestructura respecto al mes anterior: capex, ocupación de data centers y vacancia. Mejorando/llenándose = alto. Vacancia subiendo o capex frenando = bajo. En demand_reason indica la dirección del cambio mensual.

Si un valor es desconocido usa null o "N/D". Devuelve SOLO el JSON.`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1536,
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
