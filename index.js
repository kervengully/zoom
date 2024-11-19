// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const fs = require('fs');
const moment = require('moment-timezone');
const crypto = require('crypto');
const nodeCron = require('node-cron');
const nodemailer = require('nodemailer');
const { createObjectCsvWriter } = require('csv-writer');
const path = require('path');

const app = express();
const port = process.env.PORT || 3600;

app.use(express.json());

// Paths
const coursesJsonPath = 'courses.json';
const reportsDir = path.join(__dirname, 'Reports');

// Ensure the Reports directory exists
if (!fs.existsSync(reportsDir)) {
  fs.mkdirSync(reportsDir);
}

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

function getScheduledDateTime(date, scheduledTime) {
  return moment.tz(`${date} ${scheduledTime}`, 'YYYY-MM-DD HH:mm', 'Europe/London');
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
    const hostEmail = payload.object.host_email || null; // Handle undefined host_email

    // Store the start time, topic, and host email of the meeting
    ongoingMeetings[meetingId] = {
      topic,
      startTime,
      hostEmail, // May be null
    };

    console.log(`Meeting started: ID ${meetingId}, Topic: ${topic}`);
  }
  // Handle meeting.ended event
  else if (event === 'meeting.ended') {
    const meetingId = payload.object.id;
    const endTime = payload.object.end_time;

    if (ongoingMeetings[meetingId]) {
      const { topic, startTime, hostEmail } = ongoingMeetings[meetingId];

      // Match meeting with course
      const course = courses.find((c) => c.course_name === topic);

      if (!course) {
        console.error(`No course found for course_name: ${topic}`);
        delete ongoingMeetings[meetingId];
        return res.status(200).json({ message: 'No matching course found.' });
      }

      const teacherName = course.teacher_name;

      // Use teacherName if hostEmail is undefined
      const email = hostEmail || teacherName;

      // Meeting times and calculations
      const enteredTimeDt = parseISOTime(startTime);
      const finishedTimeDt = parseISOTime(endTime);
      const totalTime = computeTotalMinutes(enteredTimeDt, finishedTimeDt);

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
      const scheduledDateTime = getScheduledDateTime(date, scheduledTime);
      const threeMinutesBefore = scheduledDateTime.clone().subtract(3, 'minutes');

      let status = 'Not attended';
      if (enteredTimeDt.isSameOrBefore(threeMinutesBefore)) {
        status = 'Attended';
      } else {
        // Send email to IT if host didn't start the course 3 minutes before scheduled time
        sendEmailToIT({
          subject: `Host Late Start Alert - ${topic}`,
          text: `The host (${email}) did not start the course "${topic}" 3 minutes before the scheduled time.`,
        });
      }

      // Prepare attendance record
      const attendanceRecord = {
        teacher_name: teacherName,
        email: email, // Use email variable
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

      // Save to CSV file specific to the host's email (or teacher name) and month
      saveAttendanceRecord(attendanceRecord, email);

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
function saveAttendanceRecord(record, email) {
  const monthYear = moment(record.date).format('MMMM YYYY');
  const sanitizedEmail = email.replace(/[/\\?%*:|"<>]/g, '-'); // Replace illegal filename characters
  const csvFilePath = path.join(reportsDir, `${sanitizedEmail} - ${monthYear}.csv`);

  // Define CSV headers
  const csvHeaders = [
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
  ];

  // Check if the CSV file exists
  const fileExists = fs.existsSync(csvFilePath);

  // Create CSV writer
  const csvWriter = createObjectCsvWriter({
    path: csvFilePath,
    header: csvHeaders,
    append: fileExists, // Append if file exists, otherwise write headers
  });

  csvWriter
    .writeRecords([record])
    .then(() => {
      if (fileExists) {
        console.log(`Attendance record appended to CSV file: ${csvFilePath}`);
      } else {
        console.log(`Attendance record saved to new CSV file: ${csvFilePath}`);
      }
    })
    .catch((err) => console.error('Error writing to CSV:', err));
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

// Schedule a task to run every day at 23:00
nodeCron.schedule('0 23 * * *', () => {
  console.log('Daily check for last day of the month at 23:00...');

  // Get the current date in London time
  const today = moment().tz('Europe/London');
  const tomorrow = today.clone().add(1, 'day');

  // Check if today is the last day of the month
  if (today.month() !== tomorrow.month()) {
    console.log('Today is the last day of the month. Running monthly email job...');

    // Get all CSV files for the current month
    const currentMonth = today.format('MMMM YYYY');

    fs.readdir(reportsDir, (err, files) => {
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
        path: path.join(reportsDir, filename),
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
  } else {
    console.log('Today is not the last day of the month. No action taken.');
  }
});

// Function to schedule checks for today's courses
function scheduleCourseChecks() {
  const today = moment().tz('Europe/London').format('dddd');
  const currentDate = moment().tz('Europe/London').format('YYYY-MM-DD');

  courses.forEach((course) => {
    if (course.scheduled_week_day === today) {
      const scheduledTime = course.scheduled_time;
      const scheduledDateTime = getScheduledDateTime(currentDate, scheduledTime);
      const checkTime = scheduledDateTime.clone().subtract(3, 'minutes');

      // Only schedule if the time is in the future
      if (checkTime.isAfter(moment().tz('Europe/London'))) {
        const cronExpression = `${checkTime.minute()} ${checkTime.hour()} ${checkTime.date()} ${checkTime.month() + 1} *`;

        nodeCron.schedule(cronExpression, () => {
          console.log(`Checking if course "${course.course_name}" has been started by the host.`);

          // Check if the meeting has been started
          const meetingStarted = Object.values(ongoingMeetings).some(
            (meeting) => meeting.topic === course.course_name
          );

          if (!meetingStarted) {
            // Send email to IT if host hasn't started the course
            const email = course.teacher_name; // Using teacher_name as email if host email is not available
            sendEmailToIT({
              subject: `Host Did Not Start Course - ${course.course_name}`,
              text: `The host (${email}) did not start the course "${course.course_name}" 3 minutes before the scheduled time.`,
            });
          }
        });
      }
    }
  });
}

// Schedule the course checks every day at 00:05 AM to set up checks for the day
nodeCron.schedule('5 0 * * *', () => {
  console.log('Scheduling course checks for today...');
  scheduleCourseChecks();
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
  // Schedule today's course checks when the server starts
  scheduleCourseChecks();
});
