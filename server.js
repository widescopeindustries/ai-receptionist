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
 * Main webhook endpoint - Twilio calls this when someone dials your number
 */
app.post('/voice/incoming', async (req, res) => {
  console.log('📞 Incoming call from:', req.body.From);

  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;

  // Initialize conversation for this call
  const conversationManager = new ConversationManager(callSid);
  conversations.set(callSid, conversationManager);

  // Greet the caller with HIGH ENERGY!
  const greeting = "Hello! Thanks for calling AI Always Answer! I'm THE Closer, your turbo-charged AI receptionist, and I am pumped to help you today! What's on your mind?";

  twiml.say({
    voice: 'Polly.Joanna',
    language: 'en-US'
  }, greeting);

  // Add the greeting to conversation history
  conversationManager.addMessage('assistant', greeting);

  // Start listening for caller's response
  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/process-speech',
    speechTimeout: 'auto',
    speechModel: 'phone_call',
    enhanced: true
  });

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
    const conversationManager = conversations.get(callSid);

    if (!conversationManager) {
      throw new Error('Conversation not found');
    }

    // Add user message to history
    conversationManager.addMessage('user', userSpeech);

    // Get AI response
    const aiResponse = await aiService.getResponse(
      conversationManager.getHistory(),
      userSpeech
    );

    console.log('🤖 AI responds:', aiResponse);

    // Add AI response to history
    conversationManager.addMessage('assistant', aiResponse);

    // Speak the AI response
    twiml.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, aiResponse);

    // Check if conversation should end
    if (conversationManager.shouldEndCall(aiResponse)) {
      twiml.say({
        voice: 'Polly.Joanna',
        language: 'en-US'
      }, 'Have a great day! Goodbye!');

      twiml.hangup();
      conversations.delete(callSid);
    } else {
      // Continue listening
      const gather = twiml.gather({
        input: 'speech',
        action: '/voice/process-speech',
        speechTimeout: 'auto',
        speechModel: 'phone_call',
        enhanced: true
      });

      twiml.redirect('/voice/no-input');
    }
  } catch (error) {
    console.error('❌ Error processing speech:', error);

    twiml.say({
      voice: 'Polly.Joanna',
      language: 'en-US'
    }, 'I apologize, I\'m having trouble understanding. Could you please repeat that?');

    twiml.redirect('/voice/process-speech');
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
