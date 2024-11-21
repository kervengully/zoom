require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

// Middleware to parse JSON
app.use(express.json());

// CSV file path
const csvFilePath = path.join(__dirname, 'attendance.csv');

// Ensure the CSV file exists and has headers
if (!fs.existsSync(csvFilePath)) {
    console.log('Attendance file does not exist. Creating it...');
    fs.writeFileSync(csvFilePath, 'id,topic,host_id,start_time,end_time\n');
    console.log('Attendance file created successfully.');
} else {
    console.log('Attendance file exists. Proceeding...');
}

// Validate Zoom webhook
const validateZoomWebhook = (req) => {
    const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;
    const hash = crypto.createHmac('sha256', ZOOM_WEBHOOK_SECRET).update(message).digest('hex');
    const signature = `v0=${hash}`;
    return signature === req.headers['x-zm-signature'];
};

// Save meeting data to CSV
const saveMeetingToCSV = (data) => {
    console.log(`Saving meeting started data for ID: ${data.id}`);
    const csvData = `${data.id},${data.topic},${data.host_id},${data.start_time || ''},${data.end_time || ''}\n`;
    fs.appendFileSync(csvFilePath, csvData);
    console.log('Meeting started data saved successfully.');
};

// Update meeting end time in CSV
const updateMeetingEndTimeInCSV = (id, endTime) => {
    console.log(`Updating meeting ended data for ID: ${id}`);
    const csvData = fs.readFileSync(csvFilePath, 'utf8').split('\n');
    const updatedData = csvData.map((line) => {
        const fields = line.split(',');
        if (fields[0] === id) {
            fields[4] = endTime;
            console.log(`End time updated for meeting ID: ${id}`);
            return fields.join(',');
        }
        return line;
    }).join('\n');
    fs.writeFileSync(csvFilePath, updatedData);
    console.log('Meeting ended data updated successfully.');
};

app.post('/webhook', (req, res) => {
    console.log('Webhook received:', req.body);

    if (!validateZoomWebhook(req)) {
        console.log('Invalid webhook signature.');
        return res.status(400).send('Invalid request');
    }

    const event = req.body.event;
    const payload = req.body.payload?.object;

    if (!payload) {
        console.log('Invalid payload: Missing object.');
        return res.status(400).send('Invalid payload');
    }

    if (event === 'meeting.started') {
        console.log('Meeting started event received.');

        if (!payload.id || !payload.topic || !payload.host_id || !payload.start_time) {
            console.log('Invalid payload: Missing required fields for meeting.started.');
            return res.status(400).send('Invalid payload for meeting.started');
        }

        const meetingData = {
            id: payload.id,
            topic: payload.topic,
            host_id: payload.host_id,
            start_time: payload.start_time,
        };
        saveMeetingToCSV(meetingData);
        res.status(200).send('Meeting started logged');
    } else if (event === 'meeting.ended') {
        console.log('Meeting ended event received.');

        if (!payload.id || !payload.end_time) {
            console.log('Invalid payload: Missing required fields for meeting.ended.');
            return res.status(400).send('Invalid payload for meeting.ended');
        }

        const meetingId = payload.id;
        const endTime = payload.end_time;
        updateMeetingEndTimeInCSV(meetingId, endTime);
        res.status(200).send('Meeting ended logged');
    } else {
        console.log(`Unhandled event type: ${event}`);
        res.status(400).send('Event not handled');
    }
});

app.listen(port, () => {
    console.log(`Zoom webhook listener running on port ${port}`);
});
