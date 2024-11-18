// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const moment = require('moment-timezone');
const crypto = require('crypto');
const nodeCron = require('node-cron');
const nodemailer = require('nodemailer');
const { createObjectCsvWriter } = require('csv-writer');

const app = express();
const port = process.env.PORT || 3600;

app.use(express.json());

// Paths
const coursesJsonPath = 'courses.json';

// Load courses data
let courses = [];
try {
  const coursesData = fs.readFileSync(coursesJsonPath, 'utf8');
  const coursesJson = JSON.parse(coursesData);
  courses = coursesJson.courses;
} catch (error) {
  console.error('Error reading courses.json:', error);
}

// In-memory store for ongoing meetings
const ongoingMeetings = {};

// Helper functions
function parseISOTime(timeStr) {
  return moment.tz(timeStr, 'YYYY-MM-DDTHH:mm:ssZ', 'UTC').tz('Europe/London');
}

function parseTime(timeStr) {
  return moment.tz(timeStr, 'HH:mm', 'Europe/London');
}

function getWeekdayName(dateObj) {
  return dateObj.format('dddd');
}

function computeTotalMinutes(startTime, endTime) {
  return endTime.diff(startTime, 'minutes');
}

function getScheduledDateTime(actualStartTime, scheduledWeekDay, scheduledTime) {
  const weekDayNumbers = {
    Sunday: 0,
    Monday: 1,
    Tuesday: 2,
    Wednesday: 3,
    Thursday: 4,
    Friday: 5,
    Saturday: 6,
  };

  const scheduledWeekDayNum = weekDayNumbers[scheduledWeekDay];

  const actualStartMoment = parseISOTime(actualStartTime);
  const weekStart = actualStartMoment.clone().startOf('week');

  let scheduledDateTime = weekStart
    .clone()
    .add(scheduledWeekDayNum, 'days')
    .set({
      hour: parseInt(scheduledTime.split(':')[0], 10),
      minute: parseInt(scheduledTime.split(':')[1], 10),
      second: 0,
      millisecond: 0,
    });

  // Adjust scheduledDateTime if it's not in the same week as the actual start time
  if (scheduledDateTime.isAfter(actualStartMoment.clone().add(3, 'days'))) {
    scheduledDateTime.subtract(7, 'days');
  } else if (scheduledDateTime.isBefore(actualStartMoment.clone().subtract(3, 'days'))) {
    scheduledDateTime.add(7, 'days');
  }

  return scheduledDateTime;
}

// Configure nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Endpoint for Zoom webhook events
app.post('/webhook', (req, res) => {
  const event = req.body.event;
  const payload = req.body.payload;

  // Handle Zoom endpoint validation
  if (event === 'endpoint.url_validation') {
    const plainToken = payload.plainToken;
    const encryptedToken = crypto
      .createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(plainToken)
      .digest('hex');

    res.status(200).json({
      plainToken,
      encryptedToken,
    });
    return;
  }

  // Verify the request signature
  const timestamp = req.headers['x-zm-request-timestamp'];
  const message = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const hashForVerify = crypto
    .createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
    .update(message)
    .digest('hex');
  const signature = `v0=${hashForVerify}`;

  if (req.headers['x-zm-signature'] !== signature) {
    res.status(401).send('Unauthorized request');
    return;
  }

  // Handle meeting.started event
  if (event === 'meeting.started') {
    const meetingId = payload.object.id;
    const topic = payload.object.topic;
    const startTime = payload.object.start_time;
    const hostEmail = payload.object.host_email;

    // Store the start time, topic, and host email of the meeting
    ongoingMeetings[meetingId] = {
      topic,
      startTime,
      hostEmail,
    };

    console.log(`Meeting started: ID ${meetingId}, Topic: ${topic}`);
  }
  // Handle meeting.ended event
  else if (event === 'meeting.ended') {
    const meetingId = payload.object.id;
    const endTime = payload.object.end_time;

    if (ongoingMeetings[meetingId]) {
      const { topic, startTime, hostEmail } = ongoingMeetings[meetingId];

      // Calculate total time in minutes
      const enteredTimeDt = parseISOTime(startTime);
      const finishedTimeDt = parseISOTime(endTime);
      const totalTime = computeTotalMinutes(enteredTimeDt, finishedTimeDt);

      // Match meeting with course
      const course = courses.find((c) => c.course_name === topic);

      if (!course) {
        console.error(`No course found for course_name: ${topic}`);
        delete ongoingMeetings[meetingId];
        return res.status(200).json({ message: 'No matching course found.' });
      }

      const teacherName = course.teacher_name;
      const scheduledWeekDay = course.scheduled_week_day;
      const scheduledTime = course.scheduled_time;
      const ratePound = course.rate_pound;

      const attendedWeekDay = getWeekdayName(enteredTimeDt);
      const date = enteredTimeDt.format('YYYY-MM-DD');
      const enteredTime = enteredTimeDt.format('HH:mm');
      const finishedTime = finishedTimeDt.format('HH:mm');

      const rateFormula = ratePound / 40;
      const calculatedPayment = rateFormula * totalTime;
      const approvedPayment = Math.min(calculatedPayment, ratePound);

      // Determine status
      const scheduledDateTime = getScheduledDateTime(startTime, scheduledWeekDay, scheduledTime);
      const threeMinutesBefore = scheduledDateTime.clone().subtract(3, 'minutes');

      let status = 'Not attended';
      if (enteredTimeDt.isSameOrBefore(threeMinutesBefore)) {
        status = 'Attended';
      } else {
        // Send email to IT if host didn't start the course 3 minutes before scheduled time
        sendEmailToIT({
          subject: `Host Late Start Alert - ${topic}`,
          text: `The host (${hostEmail}) did not start the course "${topic}" 3 minutes before the scheduled time.`,
        });
      }

      // Prepare attendance record
      const attendanceRecord = {
        teacher_name: teacherName,
        email: hostEmail,
        course_name: topic,
        meeting_id: meetingId,
        scheduled_week_day: scheduledWeekDay,
        attended_week_day: attendedWeekDay,
        date,
        scheduled_time: scheduledTime,
        entered_time: enteredTime,
        finished_time: finishedTime,
        total_time: totalTime,
        rate_pound: ratePound,
        rate_formula: rateFormula.toFixed(2),
        calculated_payment: calculatedPayment.toFixed(2),
        approved_payment: approvedPayment.toFixed(2),
        status,
      };

      // Save to CSV file specific to the host's email and month
      saveAttendanceRecord(attendanceRecord, hostEmail);

      // Remove the meeting from ongoing meetings
      delete ongoingMeetings[meetingId];
    } else {
      console.error(`No ongoing meeting found for ID: ${meetingId}`);
    }
  } else {
    console.log(`Unhandled event type: ${event}`);
  }

  res.status(200).json({ message: 'Event processed.' });
});

