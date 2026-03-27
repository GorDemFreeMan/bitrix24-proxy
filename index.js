const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const config = {
  bitrixUrl: process.env.BITRIX24_API_URL || 'https://corp.ekopromgroup.ru/rest/72/xd6q0ozgoplsrbv1',
  botId: process.env.BITRIX24_BOT_ID || '836',
  clientId: process.env.BITRIX24_CLIENT_ID || 'cq4fa3osunavthb6rfu35xjphhcz05y',
  openaiKey: process.env.OPENAI_API_KEY,
  qdrantUrl: process.env.QDRANT_URL || 'https://qdrant-production-93ad.up.railway.app',
  qdrantCollection: process.env.QDRANT_COLLECTION || 'ekoprom_knowledge',
  groqKey: process.env.GROQ_API_KEY,
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
};

// Validate required keys at startup
if (!config.openaiKey) throw new Error('OPENAI_API_KEY is required');
if (!config.groqKey) throw new Error('GROQ_API_KEY is required');

// Middleware: validate hook secret
function validateHook(req, res, next) {
  const auth = req.headers.authorization;
  const hookSecret = process.env.HOOK_SHARED_SECRET;
  if (!hookSecret) return next();
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== hookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Generate embedding via OpenAI
async function getEmbedding(text) {
  const response = await axios.post(
    'https://api.openai.com/v1/embeddings',
    {
      model: 'text-embedding-3-small',
      input: text,
      dimensions: 768
    },
    {
      headers: {
        'Authorization': `Bearer ${config.openaiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );
  return response.data.data[0].embedding;
}

// Search Qdrant
async function searchQdrant(embedding, topK = 7, minScore = 0.5) {
  try {
    const response = await axios.post(
      `${config.qdrantUrl}/collections/${config.qdrantCollection}/points/search`,
      {
        vector: embedding,
        limit: topK,
        score_threshold: minScore,
        with_payload: true,
        with_vectors: false
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    console.log(`[Qdrant] Found ${response.data.result?.length || 0} results`);
    return response.data.result || [];
  } catch (err) {
    console.error('[Qdrant ERROR]', err.response?.data || err.message);
    return [];
  }
}

// Generate response via Groq LLM
async function generateResponse(context, question) {
  const systemPrompt = `Ты — корпоративный AI-ассистент ООО «ЭкоПром СПб».
Твоё имя — Администратор.

Твоя задача — отвечать на вопросы сотрудников компании строго
на основе предоставленных фрагментов корпоративных документов:
регламентов, приказов и внутренних инструкций.

ПРАВИЛА:
1. Отвечай ТОЛЬКО на основе предоставленного контекста из базы знаний.
2. Если в контексте есть ответ — дай чёткий, структурированный ответ.
3. Если контекст содержит частичную информацию — укажи что найдено.
4. Ссылайся на источник: [Источник: название_документа]
5. Отвечай на русском, профессионально и вежливо.
6. Не придумывай информацию.
7. Если информации недостаточно — скажи об этом.
8. Максимум 800 символов.`;

  const response = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: config.groqModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Контекст из базы знаний:\n${context}\n\nВопрос: ${question}` }
      ],
      temperature: 0.3,
      max_tokens: 1000
    },
    {
      headers: {
        'Authorization': `Bearer ${config.groqKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );
  return response.data.choices[0].message.content;
}

// Format context from Qdrant results
function formatContext(results) {
  if (!results || results.length === 0) return null;
  return results.map(r => {
    const source = r.payload?.source || 'Неизвестный источник';
    const text = r.payload?.text || '';
    return `Источник: ${source}\n${text}`;
  }).join('\n\n');
}

// Bitrix24 webhook endpoint
app.post(
  '/webhook/6eff4cd1-e50a-4727-905d-dca7eded094e',
  validateHook,
  async (req, res) => {
    const { message, user_id, dialog_id, message_id } = req.body;

    if (!message || !user_id || !dialog_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`[Webhook] message="${message}", user=${user_id}, dialog=${dialog_id}`);

    // Respond to Bitrix24 immediately
    res.json({ ok: true });

    try {
      console.log('[Step 1] Generating embedding...');
      const embedding = await getEmbedding(message);

      console.log('[Step 2] Searching Qdrant...');
      const results = await searchQdrant(embedding);

      if (!results || results.length === 0) {
        console.log('[No results] Sending fallback...');
        await sendToBitrix(dialog_id, 'Информация не найдена в базе знаний. Попросите ответственного актуализировать регламент.');
        return;
      }

      const context = formatContext(results);
      console.log(`[Found ${results.length}] sources`);

      console.log('[Step 3] Generating LLM response...');
      const response = await generateResponse(context, message);

      await sendToBitrix(dialog_id, response);
      console.log('[OK] Response sent');

    } catch (err) {
      console.error('[ERROR]', err.response?.data || err.message);
      try {
        await sendToBitrix(dialog_id, 'Сервис временно недоступен. Попробуйте позже.');
      } catch (e) {
        console.error('[FALLBACK ERROR]', e.response?.data || e.message);
      }
    }
  }
);

async function sendToBitrix(dialogId, text) {
  await axios.post(
    `${config.bitrixUrl}/imbot.message.add.json`,
    {
      BOT_ID: parseInt(config.botId),
      CLIENT_ID: config.clientId,
      DIALOG_ID: dialogId,
      MESSAGE: text
    },
    { timeout: 10000 }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bitrix24 RAG Proxy listening on port ${PORT}`);
});
