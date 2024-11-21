const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const csvParser = require('csv-parser');
const csvWriter = require('csv-writer');

// Load environment variables from a .env file
require('dotenv').config();

const app = express();

// Middleware to capture raw body for HMAC verification
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
}));

const PORT = process.env.PORT || 3000;

// Use the secret token from the environment variable
const ZOOM_SECRET_TOKEN = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

if (!ZOOM_SECRET_TOKEN) {
  console.error('ZOOM_WEBHOOK_SECRET_TOKEN is not set in the environment variables.');
  process.exit(1);
}

// Path to the CSV file
const CSV_FILE_PATH = 'attendance.csv';

// Function to verify Zoom webhook requests using HMAC
function verifyZoomRequest(req, res, next) {
  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];

  if (!signature || !timestamp) {
    console.error('Unauthorized - Missing headers');
    return res.status(401).send('Unauthorized - Missing headers');
  }

  // Validate timestamp to be within 5 minutes
  const timeDifference = Math.abs(Date.now() - timestamp * 1000);
  if (timeDifference > 300000) { // 5 minutes in milliseconds
    console.error('Unauthorized - Request too old');
    return res.status(401).send('Unauthorized - Request too old');
  }

  const message = timestamp + req.rawBody;
  const hmac = crypto.createHmac('sha256', ZOOM_SECRET_TOKEN);
  hmac.update(message);
  const computedSignature = hmac.digest('hex');

  if (signature === computedSignature) {
    next();
  } else {
    console.error('Unauthorized - Invalid signature');
    res.status(401).send('Unauthorized - Invalid signature');
  }
}

// Ensure the CSV file exists and has headers
function initializeCSV() {
  if (!fs.existsSync(CSV_FILE_PATH)) {
    console.log('attendance.csv does not exist. Creating file with headers.');
    const headers = 'ID,Topic,Host ID,Start Time,End Time\n';
    fs.writeFileSync(CSV_FILE_PATH, headers);
    console.log('attendance.csv file created.');
  } else {
    console.log('attendance.csv file exists.');
  }
}

// Initialize the CSV file
initializeCSV();

// Route to handle Zoom webhooks
app.post('/webhook', (req, res, next) => {
  const { event, payload } = req.body;

  console.log(`Received event: ${event}`);

  // Handle Zoom endpoint validation
  if (event === 'endpoint.url_validation') {
    const plainToken = payload.plainToken;
    const encryptedToken = crypto
      .createHmac('sha256', ZOOM_SECRET_TOKEN)
      .update(plainToken)
      .digest('hex');

    console.log('Endpoint URL validation requested.');
    return res.status(200).json({
      plainToken,
      encryptedToken,
    });
  } else {
    // Proceed to HMAC verification middleware
    next();
  }
}, verifyZoomRequest, (req, res) => {
  const { event, payload } = req.body;

  if (event === 'meeting.started') {
    handleMeetingStarted(payload);
  } else if (event === 'meeting.ended') {
    handleMeetingEnded(payload);
  } else {
    console.log(`Unhandled event type: ${event}`);
  }

  res.status(200).send();
});

// Function to handle meeting.started event
function handleMeetingStarted(payload) {
  const { id, topic, host_id, start_time } = payload.object;
  const data = {
    ID: id.toString(),
    Topic: topic,
    'Host ID': host_id,
    'Start Time': start_time,
    'End Time': '',
  };
  console.log(`Handling meeting.started for meeting ID: ${data.ID}`);
  appendToCSV(data);
}

// Function to handle meeting.ended event
function handleMeetingEnded(payload) {
  const { id, end_time } = payload.object;
  console.log(`Handling meeting.ended for meeting ID: ${id}`);
  updateCSV(id.toString(), end_time);
}

// Append new meeting data to CSV
function appendToCSV(data) {
  const writer = csvWriter.createObjectCsvWriter({
    path: CSV_FILE_PATH,
    header: [
      { id: 'ID', title: 'ID' },
      { id: 'Topic', title: 'Topic' },
      { id: 'Host ID', title: 'Host ID' },
      { id: 'Start Time', title: 'Start Time' },
      { id: 'End Time', title: 'End Time' },
    ],
    append: true, // Always append to the file
  });

  writer.writeRecords([data])
    .then(() => console.log(`Meeting started data appended to CSV for meeting ID: ${data.ID}`))
    .catch((err) => console.error('Error writing to CSV:', err));
}

// Update existing meeting data with end_time in CSV
function updateCSV(meetingId, endTime) {
  if (!fs.existsSync(CSV_FILE_PATH)) {
    console.error('CSV file does not exist');
    return;
  }

  const records = [];

  fs.createReadStream(CSV_FILE_PATH)
    .pipe(csvParser())
    .on('data', (data) => records.push(data))
    .on('end', () => {
      const index = records.findIndex((record) => record.ID === meetingId);
      if (index !== -1) {
        records[index]['End Time'] = endTime;
        writeToCSV(records);
        console.log(`Updated end_time in CSV for meeting ID: ${meetingId}`);
      } else {
        console.error(`Meeting with ID ${meetingId} not found in CSV`);
      }
    });
}

// Write updated records back to CSV
function writeToCSV(records) {
  const writer = csvWriter.createObjectCsvWriter({
    path: CSV_FILE_PATH,
    header: [
      { id: 'ID', title: 'ID' },
      { id: 'Topic', title: 'Topic' },
      { id: 'Host ID', title: 'Host ID' },
      { id: 'Start Time', title: 'Start Time' },
      { id: 'End Time', title: 'End Time' },
    ],
  });

  writer.writeRecords(records)
    .then(() => console.log('CSV file updated with meeting end time'))
    .catch((err) => console.error('Error updating CSV:', err));
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
