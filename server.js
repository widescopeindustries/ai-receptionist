require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;
const AIService = require('./services/ai-service');
const ConversationManager = require('./services/conversation-manager');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Store active conversations (in production, use Redis or database)
const conversations = new Map();

// Initialize AI Service
const aiService = new AIService();

/**
 * Root endpoint - simple health check for Railway
 */
app.get('/', (req, res) => {
  res.send('AI Receptionist is active and ready to close! 🚀');
});

/**
 * Utility to strip emojis from text so they aren't read out loud by TTS
 */
function cleanTextForTTS(text) {
  if (!text) return "";
  // Regular expression to match emojis and other non-ASCII characters that might confuse TTS
  return text.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '');
}

/**
 * Main webhook endpoint - Twilio calls this when someone dials your number
 */
app.post('/voice/incoming', async (req, res) => {
  console.log('📞 Incoming call from:', req.body.From);

  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;

  // Initialize conversation for this call
  const conversationManager = new ConversationManager(callSid);
  conversations.set(callSid, conversationManager);

  // Greet the caller with HIGH ENERGY and a proactive walk-through!
  const greeting = "Hello! Thanks for calling AI Always Answer! I'm THE Closer, your turbo-charged AI receptionist! Look, you're here because every missed call is a missed deal, and we're putting a stop to that right now! I'm going to walk you through exactly how I handle your calls, schedule your appointments, and keep your business running twenty-four seven like a champion! Ready to hear how we get you live today?";

  // Start listening for caller's response
  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/process-speech',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true
  });

  gather.say({
    voice: 'Polly.Joanna',
    language: 'en-US'
  }, greeting);

  // Add the greeting to conversation history
  conversationManager.addMessage('assistant', greeting);

  // If no input, prompt again
  twiml.redirect('/voice/no-input');

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * Process speech input from caller
 */
app.post('/voice/process-speech', async (req, res) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult;

  console.log('🗣️  Caller said:', userSpeech);

  try {
    // Get conversation for this call
    let conversationManager = conversations.get(callSid);

    if (!conversationManager) {
      console.log(`⚠️ Conversation ${callSid} not found, initializing new session.`);
      conversationManager = new ConversationManager(callSid);
      conversations.set(callSid, conversationManager);
    }

    // Add user message to history (handle case where SpeechResult is undefined)
    if (userSpeech) {
      conversationManager.addMessage('user', userSpeech);
    } else {
      console.log('🗣️ No speech result provided by Twilio.');
      twiml.redirect('/voice/no-input');
      return res.send(twiml.toString());
    }

    // Get AI response
    let aiResponse = await aiService.getResponse(
      conversationManager.getHistory(),
      userSpeech
    );

    console.log('🤖 AI responds (original):', aiResponse);    
    // Clean emojis for TTS
    aiResponse = cleanTextForTTS(aiResponse);
    
    console.log('🤖 AI responds (cleaned):', aiResponse);

    // Add AI response to history
    conversationManager.addMessage('assistant', aiResponse);

    // Check if conversation should end
    if (conversationManager.shouldEndCall(aiResponse)) {
      twiml.say({
        voice: 'Polly.Joanna',
        language: 'en-US'
      }, aiResponse);
      
      twiml.say({
        voice: 'Polly.Joanna',
        language: 'en-US'
      }, 'Have a great day! Goodbye!');

      twiml.hangup();
      conversations.delete(callSid);
    } else {
      // Continue listening with barge-in enabled
      const gather = twiml.gather({
        input: 'speech',
        action: '/voice/process-speech',
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        enhanced: true
      });

      gather.say({
        voice: 'Polly.Joanna',
        language: 'en-US'
      }, aiResponse);

      twiml.redirect('/voice/no-input');
    }
  } catch (error) {
    console.error('❌ Error processing speech:', error.message);

    twiml.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, "I apologize, but I had a brief tech hiccup because I was just too excited! Let's get right back to business!");

    // Redirect to incoming to re-initialize and greet again safely
    twiml.redirect('/voice/incoming');
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * Handle no input scenario
 */
app.post('/voice/no-input', (req, res) => {
  const twiml = new VoiceResponse();

  twiml.say({
    voice: 'Polly.Joanna',
    language: 'en-US'
  }, "Hey there! Still with me? I'm ready to rock whenever you are! What can I do for you?");

  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/process-speech',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true
  });

  twiml.say({
    voice: 'Polly.Joanna',
    language: 'en-US'
  }, "If you're ready to make things happen, just say the word or press any key!");

  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

/**
 * Handle call status updates
 */
app.post('/voice/status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  console.log(`📊 Call ${callSid} status: ${callStatus}`);

  // Clean up conversation when call ends
  if (callStatus === 'completed' || callStatus === 'failed') {
    conversations.delete(callSid);
  }

  res.sendStatus(200);
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeConversations: conversations.size,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 AI Receptionist server running on port ${PORT}`);
  console.log(`📱 Webhook URL: ${process.env.BASE_URL || `http://localhost:${PORT}`}/voice/incoming`);
});

module.exports = app;