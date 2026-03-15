const https = require('https');

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9'; // Jessica — bubbly, expressive
const API_KEY = process.env.ELEVENLABS_API_KEY;
const MODEL_ID = 'eleven_flash_v2_5'; // fastest model, lowest latency

/**
 * Stream ElevenLabs TTS audio to an Express response
 * @param {string} text - Text to speak
 * @param {object} res - Express response object
 */
function streamTTS(text, res) {
  if (!API_KEY) {
    console.error('❌ ELEVENLABS_API_KEY not set');
    res.status(500).send('ElevenLabs not configured');
    return;
  }

  const body = JSON.stringify({
    text: text,
    model_id: MODEL_ID,
    voice_settings: {
      stability: 0.45,
      similarity_boost: 0.80,
      style: 0.35,
      use_speaker_boost: true
    }
  });

  const options = {
    hostname: 'api.elevenlabs.io',
    path: `/v1/text-to-speech/${VOICE_ID}/stream`,
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': API_KEY,
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const req = https.request(options, (elevResp) => {
    if (elevResp.statusCode !== 200) {
      let errBody = '';
      elevResp.on('data', chunk => errBody += chunk);
      elevResp.on('end', () => {
        console.error(`❌ ElevenLabs TTS error ${elevResp.statusCode}: ${errBody}`);
        res.status(500).send('TTS error');
      });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    elevResp.pipe(res);
  });

  req.on('error', (err) => {
    console.error('❌ ElevenLabs request error:', err.message);
    if (!res.headersSent) res.status(500).send('TTS request failed');
  });

  req.write(body);
  req.end();
}

module.exports = { streamTTS, VOICE_ID };
