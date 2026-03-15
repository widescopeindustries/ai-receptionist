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
/**
 * Industry-specific stats and language for voicemail scripts
 */
const INDUSTRY_HOOKS = {
  restaurant: {
    stat: `The average restaurant loses over 1,000 dollars a month from missed reservation and takeout calls`,
    action: `take orders, answer menu questions, book reservations`,
  },
  dental: {
    stat: `A single missed patient call costs a dental practice an average of 200 dollars`,
    action: `book appointments, answer insurance questions, and handle patient calls`,
  },
  legal: {
    stat: `Law firms lose an average of 250,000 dollars a year from missed calls... and a potential client who can't reach you calls the next attorney on Google`,
    action: `take client inquiries, schedule consultations, and make sure no case walks out the door`,
  },
  veterinary: {
    stat: `Vet clinics miss up to 30 percent of incoming calls during busy hours... and pet owners in a panic don't leave voicemails, they call the next clinic`,
    action: `schedule appointments, answer common questions, and make sure worried pet owners always reach someone`,
  },
  auto: {
    stat: `Auto shops lose an average of 3 to 5 customers a week from missed calls, and those customers just drive to the next shop`,
    action: `book service appointments, answer questions about availability, and capture every customer`,
  },
  salon: {
    stat: `Salons and barber shops lose up to 25 percent of potential bookings from missed calls... most people won't leave a voicemail, they'll just book somewhere else`,
    action: `book appointments, answer questions about services, and make sure every client gets through`,
  },
  chiropractic: {
    stat: `Healthcare practices lose an average of 15,000 dollars a year just from missing one patient call per day`,
    action: `schedule appointments, answer common questions, and make sure patients always reach your office`,
  },
  home_service: {
    stat: `For home service businesses, every single missed call costs an average of 12 hundred dollars`,
    action: `book appointments, capture every lead, and sound exactly like this`,
  },
  default: {
    stat: `The average small business loses over 60,000 dollars a year from missed calls`,
    action: `answer calls, book appointments, capture every lead, and sound exactly like this`,
  }
};

/**
 * Detect industry from business name
 */
function detectIndustry(businessName) {
  const name = (businessName || '').toLowerCase();
  
  if (/restaurant|cafe|kitchen|grill|bistro|taco|pizza|burger|bbq|barbecue|deli|bakery|coffee|tata|garcia/.test(name)) return 'restaurant';
  if (/dental|dentist|orthodont/.test(name)) return 'dental';
  if (/law|lawyer|attorney|legal|firm/.test(name)) return 'legal';
  if (/vet|animal|pet|clinic/.test(name)) return 'veterinary';
  if (/auto|tire|mechanic|car|body shop|collision/.test(name)) return 'auto';
  if (/salon|barber|hair|beauty|spa/.test(name)) return 'salon';
  if (/chiro|spine|wellness|injury clinic/.test(name)) return 'chiropractic';
  if (/hvac|plumb|electric|roof|pest|fence|tree|paint|remodel|garage|foundation|handyman|landscap|lawn|gutter|concrete|septic|heat|air|cool|mechanical/.test(name)) return 'home_service';
  
  return 'default';
}

function getVoicemailScript(businessName) {
  const greeting = businessName 
    ? `Hey there, this message is for the owner or manager at ${businessName}.`
    : `Hey there, this message is for the business owner.`;

  const industry = detectIndustry(businessName);
  const hook = INDUSTRY_HOOKS[industry] || INDUSTRY_HOOKS.default;

  return `${greeting} ` +
    `My name is Jessica and I'm actually an AI receptionist. ` +
    `I just called your business after hours and got your voicemail. ` +
    `Now here's the thing... I'm patient enough to leave you this message, ` +
    `but according to a recent study, 85 percent of callers won't do what I just did. ` +
    `They hang up and they call the next business that actually answers. ` +
    `And 62 percent of those people? They go straight to your competitor. ` +
    `That's not a guess, those are real numbers. ` +
    `${hook.stat}. ` +
    `So this voicemail right here? This is what your customers hear before they give up on you. ` +
    `I can make sure that never happens again. I answer every call, 24 7, ` +
    `${hook.action}. ` +
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
