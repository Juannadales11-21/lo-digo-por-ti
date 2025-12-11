import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Plantillas fijas cuando la API no tiene saldo.
const quotaFallbackMessages = [
  'Ahora mismo la IA no puede generar un mensaje porque se ha alcanzado el limite de uso, pero puedes decir algo como:\n\nHola, queria comentarte [tu peticion] de forma sincera y respetuosa. Para mi es importante que podamos hablarlo con calma y ver que opciones tenemos.',
  'Parece que el motor de IA esta en pausa por limite de cuota. Mientras tanto, prueba con algo asi:\n\nBuenas, te escribo porque ha pasado [situacion]. Me gustaria encontrar una solucion que sea razonable para las dos partes.',
  'La IA no esta disponible en este momento (limite de uso), pero puedes usar esta plantilla:\n\nHola [nombre], gracias por tu tiempo. Queria explicarte brevemente lo que ha ocurrido: [resumen]. Me gustaria saber si podemos revisarlo juntos y ver la mejor forma de seguir.'
];

const channelGuidance = {
  whatsapp:
    'Canal: WhatsApp. Mensajes breves y coloquiales, estilo chat. Se permiten emojis ligeros solo si el tono no es formal.',
  email_formal:
    'Canal: email formal. Incluye saludo breve, cuerpo conciso y cierre cordial. Nada de emojis ni coletillas de IA.',
  linkedin:
    'Canal: LinkedIn. Profesional pero cercano, 2-4 frases claras orientadas a networking o trabajo. Sin emojis excesivos.',
  nota_voz:
    'Canal: nota de voz. Estilo oral y fluido, frases algo mas largas con conectores naturales, sonido conversacional.'
};

const intensityLabels = {
  1: 'muy suave',
  2: 'neutro',
  3: 'directo',
  4: 'muy directo'
};

const languageNames = {
  es: 'espanol',
  en: 'ingles',
  fr: 'frances',
  de: 'aleman',
  it: 'italiano',
  pt: 'portugues'
};

function computeTemperature(toneLabel, intensityLevel) {
  let base;
  if (toneLabel === 'formal') base = 0.3;
  else if (toneLabel === 'cercano') base = 0.7;
  else if (toneLabel === 'divertido') base = 1.0;
  else base = 0.6;

  const adjust = { 1: -0.2, 2: 0, 3: 0.1, 4: 0.2 }[intensityLevel] || 0;
  return Math.min(1.3, Math.max(0.1, Number((base + adjust).toFixed(2))));
}

// Nota: en entorno serverless de Vercel no hay estado persistente para rate limiting en memoria.
// Si se necesita control de abuso, se puede agregar mas adelante con soluciones como middleware externo o KV.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let body = req.body;
  if (typeof req.body === 'string') {
    try {
      body = JSON.parse(req.body || '{}');
    } catch (parseError) {
      body = {};
    }
  }

  const { situation, tone, channel, intensity, language } = body || {};

  const trimmedSituation = (situation || '').trim();
  const toneLabel = (tone || 'formal').toLowerCase();
  const channelKey = (channel || 'whatsapp').toLowerCase();
  const rawIntensity = Number(intensity);
  const intensityLevel =
    Number.isFinite(rawIntensity) && rawIntensity >= 1 && rawIntensity <= 4 ? Math.round(rawIntensity) : 2;
  const languageCode = (language || 'es').toLowerCase();
  const languageName = languageNames[languageCode] || languageNames.es;

  if (!trimmedSituation) {
    return res.status(400).json({ error: 'La situacion es obligatoria.' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Falta la clave de API. Configura OPENAI_API_KEY.' });
  }

  const temperature = computeTemperature(toneLabel, intensityLevel);
  const channelInstruction = channelGuidance[channelKey] || channelGuidance.whatsapp;
  const intensityLabel = intensityLabels[intensityLevel];

  const prompt = `Idioma: ${languageName}. Responde siempre en ${languageName}, sin traducciones ni explicaciones.
Tono: ${toneLabel}. Intensidad: ${intensityLevel} (${intensityLabel}).
${channelInstruction}
- Genera 3 opciones distintas, humanas y listas para copiar.
- No uses frases de asistente o IA. Varヴa la redacciИn entre opciones.
- Devuelve solo JSON valido exacto: {"messages": ["mensaje 1", "mensaje 2", "mensaje 3"]}.
Situacion del usuario: ${trimmedSituation}`;

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-5-nano',
      temperature,
      messages: [
        {
          role: 'system',
          content:
            'Eres una persona que redacta mensajes breves y naturales para distintos canales. Responde siempre en el idioma indicado por el usuario, sin traducciones adicionales, y devuelve solo JSON con la forma {"messages": ["mensaje 1", "mensaje 2", "mensaje 3"]}.'
        },
        { role: 'user', content: prompt }
      ]
    });

    const rawContent = completion.choices?.[0]?.message?.content?.trim() || '';
    let parsed;

    try {
      parsed = JSON.parse(rawContent);
    } catch (parseError) {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      }
    }

    const messages = Array.isArray(parsed?.messages) ? parsed.messages.filter(Boolean).slice(0, 3) : [];

    if (!messages.length) {
      return res.status(500).json({ error: 'No se pudieron generar mensajes.' });
    }

    return res.status(200).json({ messages });
  } catch (error) {
    const quotaExceeded =
      error?.error?.code === 'insufficient_quota' || error?.status === 429 || error?.response?.status === 429;
    if (quotaExceeded) {
      return res.status(200).json({ messages: quotaFallbackMessages });
    }

    console.error('Error al generar mensajes', error);
    return res
      .status(500)
      .json({ error: 'No se pudo generar el mensaje. Intenta nuevamente en unos minutos.' });
  }
}