// Function to save attendance record to CSV file
function saveAttendanceRecord(record, hostEmail) {
  const monthYear = moment(record.date).format('MMMM YYYY');
  const sanitizedEmail = hostEmail.replace(/[/\\?%*:|"<>]/g, '-'); // Replace illegal filename characters
  const csvFilePath = `${sanitizedEmail} - ${monthYear}.csv`;

  // Check if the CSV file exists, if not, write headers
  if (!fs.existsSync(csvFilePath)) {
    const csvWriter = createObjectCsvWriter({
      path: csvFilePath,
      header: [
        { id: 'teacher_name', title: 'Teacher Name' },
        { id: 'email', title: 'Email' },
        { id: 'course_name', title: 'Course Name' },
        { id: 'meeting_id', title: 'Meeting ID' },
        { id: 'scheduled_week_day', title: 'Scheduled Week Day' },
        { id: 'attended_week_day', title: 'Attended Week Day' },
        { id: 'date', title: 'Date' },
        { id: 'scheduled_time', title: 'Scheduled Time' },
        { id: 'entered_time', title: 'Entered Time' },
        { id: 'finished_time', title: 'Finished Time' },
        { id: 'total_time', title: 'Total Time (minutes)' },
        { id: 'rate_pound', title: 'Rate (£)' },
        { id: 'rate_formula', title: 'Rate Formula' },
        { id: 'calculated_payment', title: 'Calculated Payment (£)' },
        { id: 'approved_payment', title: 'Approved Payment (£)' },
        { id: 'status', title: 'Status' },
      ],
    });

    csvWriter
      .writeRecords([record])
      .then(() => console.log(`Attendance record saved to new CSV file: ${csvFilePath}`))
      .catch((err) => console.error('Error writing to CSV:', err));
  } else {
    // Append to existing CSV file
    const csvWriter = createObjectCsvWriter({
      path: csvFilePath,
      header: [
        { id: 'teacher_name', title: 'Teacher Name' },
        { id: 'email', title: 'Email' },
        // ... other headers
      ],
      append: true,
    });

    csvWriter
      .writeRecords([record])
      .then(() => console.log(`Attendance record appended to CSV file: ${csvFilePath}`))
      .catch((err) => console.error('Error writing to CSV:', err));
  }
}

// Function to send email to IT
function sendEmailToIT({ subject, text }) {
  const mailOptions = {
    from: process.env.SMTP_USER,
    to: process.env.IT_EMAIL,
    subject,
    text,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return console.error('Error sending email:', error);
    }
    console.log('Email sent:', info.response);
  });
}

// Schedule a task to run on the last day of each month at 23:00
nodeCron.schedule('0 23 L * *', () => {
  console.log('Monthly email job running...');

  // Get all CSV files for the current month
  const currentMonth = moment().format('MMMM YYYY');
  fs.readdir('.', (err, files) => {
    if (err) {
      return console.error('Error reading directory:', err);
    }

    const csvFiles = files.filter(
      (file) =>
        file.endsWith('.csv') && file.includes(` - ${currentMonth}.csv`)
    );

    if (csvFiles.length === 0) {
      console.log('No CSV files to send for this month.');
      return;
    }

    // Attach all CSV files and send email to IT
    const attachments = csvFiles.map((filename) => ({
      filename,
      path: `./${filename}`,
    }));

    const mailOptions = {
      from: process.env.SMTP_USER,
      to: process.env.IT_EMAIL,
      subject: `Monthly Attendance Reports - ${currentMonth}`,
      text: `Please find attached the attendance reports for ${currentMonth}.`,
      attachments,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        return console.error('Error sending monthly email:', error);
      }
      console.log('Monthly email sent:', info.response);
    });
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
