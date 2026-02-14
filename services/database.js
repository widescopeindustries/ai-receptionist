const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Database Service - SQLite storage for leads, calls, and customers
 */
class DatabaseService {
  constructor() {
    const dbPath = path.join(__dirname, '..', 'data', 'receptionist.db');

    // Ensure data directory exists
    const fs = require('fs');
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initialize();
  }

  /**
   * Initialize database tables
   */
  initialize() {
    // Leads table - prospects who called
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT,
        email TEXT,
        company TEXT,
        interest_level TEXT DEFAULT 'unknown',
        notes TEXT,
        status TEXT DEFAULT 'new',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Calls table - all call records
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY,
        call_sid TEXT UNIQUE NOT NULL,
        lead_id TEXT,
        phone_from TEXT,
        phone_to TEXT,
        duration_seconds INTEGER DEFAULT 0,
        turn_count INTEGER DEFAULT 0,
        transcript TEXT,
        summary TEXT,
        outcome TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (lead_id) REFERENCES leads(id)
      )
    `);

    // Customers table - paying subscribers
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        company TEXT,
        phone TEXT,
        plan TEXT NOT NULL,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        status TEXT DEFAULT 'active',
        twilio_number TEXT,
        ai_config TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add business_id columns if they don't exist (migration for existing DBs)
    try { this.db.exec('ALTER TABLE leads ADD COLUMN business_id TEXT DEFAULT "widescope"'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE leads ADD COLUMN address TEXT'); } catch (e) { /* column exists */ }
    try { this.db.exec('ALTER TABLE calls ADD COLUMN business_id TEXT DEFAULT "widescope"'); } catch (e) { /* column exists */ }

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
      CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
      CREATE INDEX IF NOT EXISTS idx_calls_lead ON calls(lead_id);
      CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
      CREATE INDEX IF NOT EXISTS idx_customers_stripe ON customers(stripe_customer_id);
    `);

    console.log('✅ Database initialized');
  }

  // ==================== LEAD METHODS ====================

  /**
   * Create or update a lead from phone number
   */
  createOrUpdateLead(phone, data = {}) {
    const existing = this.db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);

    if (existing) {
      const updates = [];
      const values = [];

      if (data.name) { updates.push('name = ?'); values.push(data.name); }
      if (data.email) { updates.push('email = ?'); values.push(data.email); }
      if (data.company) { updates.push('company = ?'); values.push(data.company); }
      if (data.interest_level) { updates.push('interest_level = ?'); values.push(data.interest_level); }
      if (data.notes) { updates.push('notes = ?'); values.push(data.notes); }
      if (data.status) { updates.push('status = ?'); values.push(data.status); }

      if (updates.length > 0) {
        updates.push('updated_at = CURRENT_TIMESTAMP');
        values.push(phone);
        this.db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE phone = ?`).run(...values);
      }

      return this.db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
    } else {
      const id = uuidv4();
      this.db.prepare(`
        INSERT INTO leads (id, phone, name, email, company, interest_level, notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        phone,
        data.name || null,
        data.email || null,
        data.company || null,
        data.interest_level || 'unknown',
        data.notes || null,
        data.status || 'new'
      );

      return this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    }
  }

  /**
   * Get lead by phone number
   */
  getLeadByPhone(phone) {
    return this.db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
  }

  /**
   * Get all leads with optional filtering
   */
  getLeads(status = null, limit = 100) {
    if (status) {
      return this.db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
    }
    return this.db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  /**
   * Update lead status
   */
  updateLeadStatus(leadId, status) {
    this.db.prepare('UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, leadId);
  }

  // ==================== CALL METHODS ====================

  /**
   * Create a call record
   */
  createCall(callSid, phoneFrom, phoneTo, businessId = 'widescope') {
    const id = uuidv4();

    // Get or create lead
    const lead = this.createOrUpdateLead(phoneFrom, { business_id: businessId });

    this.db.prepare(`
      INSERT INTO calls (id, call_sid, lead_id, phone_from, phone_to, business_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, callSid, lead.id, phoneFrom, phoneTo, businessId);

    return { callId: id, leadId: lead.id };
  }

  /**
   * Update call with transcript and outcome
   */
  updateCall(callSid, data) {
    const updates = [];
    const values = [];

    if (data.duration_seconds !== undefined) { updates.push('duration_seconds = ?'); values.push(data.duration_seconds); }
    if (data.turn_count !== undefined) { updates.push('turn_count = ?'); values.push(data.turn_count); }
    if (data.transcript) { updates.push('transcript = ?'); values.push(data.transcript); }
    if (data.summary) { updates.push('summary = ?'); values.push(data.summary); }
    if (data.outcome) { updates.push('outcome = ?'); values.push(data.outcome); }

    if (updates.length > 0) {
      values.push(callSid);
      this.db.prepare(`UPDATE calls SET ${updates.join(', ')} WHERE call_sid = ?`).run(...values);
    }
  }

  /**
   * Get call by SID
   */
  getCallBySid(callSid) {
    return this.db.prepare('SELECT * FROM calls WHERE call_sid = ?').get(callSid);
  }

  /**
   * Get calls for a lead
   */
  getCallsForLead(leadId) {
    return this.db.prepare('SELECT * FROM calls WHERE lead_id = ? ORDER BY created_at DESC').all(leadId);
  }

  // ==================== CUSTOMER METHODS ====================

  /**
   * Create a customer
   */
  createCustomer(data) {
    const id = uuidv4();

    this.db.prepare(`
      INSERT INTO customers (id, email, name, company, phone, plan, stripe_customer_id, stripe_subscription_id, ai_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.email,
      data.name || null,
      data.company || null,
      data.phone || null,
      data.plan,
      data.stripe_customer_id || null,
      data.stripe_subscription_id || null,
      data.ai_config ? JSON.stringify(data.ai_config) : null
    );

    return this.db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  }

  /**
   * Get customer by email
   */
  getCustomerByEmail(email) {
    return this.db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
  }

  /**
   * Get customer by Stripe customer ID
   */
  getCustomerByStripeId(stripeCustomerId) {
    return this.db.prepare('SELECT * FROM customers WHERE stripe_customer_id = ?').get(stripeCustomerId);
  }

  /**
   * Update customer subscription
   */
  updateCustomerSubscription(stripeCustomerId, subscriptionId, status) {
    this.db.prepare(`
      UPDATE customers
      SET stripe_subscription_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE stripe_customer_id = ?
    `).run(subscriptionId, status, stripeCustomerId);
  }

  /**
   * Get all active customers
   */
  getActiveCustomers() {
    return this.db.prepare("SELECT * FROM customers WHERE status = 'active'").all();
  }

  // ==================== STATS ====================

  /**
   * Get dashboard stats
   */
  getStats() {
    const totalLeads = this.db.prepare('SELECT COUNT(*) as count FROM leads').get().count;
    const newLeads = this.db.prepare("SELECT COUNT(*) as count FROM leads WHERE status = 'new'").get().count;
    const totalCalls = this.db.prepare('SELECT COUNT(*) as count FROM calls').get().count;
    const activeCustomers = this.db.prepare("SELECT COUNT(*) as count FROM customers WHERE status = 'active'").get().count;

    const recentLeads = this.db.prepare(`
      SELECT * FROM leads ORDER BY created_at DESC LIMIT 5
    `).all();

    const recentCalls = this.db.prepare(`
      SELECT c.*, l.phone, l.name as lead_name
      FROM calls c
      LEFT JOIN leads l ON c.lead_id = l.id
      ORDER BY c.created_at DESC LIMIT 5
    `).all();

    return {
      totalLeads,
      newLeads,
      totalCalls,
      activeCustomers,
      recentLeads,
      recentCalls
    };
  }
}

module.exports = new DatabaseService();
