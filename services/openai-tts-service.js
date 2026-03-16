const https = require('https');

/**
 * Stream OpenAI TTS audio to an Express response.
 * Uses the same shimmer voice as the Realtime API for consistency.
 * @param {string} text - Text to speak
 * @param {object} res - Express response object
 */
function streamTTS(text, res) {
  const apiKey = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('❌ No OpenAI API key set for TTS');
    res.status(500).send('OpenAI TTS not configured');
    return;
  }

  const body = JSON.stringify({
    model: 'tts-1',
    voice: 'shimmer',
    input: text,
    response_format: 'mp3'
  });

  const options = {
    hostname: 'api.openai.com',
    path: '/v1/audio/speech',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const req = https.request(options, (apiResp) => {
    if (apiResp.statusCode !== 200) {
      let errBody = '';
      apiResp.on('data', chunk => errBody += chunk);
      apiResp.on('end', () => {
        console.error(`❌ OpenAI TTS error ${apiResp.statusCode}: ${errBody}`);
        res.status(500).send('TTS error');
      });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    apiResp.pipe(res);
  });

  req.on('error', (err) => {
    console.error('❌ OpenAI TTS request error:', err.message);
    if (!res.headersSent) res.status(500).send('TTS request failed');
  });

  req.write(body);
  req.end();
}

module.exports = { streamTTS };
