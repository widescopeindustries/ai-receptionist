const { google } = require('googleapis');
const path = require('path');

class GoogleCalendarService {
  constructor() {
    // Path to your service account key file
    const keyPath = path.join('C:', 'Users', 'molyndon', '.openclaw', 'clawdisus-9f2b02302578.json');
    
    this.scopes = ['https://www.googleapis.com/auth/calendar'];
    this.auth = new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: this.scopes,
    });
    
    this.calendar = google.calendar({ version: 'v3', auth: this.auth });
  }

  /**
   * Book an appointment
   * @param {Object} details Appointment details
   * @param {string} details.summary Title of the event
   * @param {string} details.description Description of the event
   * @param {string} details.startTime ISO string for start time
   * @param {string} details.endTime ISO string for end time
   * @param {string} details.attendeeEmail Email of the lead
   */
  async bookAppointment(details) {
    try {
      const event = {
        summary: details.summary,
        description: details.description,
        start: {
          dateTime: details.startTime,
          timeZone: 'America/Chicago',
        },
        end: {
          dateTime: details.endTime,
          timeZone: 'America/Chicago',
        },
        attendees: [
          { email: details.attendeeEmail },
        ],
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 },
            { method: 'popup', minutes: 30 },
          ],
        },
      };

      const response = await this.calendar.events.insert({
        calendarId: 'primary',
        resource: event,
        sendUpdates: 'all',
      });

      console.log('✅ Appointment booked:', response.data.htmlLink);
      return {
        success: true,
        link: response.data.htmlLink,
        id: response.data.id
      };
    } catch (error) {
      console.error('❌ Error booking appointment:', error);
      throw error;
    }
  }

  /**
   * List upcoming events
   */
  async listEvents(maxResults = 10) {
    try {
      const response = await this.calendar.events.list({
        calendarId: 'primary',
        timeMin: new Date().toISOString(),
        maxResults: maxResults,
        singleEvents: true,
        orderBy: 'startTime',
      });
      return response.data.items;
    } catch (error) {
      console.error('❌ Error listing events:', error);
      throw error;
    }
  }
}

module.exports = new GoogleCalendarService();
