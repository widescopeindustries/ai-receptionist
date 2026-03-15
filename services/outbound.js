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
  const greeting = businessName 
    ? `Hey there, this message is for the owner or manager at ${businessName}.`
    : `Hey there, this message is for the business owner.`;

  return `${greeting} ` +
    `My name is Jessica and I'm actually an AI receptionist. ` +
    `I just called your business after hours and got your voicemail. ` +
    `Now here's the thing... I'm patient enough to leave you this message, ` +
    `but according to a recent study, 85 percent of callers won't do what I just did. ` +
    `They hang up and they call the next company that actually answers. ` +
    `And 62 percent of those people? They go straight to your competitor. ` +
    `That's not a guess, those are real numbers. ` +
    `For home service businesses, every single missed call costs an average of 12 hundred dollars. ` +
    `So this voicemail right here? This is what your customers hear before they give up on you. ` +
    `I can make sure that never happens again. I answer every call, 24 7, ` +
    `book appointments, capture every lead, and sound exactly like this. ` +
    `And you are not gonna believe how affordable it is to never lose a customer again. ` +
    `99 bucks a month. That's it. ` +
    `So call me back at 8 1 7, 5 3 3, 8 4 2 4. ` +
    `That's 8 1 7, 5 3 3, 8 4 2 4. ` +
    `And don't worry about the time or what day it is... ` +
    `that's kind of the whole point, right? ` +
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
      statusCallback: `${BASE_URL}/outbound/status?id=${callId}&name=${encodeURIComponent(businessName || '')}&prospectId=${prospectId || ''}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,  // Record every call for review
      recordingStatusCallback: `${BASE_URL}/outbound/recording?id=${callId}`,
      recordingStatusCallbackMethod: 'POST',
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
