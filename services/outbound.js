const twilio = require('twilio');
const { v4: uuidv4 } = require('uuid');

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
    }
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER || '+18175338424';
const BASE_URL = process.env.BASE_URL || 'https://aialwaysanswer.com';

/**
 * The voicemail script Jessica leaves.
 * This IS the proof of concept — the voicemail demonstrates the problem.
 */
function getVoicemailScript(businessName) {
  // If we know the business name, personalize it
  const greeting = businessName 
    ? `Hi, this message is for the owner or manager at ${businessName}.`
    : `Hi, this message is for the business owner.`;

  return `${greeting} ` +
    `My name is Jessica and I'm actually an AI receptionist. ` +
    `I just called your business after hours and got your voicemail. ` +
    `Now here's the thing... I'm patient enough to leave you this message, ` +
    `but your last 4 customers who called after hours? They weren't. ` +
    `They hung up and called someone who answered. ` +
    `This voicemail is your proof that you're losing real jobs to competitors ` +
    `every single night your phone goes to voicemail. ` +
    `I can answer your phones 24 7, book appointments, capture every lead, ` +
    `and sound exactly like this... for 99 dollars a month. ` +
    `Call me back at 8 1 7, 5 3 3, 8 4 2 4. ` +
    `That's 8 1 7, 5 3 3, 8 4 2 4. ` +
    `I answer every call. Even the ones you're missing right now. ` +
    `Talk soon!`;
}

/**
 * Make an outbound call with AMD (Answering Machine Detection).
 * If voicemail detected → leave the message via TTS.
 * If human answers → play a shorter live pitch.
 */
async function callProspect({ phone, businessName, prospectId }) {
  const callId = uuidv4();
  
  try {
    const call = await getClient().calls.create({
      to: phone,
      from: FROM_NUMBER,
      url: `${BASE_URL}/outbound/voicemail-handler?id=${callId}&name=${encodeURIComponent(businessName || '')}&prospectId=${prospectId || ''}`,
      statusCallback: `${BASE_URL}/outbound/status?id=${callId}&prospectId=${prospectId || ''}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      machineDetection: 'DetectMessageEnd',  // Wait for beep, then speak
      machineDetectionTimeout: 30,
      timeout: 30,  // Ring for 30 seconds max
    });

    console.log(`📞 Outbound call initiated: ${call.sid} → ${phone} (${businessName || 'unknown'})`);
    
    return {
      callId,
      callSid: call.sid,
      phone,
      businessName,
      status: 'initiated'
    };
  } catch (err) {
    console.error(`❌ Outbound call failed to ${phone}:`, err.message);
    return {
      callId,
      phone,
      businessName,
      status: 'failed',
      error: err.message
    };
  }
}

/**
 * Batch call multiple prospects with a delay between each.
 * @param {Array} prospects - [{phone, businessName, prospectId}]
 * @param {number} delayMs - delay between calls (default 5s)
 */
async function batchCall(prospects, delayMs = 5000) {
  const results = [];
  
  for (let i = 0; i < prospects.length; i++) {
    const prospect = prospects[i];
    console.log(`📞 Calling ${i + 1}/${prospects.length}: ${prospect.businessName || prospect.phone}`);
    
    const result = await callProspect(prospect);
    results.push(result);
    
    // Delay between calls to avoid Twilio rate limits
    if (i < prospects.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}

module.exports = { callProspect, batchCall, getVoicemailScript, FROM_NUMBER, BASE_URL };
