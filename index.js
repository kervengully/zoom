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
  if (!signature) {
    return res.status(401).send('Unauthorized - No signature header');
  }

  const message = req.headers['x-zm-request-timestamp'] + req.rawBody;
  const hmac = crypto.createHmac('sha256', ZOOM_SECRET_TOKEN);
  hmac.update(message);
  const computedSignature = hmac.digest('hex');

  if (signature === computedSignature) {
    next();
  } else {
    res.status(401).send('Unauthorized - Invalid signature');
  }
}

// Route to handle Zoom webhooks
app.post('/zoom/webhook', verifyZoomRequest, (req, res) => {
  const { event, payload } = req.body;

  if (event === 'meeting.started') {
    handleMeetingStarted(payload);
  } else if (event === 'meeting.ended') {
    handleMeetingEnded(payload);
  }

  res.status(200).send();
});

// Function to handle meeting.started event
function handleMeetingStarted(payload) {
  const { id, topic, host_id, start_time } = payload.object;
  const data = {
    id: id.toString(),
    topic,
    host_id,
    start_time,
    end_time: '',
  };
  appendToCSV(data);
}

// Function to handle meeting.ended event
function handleMeetingEnded(payload) {
  const { id, end_time } = payload.object;
  updateCSV(id.toString(), end_time);
}

// Append new meeting data to CSV
function appendToCSV(data) {
  const fileExists = fs.existsSync(CSV_FILE_PATH);

  const writer = csvWriter.createObjectCsvWriter({
    path: CSV_FILE_PATH,
    header: [
      { id: 'id', title: 'ID' },
      { id: 'topic', title: 'Topic' },
      { id: 'host_id', title: 'Host ID' },
      { id: 'start_time', title: 'Start Time' },
      { id: 'end_time', title: 'End Time' },
    ],
    append: fileExists,
  });

  writer.writeRecords([data])
    .then(() => console.log('Meeting started data appended to CSV'))
    .catch((err) => console.error('Error writing to CSV:', err));
}

// Update existing meeting data with end_time in CSV
function updateCSV(meetingId, endTime) {
  if (!fs.existsSync(CSV_FILE_PATH)) {
    return console.error('CSV file does not exist');
  }

  const records = [];

  fs.createReadStream(CSV_FILE_PATH)
    .pipe(csvParser())
    .on('data', (data) => records.push(data))
    .on('end', () => {
      const index = records.findIndex((record) => record.id === meetingId);
      if (index !== -1) {
        records[index].end_time = endTime;
        writeToCSV(records);
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
      { id: 'id', title: 'ID' },
      { id: 'topic', title: 'Topic' },
      { id: 'host_id', title: 'Host ID' },
      { id: 'start_time', title: 'Start Time' },
      { id: 'end_time', title: 'End Time' },
    ],
  });

  writer.writeRecords(records)
    .then(() => console.log('CSV file updated with meeting end time'))
    .catch((err) => console.error('Error updating CSV:', err));
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
