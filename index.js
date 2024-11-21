require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const nodemailer = require('nodemailer');
const { format } = require('date-fns');
const { parse } = require('date-fns-tz');

const app = express();
const port = process.env.PORT || 3000;
const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
const IT_EMAIL = process.env.IT_EMAIL;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

// CSV and JSON file paths
const csvFilePath = path.join(__dirname, 'attendance.csv');
const coursesFilePath = path.join(__dirname, 'courses.json');

// Middleware to parse JSON
app.use(express.json());

// Ensure the CSV file exists and has headers
if (!fs.existsSync(csvFilePath)) {
    console.log('Attendance file does not exist. Creating it...');
    fs.writeFileSync(csvFilePath, 'id,topic,host_id,start_time,end_time\n');
    console.log('Attendance file created successfully.');
} else {
    console.log('Attendance file exists. Proceeding...');
}

// Configure SMTP transporter
const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
    },
});

// Validate Zoom webhook
const validateZoomWebhook = (req) => {
    const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;
    const hash = crypto.createHmac('sha256', ZOOM_WEBHOOK_SECRET).update(message).digest('hex');
    const signature = `v0=${hash}`;
    return signature === req.headers['x-zm-signature'];
};

// Load today's courses
let todaysCourses = [];
const loadTodaysCourses = () => {
    console.log('Loading today\'s courses...');
    try {
        const coursesData = JSON.parse(fs.readFileSync(coursesFilePath, 'utf8'));
        const todayWeekDay = format(new Date(), 'EEEE');
        todaysCourses = coursesData.courses.filter(course => course.week_day === todayWeekDay);
        console.log('Today\'s courses loaded:', todaysCourses);
    } catch (err) {
        console.error('Failed to load courses:', err.message);
    }
};

// Check meeting attendance
const checkMeetingAttendance = async (course) => {
    console.log(`Checking attendance for course: ${course.topic} at ${course.scheduled_time}`);
    try {
        const attendanceData = fs.readFileSync(csvFilePath, 'utf8').split('\n').slice(1).map(line => {
            const [id, topic, host_id, start_time] = line.split(',');
            return { id, topic: topic.trim(), host_id, start_time: start_time.trim() };
        });

        // Compare topics to check if the meeting has started
        const meetingExists = attendanceData.some(meeting => meeting.topic === course.topic);

        if (!meetingExists) {
            console.log(`Meeting not started for course: ${course.topic}. Sending email to IT.`);
            await transporter.sendMail({
                from: SMTP_USER,
                to: IT_EMAIL,
                subject: `Meeting Not Started: ${course.topic}`,
                text: `The scheduled meeting for "${course.topic}" at ${course.scheduled_time} (UK time) has not started.`,
            });
            console.log('Email sent to IT successfully.');
        } else {
            console.log(`Meeting for course: ${course.topic} has started.`);
        }
    } catch (err) {
        console.error('Failed to check attendance or send email:', err.message);
    }
};

// Schedule daily course checks at 04:00
schedule.scheduleJob('0 4 * * *', () => {
    loadTodaysCourses();
    todaysCourses.forEach(course => {
        const [hour, minute] = course.scheduled_time.split(':').map(Number);
        schedule.scheduleJob({ hour, minute, tz: 'Europe/London' }, () => checkMeetingAttendance(course));
    });
});

// Load courses on server start and set up checks for today's courses
loadTodaysCourses();
todaysCourses.forEach(course => {
    const [hour, minute] = course.scheduled_time.split(':').map(Number);
    schedule.scheduleJob({ hour, minute, tz: 'Europe/London' }, () => checkMeetingAttendance(course));
});

// Zoom webhook endpoint
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
        fs.appendFileSync(csvFilePath, `${meetingData.id},${meetingData.topic},${meetingData.host_id},${meetingData.start_time},\n`);
        console.log('Meeting started data saved successfully.');
        res.status(200).send('Meeting started logged');
    } else if (event === 'meeting.ended') {
        console.log('Meeting ended event received.');

        if (!payload.id || !payload.start_time || !payload.end_time) {
            console.log('Invalid payload: Missing required fields for meeting.ended.');
            return res.status(400).send('Invalid payload for meeting.ended');
        }

        const meetingId = payload.id;
        const startTime = payload.start_time;
        const endTime = payload.end_time;

        const csvData = fs.readFileSync(csvFilePath, 'utf8').split('\n');
        const updatedData = csvData.map(line => {
            const fields = line.split(',');
            if (fields[0] === meetingId && fields[3] === startTime && !fields[4]) {
                fields[4] = endTime;
                return fields.join(',');
            }
            return line;
        }).join('\n');

        fs.writeFileSync(csvFilePath, updatedData);
        console.log('Meeting ended data updated successfully.');
        res.status(200).send('Meeting ended logged');
    } else {
        console.log(`Unhandled event type: ${event}`);
        res.status(400).send('Event not handled');
    }
});

app.listen(port, () => {
    console.log(`Zoom webhook listener running on port ${port}`);
});
