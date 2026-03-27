const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const config = {
  openclawUrl: process.env.OPENCLAW_GATEWAY_URL || 'http://host.docker.internal:18789',
  hookSecret: process.env.HOOK_SHARED_SECRET,
  bitrixUrl: process.env.BITRIX24_API_URL || 'https://corp.ekopromgroup.ru/rest/72/xd6q0ozgoplsrbv1',
  botId: process.env.BITRIX24_BOT_ID || '836',
  clientId: process.env.BITRIX24_CLIENT_ID || 'cq4fa3osunavthb6rf5u35xjphhcz05y'
};

// Middleware: validate hook secret
function validateHook(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== config.hookSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Bitrix24 webhook endpoint
app.post(
  '/webhook/6eff4cd1-e50a-4727-905d-dca7eded094e',
  validateHook,
  async (req, res) => {
    const { message, user_id, dialog_id, message_id } = req.body;

    // Validate required fields
    if (!message || !user_id || !dialog_id) {
      return res.status(400).json({ error: 'Missing required fields: message, user_id, dialog_id' });
    }

    // Respond to Bitrix24 immediately (within 3 seconds)
    res.json({ ok: true });

    try {
      // Forward to OpenClaw Gateway
      const openclawRes = await axios.post(
        `${config.openclawUrl}/hooks/bitrix24`,
        {
          message,
          user_id,
          dialog_id,
          message_id,
          session_key: `hook:bitrix24:${user_id}`
        },
        {
          headers: {
            'Authorization': `Bearer ${config.hookSecret}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      const { response } = openclawRes.data;

      if (!response) {
        console.error('OpenClaw returned empty response');
        return;
      }

      // Send response back to Bitrix24
      await axios.post(
        `${config.bitrixUrl}/imbot.message.add.json`,
        {
          BOT_ID: parseInt(config.botId),
          CLIENT_ID: config.clientId,
          DIALOG_ID: dialog_id,
          MESSAGE: response
        },
        {
          timeout: 10000
        }
      );

      console.log(`[OK] Response sent to dialog ${dialog_id}`);

    } catch (err) {
      console.error('[ERROR]', err.message);

      // Try to send fallback to Bitrix24
      try {
        await axios.post(
          `${config.bitrixUrl}/imbot.message.add.json`,
          {
            BOT_ID: parseInt(config.botId),
            CLIENT_ID: config.clientId,
            DIALOG_ID: dialog_id,
            MESSAGE: 'Сервис временно недоступен. Попробуйте позже.'
          },
          { timeout: 10000 }
        );
      } catch (fallbackErr) {
        console.error('[FALLBACK ERROR]', fallbackErr.message);
      }
    }
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw Bitrix24 Proxy listening on port ${PORT}`);
  console.log(`OpenClaw Gateway: ${config.openclawUrl}`);
});
