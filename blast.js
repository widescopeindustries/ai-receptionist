const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 587,
  secure: false,
  auth: { user: 'sales@aialwaysanswer.com', pass: '_(H5kHC;j}e,tw}' }
});

const targets = [
  { name: 'Team',    business: 'Patriot Plumbing Solutions',           email: 'anapbm@gmail.com',                  industry: 'plumbing' },
  { name: 'David',   business: 'Maverick Plumbing & Air Conditioning', email: 'david@choosemaverick.com',           industry: 'hvac'     },
  { name: 'Juanita', business: 'E & S Plumbing LLC',                   email: 'juanita@e-splumbingllc.com',        industry: 'plumbing' },
  { name: 'Team',    business: 'Workman Plumbing',                     email: 'workmanplumbingdfw@gmail.com',      industry: 'plumbing' },
  { name: 'Team',    business: 'Prestige Plumbing Pro',                email: 'prestigeplumbingpro@gmail.com',     industry: 'plumbing' },
  { name: 'Team',    business: 'Water Heater Dallas TX',               email: 'service@waterheaterdallastx.com',   industry: 'plumbing' },
];

const hooks = {
  plumbing: "When someone has a burst pipe at midnight, the first plumber who answers gets the job.",
  hvac:     "When someone's AC dies in July, the first HVAC company who answers gets the call.",
};

function buildEmail(t) {
  const hook = hooks[t.industry] || hooks.plumbing;
  const subject = t.name !== 'Team'
    ? `${t.name} — is ${t.business} answering after hours?`
    : `Is ${t.business} answering after hours?`;

  const html = `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:15px;line-height:1.7">
<p>Hi ${t.name},</p>
<p>${hook}</p>
<p>Is that you — or your voicemail?</p>
<p>We built an AI receptionist that answers every call instantly, 24/7, books appointments, and texts you the lead details. <strong>$99/month.</strong> Sounds like a real person.</p>
<p>Don't take my word for it — <strong>call this number right now and hear it live:</strong></p>
<p style="text-align:center;margin:28px 0">
  <a href="tel:8175338424" style="background:#2563eb;color:white;font-size:22px;font-weight:bold;padding:14px 36px;border-radius:8px;text-decoration:none;display:inline-block">
    📞 (817) 533-8424
  </a>
</p>
<p>That AI just answered your call. It can do the same for <em>${t.business}</em> starting tonight.</p>
<p>14-day money-back guarantee. No contracts. Live in under an hour.</p>
<p><a href="https://aialwaysanswer.com?ref=email" style="color:#2563eb">See how it works →</a></p>
<p style="margin-top:32px;color:#888;font-size:13px">
  — Lyndon<br>
  AI Always Answer<br>
  <a href="mailto:sales@aialwaysanswer.com" style="color:#888">sales@aialwaysanswer.com</a><br><br>
  <a href="mailto:sales@aialwaysanswer.com?subject=Unsubscribe" style="color:#bbb;font-size:12px">Unsubscribe</a>
</p>
</body>
</html>`;

  const text = `Hi ${t.name},

${hook}

Is that you — or your voicemail?

We built an AI receptionist that answers every call instantly, 24/7, books appointments, and texts you the lead details. $99/month. Sounds like a real person.

Call this number right now and hear it live: (817) 533-8424

That AI just answered your call. It can do the same for ${t.business} starting tonight.

14-day money-back guarantee. No contracts. Live in under an hour.

https://aialwaysanswer.com

— Lyndon
AI Always Answer
sales@aialwaysanswer.com

To unsubscribe, reply with "unsubscribe"`;

  return { subject, html, text };
}

async function send() {
  for (const t of targets) {
    const { subject, html, text } = buildEmail(t);
    try {
      await transporter.sendMail({
        from: '"AI Always Answer" <sales@aialwaysanswer.com>',
        to: t.email,
        subject,
        html,
        text,
      });
      console.log(`✅ SENT → ${t.email} (${t.business})`);
    } catch (e) {
      console.log(`❌ FAIL → ${t.email}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('\nDone.');
}

send();
